# Roamora

An autonomous travel planner: give it a destination and dates, and it researches real places, real opening hours, real ticket prices, real restaurants, and real transit — then builds a day-by-day itinerary itself. No manual place entry required. It also does hiking-trail lookup and one-off place saving from TikTok/Instagram links or Google Takeout exports, but the autonomous planner is the core product.

## Features

- **Autonomous trip planning** — tell it a destination and dates; it discovers attractions via OpenStreetMap, verifies opening hours and ticket prices against official sources, picks a restaurant, finds hidden gems, checks the weather, and builds a real walking/transit route — all server-side, nothing fabricated when real data can't be found
- **A/B/C planning** — for a single day, generate three genuinely different itineraries (max experience / balanced / relaxed) and pick one
- **Multi-day trips** — up to `MAX_TRIP_DAYS` (14) days, planned sequentially
- **Explore** — browse real OSM/Wikivoyage points of interest by city before committing to a plan
- **Hiking trails** — European Wanderwege via the Waymarked Trails API
- **Import** — paste a TikTok/Instagram link (place extraction via `yt-dlp` + Ollama) or import saved places from a Google Takeout export

## Quick start (local)

```bash
npm install
cp .env.example .env          # then fill in at least DATABASE_URL (default is fine) and AI_PROVIDER
npm run db:generate           # generates the Prisma client — required before first run
npm run db:push               # creates the SQLite schema at DATABASE_URL
docker compose up -d          # starts SearXNG + Ollama + OTP (see infra/README.md)
docker compose exec ollama ollama pull llama3.1:8b   # one-time, ~4.9GB
npm run dev
```

## Requirements

- Node.js **20.9+** (Next.js 16's own minimum)
- Docker (for SearXNG/Ollama/OpenTripPlanner — see `infra/README.md`) — optional but required for AI-driven research, opening-hours/price verification, and transit routing; the app degrades gracefully without them
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — optional, only for the TikTok/Instagram import feature

---

## Deployment

### Required environment variables

See `.env.example` for the full, documented list with real defaults. The ones that matter for a real deployment:

| Variable | Required? | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | SQLite file path, e.g. `file:/data/roamora.db` — must be a **persistent, writable** path |
| `AUTH_SECRET`, `ROAMORA_PASSWORD_HASH` | Strongly recommended once exposed beyond localhost | Leaving both empty runs the instance **open, no login** — fine for a first local run, not for anything network-reachable. Generate with `npm run auth:hash -- "your password"` |
| `AI_PROVIDER` | Yes | `ollama` (real AI research) or `none` (features show an explicit "not configured" state instead of degrading silently) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Yes, if `AI_PROVIDER=ollama` | Must point to wherever Ollama actually runs — **not necessarily `localhost`** if Ollama is on a different host/container |
| `SEARXNG_URL` | Optional | Absence = autoplan runs on OSM data alone, lower confidence, never fails |
| `OTP_URL` | Optional | Absence = itineraries use walking only, transit legs never estimated |
| `OVERPASS_URL`, `NOMINATIM_BASE_URL`, `OSRM_*_URL` | Have working public defaults | Public, external, keyless services — no self-hosting required, but rate-limited under sustained load (see Common failure modes) |

None of these are ever put in this documentation — only variable *names*.

### Required services

- **The Next.js app itself** — `npm run build && npm start`, or any Node 20.9+ host. No app-level Dockerfile exists; it's a plain Node process, not currently containerized.
- **SearXNG, Ollama, OpenTripPlanner** — `docker-compose.yml` at the repo root (see `infra/README.md` for full detail, GPU setup, and OTP graph provisioning). All three are optional individually — the app reports each as a named capability gap rather than failing outright when one is missing.
- **External, always-required (no self-hosting needed or built)**: Overpass API, Nominatim, OSRM's public routing instances, Open-Meteo, Wikipedia/Wikivoyage — the app needs outbound internet access to reach these regardless of deployment target.

### Required ports (defaults; all configurable)

| Port | Service |
|---|---|
| 3000 | Next.js app (`next start`) |
| 8081 | SearXNG (mapped from its internal 8080) |
| 11434 | Ollama |
| 8080 | OpenTripPlanner |

### Database setup

Roamora uses **SQLite** via Prisma 7's driver-adapter pattern (`@prisma/adapter-better-sqlite3`), not PostgreSQL. It's a single file — pick a persistent, writable path for `DATABASE_URL` and back that file up (see Backup considerations).

```bash
npm run db:generate     # generates the Prisma client — needed after every `npm install` and after any schema.prisma change
npm run db:push         # applies the current schema.prisma to DATABASE_URL directly
```

**Migration note**: `prisma/migrations/` contains one migration (`20260813195523_init`) that predates most of the current schema — this project's actual, tested workflow has been `prisma db push` throughout development, not versioned migrations. For a fresh production database, use `npm run db:push` (matches how every environment so far has actually been set up); `prisma migrate deploy` would only apply the stale `init` migration and leave the schema incomplete. Regenerating a proper migration history is a reasonable follow-up, not a blocker for this release.

### Ollama model setup

```bash
docker compose exec ollama ollama pull llama3.1:8b
```

One-time, ~4.9GB. Not automated by `docker compose up` deliberately — baking it into the image would force a re-download on every image rebuild.

### GPU requirement

Not strictly required, but real: without an NVIDIA GPU, Ollama silently falls back to CPU inference — live-measured, a trivial extraction went from <300ms (GPU) to 13–70s (CPU). `docker-compose.yml`'s `ollama` service requests a GPU via the standard Compose `deploy.resources.reservations` block, which requires the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. **On a host with no NVIDIA GPU (most cloud VPS instances), `docker compose up` will fail outright for the `ollama` service** — remove that `deploy` block to run CPU-only (works, just much slower per LLM call, which matters most for the multiple synchronous Ollama calls inside a single autoplan request).

### OTP graph requirement

Transit routing needs a destination-specific graph built from a real OSM extract + GTFS feed — genuine infrastructure, not something `docker compose up` builds generically. See `infra/README.md`'s "OpenTripPlanner" section for the full provisioning workflow (`npm run transit:provision -- "City, Country"` then `docker compose run --rm otp --build --save /graph`). Without a graph, OTP starts but has nothing to serve; the app degrades to walking-only routing, not an error.

### Persistent volume requirements

| What | How it persists | What's lost without it |
|---|---|---|
| SQLite database (`DATABASE_URL`) | Whatever filesystem path you point it at | Every trip, place, and cached research result |
| Ollama's pulled models | Named volume `ollama_data` | Re-pull ~4.9GB after every container recreate |
| OTP's built graph | Bind mount `./infra/otp/graph_dir` (a real host directory, not a Docker volume) | Re-run the multi-minute graph build |
| SearXNG's config | Bind-mounted read-only from `./infra/searxng/settings.yml` | No user data at risk — config lives in the repo |
| Provider research cache (opening hours, prices, official-source resolution) | Lives in the SQLite database itself, not a separate volume | Falls back to re-fetching from live sources — slower, not broken |

### Startup order

1. `docker compose up -d` (SearXNG, Ollama, OTP) — the app tolerates any of these being down or still starting; it just reports a capability gap
2. `npm run db:generate && npm run db:push` (once, or after a schema change)
3. `npm run build && npm start` (or `npm run dev` for local iteration)

No strict ordering is enforced by the app itself — it probes each service's real availability per-request rather than assuming a fixed boot sequence.

### Health checks

```bash
docker compose ps                              # all three should show "healthy"
curl http://localhost:8081/search?q=health&format=json    # SearXNG
curl http://localhost:11434/api/tags                        # Ollama
curl http://localhost:8080/otp                               # OTP
curl http://localhost:3000/api/auth/status                  # the app itself; also reports whether login is configured
```

### Restart procedure

```bash
docker compose down    # stops and removes all 3 containers + the network — volumes and the OTP graph bind mount are untouched
docker compose up -d   # recreates everything; live-verified this cycle in ~50s with an existing graph, models, and config all intact
```

The Next.js process itself: restart via whatever process manager runs it (`pm2`, systemd, a container orchestrator) — it has no persistent in-memory state that a restart would lose.

### Backup considerations

- **The SQLite file at `DATABASE_URL` is the only thing that truly matters** — every trip, imported place, and research cache entry lives there. Back it up like any single-file database (stop the app or use SQLite's own backup API to avoid a mid-write copy).
- Ollama's models and the OTP graph are both *regeneratable* (re-pull, re-build) — worth keeping for convenience, not worth treating as critical backups.
- `.env` itself (never committed) — keep a copy of your real secrets somewhere safe; `.env.example` only documents variable names.

### Common failure modes

- **"No places found around `<destination>`" that clearly has places**: was previously a real bug (fixed this release) where an Overpass timeout/rate-limit was reported as if the destination itself had no data. Now reported honestly as a retry-worthy service hiccup. The public Overpass instance genuinely does rate-limit/504 under sustained load — this is external, not something this app's code can fully prevent, only report honestly.
- **Ollama calls taking 10s+ each**: almost always the CPU-fallback case (see GPU requirement above) — check `docker compose logs ollama` for `inference compute id=cpu` vs `library=CUDA`.
- **A fresh SearXNG container returns empty search results**: its JSON API is off by default and must be explicitly enabled (see `infra/README.md`).
- **`prisma migrate deploy` produces an incomplete schema**: use `prisma db push` instead (see Database setup above).
- **The app runs with no login prompt at all**: `AUTH_SECRET`/`ROAMORA_PASSWORD_HASH` are unset — intentional for a first local run, confirm via `GET /api/auth/status` before exposing the instance to a network.

### Minimum hardware expectations

- **App process**: negligible — a small VM/container is plenty (it's a request-driven Next.js app, no heavy in-process computation).
- **Ollama**: a GPU with **≥6-8GB VRAM** for comfortable `llama3.1:8b` inference (live-tested on an 8GB card); CPU-only works but each call is 40-200x slower.
- **OpenTripPlanner**: the documented graph-build step uses `-Xmx4G` — budget at least that much RAM during a graph build (not needed once a graph is already built and just being loaded).
- **Disk**: a few GB for Ollama's model, 100s of MB to low GBs per OTP city graph (varies by city size), plus the SQLite database (grows with trips/cache — not large for personal use).

---

## Architecture note

This project is a plain Next.js application (no app-level Dockerfile) backed by SQLite, plus three optional self-hosted sidecar services (SearXNG, Ollama, OpenTripPlanner) defined in `docker-compose.yml`. Every external service the app talks to — including Ollama, SearXNG, and OTP — is a configurable URL (`OLLAMA_BASE_URL`, `SEARXNG_URL`, `OTP_URL`), so the app process and the sidecar services do not need to run on the same machine. The one real architectural constraint is SQLite itself: it needs a persistent, writable filesystem path co-located with (or reliably mounted to) whichever process runs the app — this rules out platforms with an ephemeral/read-only filesystem (typical serverless/edge runtimes) without further work.
