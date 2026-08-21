# Roamora self-hosted infrastructure

Real, self-hostable services the autonomous pipeline uses — no Google
dependency, no paid API keys. Everything here was actually run, tested, and
had real bugs found and fixed against it (see `ROAMORA_ROADMAP.md` and
`docker-compose.yml`'s comments for specifics).

## What you get

| Service | Port | Purpose | Persisted across restarts? |
|---|---|---|---|
| SearXNG | 8081 | Web research (opening hours/prices not on OSM) | Config yes (bind-mounted); no user data to lose |
| Ollama | 11434 | LLM fact extraction from fetched pages | Yes — pulled models live in the `ollama_data` volume |
| OpenTripPlanner | 8080 | Transit routing | **Graph is not built by compose** — see below |

## Quick start

```bash
docker compose up -d searxng ollama
docker compose exec ollama ollama pull llama3.1:8b   # one-time, ~4.9GB
```

Then in `.env`:
```
SEARXNG_URL=http://localhost:8081
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
AI_PROVIDER=ollama
```

## OpenTripPlanner — real, one-time, per-destination setup

Transit routing needs a graph built from a real OSM extract and a real GTFS
feed for the specific destination — this is genuine infrastructure, not
something `docker compose up` can do generically for "any city".

1. Download an OSM extract covering the destination (e.g. from
   [Geofabrik](https://download.geofabrik.de/)) and the destination transit
   agency's real GTFS feed (a `.zip`).
2. Put both files in `infra/otp/graph_dir/`.
3. Build the graph once:
   ```bash
   docker compose run --rm otp --build --save /graph
   ```
   This can take from under a minute (a small city) to several minutes (a
   large one, big GTFS feed) — it's real work, not a network call.
4. Start the service normally:
   ```bash
   docker compose up -d otp
   ```
5. In `.env`: `OTP_URL=http://localhost:8080`

Re-run step 3 whenever the GTFS feed goes stale (transit agencies publish new
feeds regularly — a schedule from months ago will produce wrong trip times).

## Checking status

```bash
docker compose ps
```

A healthy stack shows all three as `healthy`. The app's own capability
probes (`src/server/services/capabilities.ts`) go further than "container
exists" — they distinguish **not-configured** (URL unset), **unavailable**
(nothing listening), **starting** (something answered the TCP handshake but
timed out — OpenTripPlanner's real shape while its graph is still loading,
since its JVM process comes up long before its HTTP server does), **unhealthy**
(reachable but broken — e.g. Ollama running without the configured model
pulled), and **available**.

## Known limitations, stated honestly

- Ollama's model pull is a manual one-time step, not automated by compose —
  baking a ~4.9GB model into the image would force a re-download on every
  image rebuild, so a named volume plus a documented manual pull is the
  actual tradeoff, not an oversight.
- OTP's graph-build step requires internet access at build time and is not
  automated per-destination — genuinely something that needs deciding (which
  OSM extract, which GTFS feed) for each place, not a value compose can fill
  in.
- SearXNG's multiple engines reduce but do not eliminate the real risk of a
  search engine CAPTCHA-blocking this container's IP under sustained
  automated query volume (this happened once already during development,
  see `docker-compose.yml`'s SearXNG comments) — there is no complete fix for
  this short of running fewer automated queries or rotating egress IPs.
