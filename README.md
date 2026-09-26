# Nuvio TMDB Release Dates — Stream Edition v3.0.0

This addon displays TMDB theatrical and digital release dates as a **stream entry** in Nuvio/Stremio's Play/Streams section.

## What changed in v3

- Adds a `/` homepage so Render does not show `Cannot GET /`.
- Adds `/health`.
- Uses TMDB's IMDb lookup endpoint.
- Uses TMDB `/movie/{tmdb_id}/release_dates`.
- Explicitly extracts release type 3 = Theatrical and type 4 = Digital.
- Prefers `DEFAULT_REGION`, then US, then GB, then any available region.
- If a date is unavailable, it displays `Not available` instead of returning no stream.
- Errors are returned as a visible stream entry and logged by Render.
- Uses a TMDB bearer token or V3 API key.
- Includes simple caching and request coalescing.

## Render

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Environment variables:
```text
TMDB_API_TOKEN=your_tmdb_read_access_token
DEFAULT_REGION=IN
CACHE_TTL_MS=21600000
```

Do not set `PORT` on Render.

## Test URLs

Homepage:
```text
https://YOUR-APP.onrender.com/
```

Health:
```text
https://YOUR-APP.onrender.com/health
```

Manifest:
```text
https://YOUR-APP.onrender.com/manifest.json
```

Movie stream:
```text
https://YOUR-APP.onrender.com/stream/movie/tt0133093.json
```

Install this URL in Nuvio:
```text
https://YOUR-APP.onrender.com/manifest.json
```

## Expected stream response

```json
{
  "streams": [
    {
      "name": "TMDB Release Dates",
      "title": "🎬 Theatrical: 15 May 2026 (IN)\n💻 Digital: 29 May 2026 (IN)"
    }
  ]
}
```

The exact dates depend on TMDB data for the movie and selected region.
