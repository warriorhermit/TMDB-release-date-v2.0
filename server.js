const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 7000);
const TMDB_TOKEN = process.env.TMDB_API_TOKEN || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const DEFAULT_REGION = (process.env.DEFAULT_REGION || "IN").toUpperCase();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 21600000);
const NEGATIVE_CACHE_TTL_MS = 60000;
const cache = new Map();
const activeRequests = new Map();

const manifest = {
  id: "com.nuvio.tmdb.release-dates.stream",
  version: "2.0.0",
  name: "TMDB Release Dates",
  description: "Shows TMDB theatrical and digital release dates directly in the Nuvio/Stremio Play/Streams section.",
  resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  types: ["movie"],
  idPrefixes: ["tt"],
  catalogs: []
};

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  const ttl = item.negative ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - item.time > ttl) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, negative = false) {
  cache.set(key, { value, negative, time: Date.now() });
  return value;
}

async function tmdb(path, params = {}) {
  if (!TMDB_TOKEN && !TMDB_API_KEY) {
    throw new Error("TMDB API credentials are not configured");
  }

  const url = new URL("https://api.themoviedb.org/3" + path);
  if (TMDB_API_KEY) url.searchParams.set("api_key", TMDB_API_KEY);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { accept: "application/json" };
  if (TMDB_TOKEN) headers.Authorization = `Bearer ${TMDB_TOKEN}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function findMovieByImdb(imdbId) {
  const key = `find:${imdbId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const data = await tmdb(`/find/${encodeURIComponent(imdbId)}`, {
    external_source: "imdb_id"
  });
  const movie = data.movie_results?.[0] || null;
  return cacheSet(key, movie, !movie);
}

async function getReleaseDates(tmdbId) {
  const key = `release:${tmdbId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  return cacheSet(key, await tmdb(`/movie/${tmdbId}/release_dates`));
}

function formatDate(date) {
  if (!date) return null;
  const [year, month, day] = date.substring(0, 10).split("-");
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(+year, +month - 1, +day)));
}

function firstRelease(country, type) {
  return (country.release_dates || [])
    .filter(x => Number(x.type) === type && x.release_date)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))[0] || null;
}

function selectRegion(results) {
  const preferred = [
    DEFAULT_REGION,
    "US",
    "GB",
    ...results.map(x => x.iso_3166_1)
  ];

  for (const code of [...new Set(preferred)]) {
    const country = results.find(x => x.iso_3166_1 === code);
    if (!country) continue;

    const theatrical = firstRelease(country, 3);
    const digital = firstRelease(country, 4);

    if (theatrical || digital) {
      return { region: code, theatrical, digital };
    }
  }

  return { region: DEFAULT_REGION, theatrical: null, digital: null };
}

async function resolveReleaseDates(imdbId) {
  const movie = await findMovieByImdb(imdbId);
  if (!movie) return null;

  const data = await getReleaseDates(movie.id);
  const selected = selectRegion(data.results || []);

  return {
    movie,
    region: selected.region,
    theatrical: selected.theatrical
      ? formatDate(selected.theatrical.release_date) : null,
    digital: selected.digital
      ? formatDate(selected.digital.release_date) : null
  };
}

function makeStream(data) {
  const parts = [];
  if (data.theatrical) parts.push(`🎬 Theatrical: ${data.theatrical}`);
  if (data.digital) parts.push(`💻 Digital: ${data.digital}`);
  if (!parts.length) return null;

  const tmdbUrl = `https://www.themoviedb.org/movie/${data.movie.id}`;

  return {
    name: "TMDB Release Dates",
    title: parts.join("  •  "),
    url: tmdbUrl,
    externalUrl: tmdbUrl,
    description: `TMDB release dates • Region: ${data.region}`,
    behaviorHints: { bingeGroup: "tmdb-release-dates" }
  };
}

async function handleStream(req, res) {
  const { type, id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=21600, stale-while-revalidate=3600");

  if (type !== "movie" || !/^tt\d+$/.test(id || "")) {
    return res.json({ streams: [] });
  }

  const cacheKey = `stream:${DEFAULT_REGION}:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return res.json({ streams: cached });

  if (activeRequests.has(cacheKey)) {
    try {
      return res.json({ streams: await activeRequests.get(cacheKey) });
    } catch {
      return res.json({ streams: [] });
    }
  }

  const promise = (async () => {
    try {
      const data = await resolveReleaseDates(id);
      if (!data) {
        cacheSet(cacheKey, [], true);
        return [];
      }

      const stream = makeStream(data);
      const streams = stream ? [stream] : [];
      cacheSet(cacheKey, streams);
      return streams;
    } catch (error) {
      console.error(`[TMDB] ${id}: ${error.message}`);
      cacheSet(cacheKey, [], true);
      return [];
    }
  })();

  activeRequests.set(cacheKey, promise);
  try {
    return res.json({ streams: await promise });
  } finally {
    activeRequests.delete(cacheKey);
  }
}

app.disable("x-powered-by");

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "TMDB Release Dates", version: "2.0.0", region: DEFAULT_REGION });
});

app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/stream/:type/:id.json", handleStream);
app.get("/:config/stream/:type/:id.json", handleStream);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TMDB Release Dates v2.0.0 listening on port ${PORT}`);
  console.log(`Default region: ${DEFAULT_REGION}`);
});
