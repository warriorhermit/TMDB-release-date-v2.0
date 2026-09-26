const express = require("express");

const app = express();
const PORT = process.env.PORT || 7000;
const TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "IN").toUpperCase();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 21600000);

const cache = new Map();
const activeRequests = new Map();

function tmdbHeaders() {
  if (TMDB_API_TOKEN) {
    return {
      Authorization: `Bearer ${TMDB_API_TOKEN}`,
      accept: "application/json"
    };
  }
  return { accept: "application/json" };
}

function tmdbUrl(path) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  if (!TMDB_API_TOKEN && TMDB_API_KEY) url.searchParams.set("api_key", TMDB_API_KEY);
  return url.toString();
}

async function tmdbGet(path) {
  const response = await fetch(tmdbUrl(path), { headers: tmdbHeaders() });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!response.ok) {
    const message = data?.status_message || `TMDB HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function formatDate(dateString) {
  if (!dateString) return null;
  const d = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateString;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"
  }).format(d);
}

function releaseTypeLabel(type) {
  return {
    1: "Premiere",
    2: "Limited Theatrical",
    3: "Theatrical",
    4: "Digital",
    5: "Physical",
    6: "TV"
  }[type] || `Type ${type}`;
}

function pickRelease(entries, type) {
  // Prefer the configured region, then US, then GB, then any region.
  const preferred = [
    DEFAULT_REGION,
    "US",
    "GB"
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const region of preferred) {
    const country = entries.find(x => x.iso_3166_1 === region);
    const match = country?.release_dates?.find(r => r.type === type && r.release_date);
    if (match) return { ...match, region };
  }

  for (const country of entries) {
    const match = country.release_dates?.find(r => r.type === type && r.release_date);
    if (match) return { ...match, region: country.iso_3166_1 };
  }

  return null;
}

function allReleaseDates(entries, type) {
  const result = [];
  for (const country of entries) {
    for (const r of (country.release_dates || [])) {
      if (r.type === type && r.release_date) {
        result.push({
          region: country.iso_3166_1,
          date: r.release_date,
          certification: r.certification || "",
          note: r.note || ""
        });
      }
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

async function getMovieReleaseInfo(imdbId) {
  const cached = cache.get(imdbId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  if (activeRequests.has(imdbId)) return activeRequests.get(imdbId);

  const promise = (async () => {
    if (!/^tt\d+$/i.test(imdbId)) {
      throw new Error("Invalid IMDb movie ID");
    }

    const find = await tmdbGet(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
    const movie = (find.movie_results || [])[0];

    if (!movie?.id) {
      throw new Error(`TMDB movie not found for ${imdbId}`);
    }

    const releases = await tmdbGet(`/movie/${movie.id}/release_dates`);
    const countries = releases.results || [];

    const theatrical = pickRelease(countries, 3);
    const digital = pickRelease(countries, 4);

    const value = {
      imdbId,
      tmdbId: movie.id,
      movieTitle: movie.title || movie.original_title || imdbId,
      theatrical,
      digital,
      theatricalAll: allReleaseDates(countries, 3),
      digitalAll: allReleaseDates(countries, 4)
    };

    cache.set(imdbId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  })();

  activeRequests.set(imdbId, promise);
  try {
    return await promise;
  } finally {
    activeRequests.delete(imdbId);
  }
}

function streamFor(info) {
  const theatricalText = info.theatrical
    ? `${formatDate(info.theatrical.release_date)} (${info.theatrical.region})`
    : "Not available";

  const digitalText = info.digital
    ? `${formatDate(info.digital.release_date)} (${info.digital.region})`
    : "Not available";

  return {
    name: "TMDB Release Dates",
    title: `🎬 Theatrical: ${theatricalText}\n💻 Digital: ${digitalText}`,
    url: `https://www.themoviedb.org/movie/${info.tmdbId}`,
    externalUrl: `https://www.themoviedb.org/movie/${info.tmdbId}`,
    description:
      `TMDB release dates for ${info.movieTitle} • ` +
      `Theatrical: ${theatricalText} • Digital: ${digitalText}`,
    behaviorHints: {
      bingeGroup: "tmdb-release-dates"
    }
  };
}

app.get("/", (_req, res) => {
  res.type("html").send(`
    <html><head><title>TMDB Release Dates Addon</title></head>
    <body style="font-family:Arial,sans-serif;max-width:700px;margin:40px auto">
      <h1>TMDB Release Dates Addon</h1>
      <p>Service is online.</p>
      <p><a href="/manifest.json">Open manifest</a></p>
      <p><a href="/health">Health check</a></p>
    </body></html>
  `);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    tmdbConfigured: Boolean(TMDB_API_TOKEN || TMDB_API_KEY),
    defaultRegion: DEFAULT_REGION
  });
});

app.get("/manifest.json", (_req, res) => {
  res.json({
    id: "com.nuvio.tmdb.release-dates.stream",
    version: "3.0.0",
    name: "TMDB Release Dates",
    description: "Shows TMDB theatrical and digital release dates directly in the Nuvio/Stremio Play/Streams section.",
    resources: [
      {
        name: "stream",
        types: ["movie"],
        idPrefixes: ["tt"]
      }
    ],
    types: ["movie"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: false
    }
  });
});

async function streamHandler(req, res) {
  const type = req.params.type;
  const id = req.params.id;

  if (type !== "movie") {
    return res.json({ streams: [] });
  }

  // Stremio may pass an ID with a suffix. Keep only the IMDb ID.
  const imdbId = String(id).split(":")[0];

  try {
    const info = await getMovieReleaseInfo(imdbId);
    return res.json({ streams: [streamFor(info)] });
  } catch (error) {
    console.error(`[stream] ${imdbId}: ${error.message}`);
    return res.json({
      streams: [{
        name: "TMDB Release Dates",
        title: `⚠️ TMDB release data unavailable`,
        description: error.message,
        externalUrl: "https://www.themoviedb.org/"
      }]
    });
  }
}

app.get("/stream/:type/:id.json", streamHandler);
app.get("/:config/stream/:type/:id.json", streamHandler);
app.get("/:style/:apiKey/stream/:type/:id.json", streamHandler);

app.listen(PORT, () => {
  console.log(`TMDB Release Dates addon listening on port ${PORT}`);
  console.log(`Default region: ${DEFAULT_REGION}`);
  console.log(`TMDB configured: ${Boolean(TMDB_API_TOKEN || TMDB_API_KEY)}`);
});
