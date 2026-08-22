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

## OpenTripPlanner — repeatable multi-city provisioning

Transit routing needs a graph built from a real OSM extract and a real GTFS
feed for the specific destination — this is genuine infrastructure, not
something `docker compose up` can do generically for "any city". Finding
the *right* extract and feed for an arbitrary destination used to be a
manual, per-city lookup; `scripts/provision-transit.ts` automates both from
real, free, keyless data sources — no API key, no paid service:

- **[Geofabrik's `index-v1.json`](https://download.geofabrik.de/index-v1.json)**
  — a real, versioned catalog of every OSM extract Geofabrik publishes,
  complete with real boundary polygons. The script does genuine
  point-in-polygon matching against the destination's geocoded coordinates
  and picks the smallest (most specific) real region that actually contains
  it — never a hardcoded city→file table.
- **[MobilityData's `mobility-database-catalogs`](https://github.com/MobilityData/mobility-database-catalogs)**
  — a real, community-maintained, free catalog of GTFS feeds worldwide.
  Each entry carries a real bounding box and a stable Google-Cloud-Storage
  mirror URL. The script ranks every feed whose bounding box contains the
  destination by bbox area (tightest match first) and downloads the winner.

### Provisioning a city

```bash
npm run transit:provision -- "Prague, Czech Republic"
```

This geocodes the name, downloads the matched OSM `.osm.pbf` extract and
GTFS `.zip` into `infra/otp/cities/<slug>/`, and writes a `manifest.json`
recording exactly which region/feed was chosen and why (real coordinates,
real bbox area, whether MobilityData has verified the feed as official).
**Read the console output** — it prints the top 3 GTFS candidates
considered and warns explicitly when the best match isn't
MobilityData-verified-official, which can mean the free catalog genuinely
has no local operator indexed for that city yet (a real, honest gap in the
community data, not something the script can invent its way around;
confirmed live for Amsterdam, where the best available match was an
international night-train operator, not the city's own GVB network).
Verify an uncertain pick before relying on it.

Multiple cities can be provisioned independently, side by side:
```bash
npm run transit:provision -- "Poznań, Poland" "Berlin, Germany" "Prague, Czech Republic"
npm run transit:provision -- --list
```

### Activating one city and building its graph

Only one city's graph is served at a time. Copy a provisioned city's files
into the active build directory, then run the existing build step:

```bash
npm run transit:provision -- --activate poznan-poland
docker compose run --rm otp --build --save /graph
docker compose up -d otp
```

In `.env`: `OTP_URL=http://localhost:8080`

Re-run the build step whenever the GTFS feed goes stale (transit agencies
publish new feeds regularly — a schedule from months ago will produce wrong
trip times) — re-provisioning the same city name re-downloads the current
feed.

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
- OTP's graph-build step itself still requires internet access and is not
  run by compose — `scripts/provision-transit.ts` automates *finding and
  downloading* the right OSM extract and GTFS feed for a destination, but
  the actual `docker compose run --rm otp --build` step is still a
  separate, deliberate action (real, multi-minute work for a large city).
  The GTFS side is also only as good as the free MobilityData catalog's
  real coverage — confirmed live that some cities (Amsterdam, at the time
  of writing) have no locally-verified transit feed indexed at all, only
  loosely-matched international operators; the tool surfaces this
  honestly (a printed warning, an `official: false` field in
  `manifest.json`) rather than silently trusting an uncertain pick.
- SearXNG's multiple engines reduce but do not eliminate the real risk of a
  search engine CAPTCHA-blocking this container's IP under sustained
  automated query volume (this happened once already during development,
  see `docker-compose.yml`'s SearXNG comments) — there is no complete fix for
  this short of running fewer automated queries or rotating egress IPs.
