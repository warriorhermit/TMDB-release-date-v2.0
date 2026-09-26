const express = require("express");

const app = express();
const PORT = process.env.PORT || 7000;
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "IN").toUpperCase();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 21600000);

const cache = new Map();
const activeRequests = new Map();

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
  // TMDB may return YYYY-MM-DD or an ISO timestamp. We only want the calendar date.
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"
  }).format(dt);
}

function isoDate(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function chooseRelease(countries, type) {
  const preferred = [...new Set([DEFAULT_REGION, "US", "GB"])];
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

async function findMovie(imdbId) {
  const find = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  let movie = (find.movie_results || [])[0];
  if (movie?.id) return movie;

  // Fallback: TMDB's movie search using the known IMDb title is not possible without
  // knowing the title, so return a clear error rather than guessing a wrong movie.
  throw new Error(`TMDB could not map IMDb ID ${imdbId} to a movie`);
}

async function getInfo(imdbId) {
  const cached = cache.get(imdbId);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (activeRequests.has(imdbId)) return activeRequests.get(imdbId);

  const promise = (async () => {
    if (!/^tt\d+$/i.test(imdbId)) throw new Error("Invalid IMDb movie ID");

    const movie = await findMovie(imdbId);
    const releases = await tmdbGet(`/movie/${movie.id}/release_dates`);

    const countries = releases.results || [];
    const theatrical = chooseRelease(countries, 3);
    const digital = chooseRelease(countries, 4);

    const value = {
      imdbId,
      tmdbId: movie.id,
      title: movie.title || movie.original_title || imdbId,
      posterPath: movie.poster_path || null,
      theatrical,
      digital
    };

    cache.set(imdbId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  })();

  activeRequests.set(imdbId, promise);
  try { return await promise; }
  finally { activeRequests.delete(imdbId); }
}

function stream(info) {
  const theatrical = info.theatrical
    ? `${parseDate(info.theatrical.release_date)} (${info.theatrical.region})`
    : "Not announced";

  const digital = info.digital
    ? `${parseDate(info.digital.release_date)} (${info.digital.region})`
    : "Not announced";

  return {
    name: "TMDB Release Dates",
    title: `🎬 Theatrical: ${theatrical}\n💻 Digital: ${digital}`,
    description: `TMDB release dates • ${info.title}`,
    url: `https://www.themoviedb.org/movie/${info.tmdbId}`,
    externalUrl: `https://www.themoviedb.org/movie/${info.tmdbId}`,
    behaviorHints: { bingeGroup: "tmdb-release-dates" }
  };
}

app.get("/", (_req, res) => res.type("html").send(
  "<h1>TMDB Release Dates Addon v3.1</h1><p>Service is online.</p><p><a href='/manifest.json'>Manifest</a> · <a href='/health'>Health</a></p>"
));

app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: "3.1.0",
  tmdbConfigured: Boolean(TMDB_API_TOKEN || TMDB_API_KEY),
  defaultRegion: DEFAULT_REGION
}));

app.get("/manifest.json", (_req, res) => res.json({
  id: "com.nuvio.tmdb.release-dates.stream",
  version: "3.1.0",
  name: "TMDB Release Dates",
  description: "Shows TMDB theatrical and digital release dates in the Nuvio/Stremio Play/Streams section.",
  resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  types: ["movie"],
  idPrefixes: ["tt"],
  catalogs: []
}));

async function handleStream(req, res) {
  if (req.params.type !== "movie") return res.json({ streams: [] });
  const imdbId = String(req.params.id).split(":")[0];

  try {
    const info = await getInfo(imdbId);
    return res.json({ streams: [stream(info)] });
  } catch (e) {
    console.error(`[${imdbId}] ${e.message}`);
    return res.json({
      streams: [{
        name: "TMDB Release Dates",
        title: "⚠️ Release information unavailable",
        description: e.message,
        externalUrl: "https://www.themoviedb.org/"
      }]
    });
  }
}

app.get("/stream/:type/:id.json", handleStream);
app.get("/:config/stream/:type/:id.json", handleStream);
app.get("/:style/:apiKey/stream/:type/:id.json", handleStream);

app.listen(PORT, () => console.log(`TMDB Release Dates v3.1 listening on ${PORT}`));
