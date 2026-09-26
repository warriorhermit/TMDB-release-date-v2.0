# Nuvio TMDB Release Dates — Stream Edition v2.0

This version deliberately uses a **stream resource**, not a metadata resource.
It is modeled on the approach used by Stremio Stinger Pro: the release-date
information is returned inside a normal Stremio `streams` array, so Nuvio can
display it in the Play/Streams section.

Example stream title:

🎬 Theatrical: 15 May 2026  •  💻 Digital: 29 May 2026

The stream is named `TMDB Release Dates`. Selecting it opens the corresponding
TMDB movie page.

TMDB release types:
- 3 = Theatrical
- 4 = Digital

Region order:
1. DEFAULT_REGION (default IN)
2. US
3. GB
4. another TMDB region with release data

Endpoints:
- /manifest.json
- /stream/movie/tt1234567.json
- /health

Install the public /manifest.json URL in Nuvio. No external-metadata setting
is required for this stream-based approach.

Use your own TMDB credentials and comply with TMDB's terms and attribution
requirements.
