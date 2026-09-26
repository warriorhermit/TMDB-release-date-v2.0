# Nuvio TMDB Release Dates v3.1

Stream addon for Nuvio/Stremio.

## Fixes in v3.1
- Correctly strips ISO time from TMDB dates, so `2026-09-18T00:00:00Z` displays as `18 Sep 2026`.
- Handles missing theatrical or digital dates independently.
- Tries IN, then US, then GB, then the earliest available region for each release type.
- Accepts IMDb IDs with Nuvio suffixes by taking the part before `:`.
- Keeps a visible error stream instead of silently returning no result.
- Adds `/`, `/health`, and `/manifest.json`.

## Render
Build: `npm install`
Start: `npm start`

Environment:
`TMDB_API_TOKEN` = TMDB Read Access Token
`DEFAULT_REGION` = `IN`
`CACHE_TTL_MS` = `21600000`

Install manifest:
`https://YOUR-APP.onrender.com/manifest.json`

## Test
Resident Evil (2026):
`https://YOUR-APP.onrender.com/stream/movie/tt35538033.json`

The known mapping is IMDb `tt35538033` -> TMDB `1423191`. The addon itself calls TMDB at runtime, so actual release-date output depends on the current TMDB API response.
