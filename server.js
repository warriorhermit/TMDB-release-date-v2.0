const express = require("express");

const app = express();
const PORT = process.env.PORT || 7000;
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "US").toUpperCase();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 21600000);

const cache = new Map();
const activeRequests = new Map();

// Global CORS Middleware
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function headers() {
  return TMDB_API_TOKEN
    ? { Authorization: `Bearer ${TMDB_API_TOKEN}`, accept: "application/json" }
    : { accept: "application/json" };
}

function tmdbUrl(path) {
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  if (!TMDB_API_TOKEN && TMDB_API_KEY) u.searchParams.set("api_key", TMDB_API_KEY);
  return u.toString();
}

async function tmdbGet(path) {
  const r = await fetch(tmdbUrl(path), { headers: headers() });
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = {}; }
  if (!r.ok) throw new Error(data.status_message || `TMDB HTTP ${r.status}`);
  return data;
}

function parseDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"
  }).format(dt);
}

function isoDate(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function chooseRelease(countries, type) {
  // Region hierarchy prioritized for US first, then GB, then IN
  const preferred = [...new Set([DEFAULT_REGION, "US", "GB", "IN"])];
  for (const region of preferred) {
    const country = countries.find(c => c.iso_3166_1 === region);
    const release = (country?.release_dates || [])
      .filter(x => x.type === type && isoDate(x.release_date))
      .sort((a, b) => isoDate(a.release_date).localeCompare(isoDate(b.release_date)))[0];
    if (release) return { ...release, region };
  }

  const candidates = [];
  for (const country of countries) {
    for (const release of country.release_dates || []) {
      if (release.type === type && isoDate(release.release_date)) {
        candidates.push({ ...release, region: country.iso_3166_1 });
      }
    }
  }
  candidates.sort((a, b) => isoDate(a.release_date).localeCompare(isoDate(b.release_date)));
  return candidates[0] || null;
}

async function findMovieByImdb(imdbId) {
  const find = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  let movie = (find.movie_results || [])[0];
  if (movie?.id) return movie;
  throw new Error(`TMDB could not map IMDb ID ${imdbId} to a movie`);
}

async function resolveMovie(rawId) {
  if (rawId.startsWith("tmdb:")) {
    const tmdbId = rawId.replace("tmdb:", "");
    return await tmdbGet(`/movie/${tmdbId}`);
  }
  if (/^\d+$/.test(rawId)) {
    return await tmdbGet(`/movie/${rawId}`);
  }
  if (/^tt\d+$/i.test(rawId)) {
    return await findMovieByImdb(rawId);
  }
  throw new Error(`Unsupported ID format: ${rawId}`);
}

async function getInfo(rawId) {
  const cached = cache.get(rawId);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (activeRequests.has(rawId)) return activeRequests.get(rawId);

  const promise = (async () => {
    const movie = await resolveMovie(rawId);
    const releases = await tmdbGet(`/movie/${movie.id}/release_dates`);

    const countries = releases.results || [];
    const theatrical = chooseRelease(countries, 3);
    const digital = chooseRelease(countries, 4);

    const value = {
      rawId,
      tmdbId: movie.id,
      title: movie.title || movie.original_title || rawId,
      theatrical,
      digital
    };

    cache.set(rawId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  })();

  activeRequests.set(rawId, promise);
  try { return await promise; }
  finally { activeRequests.delete(rawId); }
}

function stream(info, req) {
  const theatrical = info.theatrical
    ? `${parseDate(info.theatrical.release_date)} (${info.theatrical.region})`
    : "Not announced";

  const digital = info.digital
    ? `${parseDate(info.digital.release_date)} (${info.digital.region})`
    : "Not announced";

  const host = req.get("host") || "localhost";
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const dummyVideoUrl = `${protocol}://${host}/dummy.mp4`;

  return [
    {
      name: `🎬 Theat: ${theatrical}`,
      title: `${info.title}\nTheatrical: ${theatrical}\nDigital: ${digital}`,
      description: `Theatrical: ${theatrical} | Digital: ${digital}`,
      url: dummyVideoUrl,
      externalUrl: `https://www.themoviedb.org/movie/${info.tmdbId}`,
      behaviorHints: { bingeGroup: "tmdb-release-theat" }
    },
    {
      name: `💻 Digital: ${digital}`,
      title: `${info.title}\nDigital: ${digital}\nTheatrical: ${theatrical}`,
      description: `Digital: ${digital} | Theatrical: ${theatrical}`,
      url: dummyVideoUrl,
      externalUrl: `https://www.themoviedb.org/movie/${info.tmdbId}`,
      behaviorHints: { bingeGroup: "tmdb-release-digital" }
    }
  ];
}

// Dummy endpoint to satisfy Nuvio stream checking
app.get("/dummy.mp4", (_req, res) => {
  res.type("video/mp4").status(204).end();
});

app.get("/", (_req, res) => res.type("html").send(
  "<h1>TMDB Release Dates Addon v3.3</h1><p>Service is online.</p><p><a href='/manifest.json'>Manifest</a> · <a href='/health'>Health</a></p>"
));

app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: "3.3.0",
  tmdbConfigured: Boolean(TMDB_API_TOKEN || TMDB_API_KEY),
  defaultRegion: DEFAULT_REGION
}));

app.get("/manifest.json", (_req, res) => res.json({
  id: "com.nuvio.tmdb.release-dates.stream",
  version: "3.3.0",
  name: "TMDB Release Dates",
  description: "Shows TMDB theatrical and digital release dates in Nuvio/Stremio.",
  resources: [
    "stream",
    { name: "stream", types: ["movie"], idPrefixes: ["tt", "tmdb:"] }
  ],
  types: ["movie"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: []
}));

async function handleStream(req, res) {
  if (req.params.type !== "movie") return res.json({ streams: [] });

  let rawId = String(req.params.id);
  if (rawId.startsWith("tmdb:")) {
    rawId = "tmdb:" + rawId.slice(5).split(":")[0];
  } else {
    rawId = rawId.split(":")[0];
  }

  try {
    const info = await getInfo(rawId);
    return res.json({ streams: stream(info, req) });
  } catch (e) {
    console.error(`[${rawId}] ${e.message}`);
    const host = req.get("host") || "localhost";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    return res.json({
      streams: [{
        name: "⚠️ TMDB Release Info",
        title: `Error: ${e.message}`,
        description: e.message,
        url: `${protocol}://${host}/dummy.mp4`,
        externalUrl: "https://www.themoviedb.org/"
      }]
    });
  }
}

app.get("/stream/:type/:id.json", handleStream);
app.get("/:config/stream/:type/:id.json", handleStream);
app.get("/:style/:apiKey/stream/:type/:id.json", handleStream);

app.listen(PORT, () => console.log(`TMDB Release Dates listening on ${PORT}`));
