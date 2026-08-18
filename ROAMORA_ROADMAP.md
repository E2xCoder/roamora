# ROAMORA — Target Architecture & Migration Roadmap

Companion to `ROAMORA_ARCHITECTURE.md` (current state). This document defines what Roamora becomes and how we get there without breaking what works.

---

## 1. Stack decisions

Each decision below is a deliberate choice, with the reasoning recorded so it can be revisited.

### Keep: Next.js 16 App Router
Working, and the API-route + RSC model fits the "one deployment, one process" personal-server target. No reason to migrate.

### Keep: SQLite + Prisma + better-sqlite3
The specification asks for a relational database with geographic indexes and near-zero running cost (§8). For a single user with an expected ceiling in the low tens of thousands of places, SQLite on the personal Ubuntu box costs nothing, needs no service to administer, and backs up by copying one file.

Geographic queries are served by a **bounding-box index on `(lat, lng)`** — adequate at this scale; a true spatial index is unnecessary.

Constraint accepted to keep the door open: no SQLite-only SQL in application code, all access through Prisma, so a PostgreSQL/PostGIS move later is a datasource swap plus an index migration.

### Keep: Leaflet + react-leaflet
The specification prefers MapLibre (§41). We are **not** migrating now, because the Leaflet layer is the single most valuable working asset in the repository — clustering, viewport culling, the three-layer route polyline, numbered stops and live-GPS rendering are all verified working. Replacing it would destroy functioning code, which §6 forbids.

Mitigation: tile URL and attribution move behind `MapTileProvider` config so the renderer swap is isolated to `MapView.tsx` when it is justified.

### Add: zod for validation
Already present transitively; promote to a direct dependency. Every API boundary and every AI output gets a schema (§40, §67).

### Add: Vitest for tests
Fast, TS-native, no config fight with Next. Node environment for lib/API tests; provider interfaces are mocked (§84).

### Add: `argon2`-hashed single-user auth with a signed httpOnly session cookie
No external identity provider, no recurring cost, satisfies §64. Table-backed so multi-user is an additive change (§95).

### AI: Ollama first, behind `AIProvider`
Local, free, matches §8. The interface admits OpenAI/Anthropic implementations later without touching call sites (§66).

---

## 2. Target data model

Replaces the five flat models with a normalized schema built around **Place as the source of truth** (§4, §57, §108).

```
User                     single row today; FK-ready for multi-user

Place                    canonical location
  ├── PlaceSource[]      many origins per place  (§14 dedup, §15 memory)
  │     └── Media[]      thumbnails, video, screenshots  (§16, §60)
  ├── PlaceTag[]         → Tag
  ├── FieldProvenance[]  per-field source + confidence  (§91)
  ├── ItineraryItem[]
  └── Visit[]            visited_at, rating, notes, photos  (§76, §77)

Category                 controlled taxonomy + subcategory  (§13)

Trip
  ├── TripPreference     start/end time, walking limit, mode, weights  (§44)
  ├── BucketListItem[]   places staged before planning  (§20)
  └── Itinerary[]        versioned, regenerable  (§72)
        └── ItineraryItem[]  order, arrival, departure, travel legs, locked  (§23, §73)

HikingRoute              first-class, not a Place  (§24, §27)
  ├── RouteGeometry      GPX / provider geometry  (§28)
  └── PlaceSource        Komoot URL retained  (§27)

ResearchSession          one deep-research run, timestamped  (§34)
  └── ResearchResult[]   with url, source, retrieved_at, confidence  (§69)

FlightOpportunity        normalized provider output + checked_at  (§35, §71)

GpsTrack                 explicit opt-in recording  (§26)
  └── GpsTrackPoint[]

ProviderCache            key → payload + fetched_at + ttl  (§63)
AiJob                    async job status for long operations  (§56)
```

**Place** carries: identity (`name`, `slug`), geography (`lat`, `lng`, `address`, `city`, `region`, `country`, `countryCode`), classification (`categoryId`, `subcategory`, `classificationConfidence`), provenance (`sourceType`, `locationConfidence`, `locationSource`), scores (`hiddenGemScore`, `touristTrapScore`, `localValueScore`), planning inputs (`estimatedVisitMinutes`, `estimatedCost`, `currency`, `openingHours`), and lifecycle (`createdAt`, `updatedAt`, `deletedAt`).

`sourceType` is an explicit enum — `PERSONAL | RESEARCHED | IMPORTED | MANUAL | DISCOVERED | REFERENCE` — so personal and web knowledge are never silently mixed (§33).

`locationSource` enum: `EXPLICIT_COORDINATE | PLATFORM_METADATA | URL | TEXT | OCR | AI | GEOCODER | MANUAL` (§11).

Manual edits write `FieldProvenance.source = MANUAL` and are never overwritten by later AI guesses (§90).

### Migration of the existing 9320 rows
They are Wikivoyage bulk data, not user saves. They are **preserved**, not deleted, and re-tagged `sourceType = REFERENCE` with a `PlaceSource` row recording Wikivoyage as origin. The Saved/map-default views exclude `REFERENCE`; Discover and destination research consume it as a corpus. This resolves the "9320 places I never saved" problem without discarding work.

---

## 3. Service layer

```
src/server/
  providers/
    ai/            AIProvider          → OllamaProvider
    geocoding/     GeocodingProvider   → NominatimProvider  (cached, rate-limited)
    routing/       RoutingProvider     → OsrmProvider       (existing /api/route logic)
    source/        SourceProvider      → TikTok, Instagram, YouTube, Komoot, GoogleMaps, GenericWeb
    search/        SearchProvider      → (research; deferred to Phase 7)
    flights/       FlightProvider      → (deferred to Phase 8)
    storage/       StorageProvider     → LocalDiskProvider
    tiles/         MapTileProvider     → config only
  services/
    ingestion/     pipeline orchestrator + per-stage results
    location/      extraction engine, confidence scoring
    classification/taxonomy mapping
    dedup/         proximity + normalized-name + external-id matching
    itinerary/     route optimizer
    research/      destination research
    cache/         ProviderCache read-through
  auth/            session issue + verify
```

Every provider returns a normalized shape and declares its failure modes. Provider unavailability degrades gracefully and is surfaced in the UI (§62, §98) — never silently swallowed as it is today (D2, D6).

---

## 4. Ingestion pipeline

One endpoint, `POST /api/import`, accepting URL, text, image, or file (§9, §54).

```
RECEIVE → DETECT SOURCE → FETCH METADATA → EXTRACT MEDIA → EXTRACT TEXT
  → EXTRACT LOCATION → GEOCODE → CLASSIFY → DEDUPE → PERSIST → CONFIRM
```

Each stage reports `pending | ok | skipped | failed` with a human-readable reason, streamed to the UI so a failure names the stage (§55). Any stage may degrade: no coordinates → keep raw location text for manual correction; no media → keep source URL and thumbnail.

**yt-dlp is an optional dependency.** Its absence is detected at startup and reported as a named, actionable capability gap in the import UI — not as an empty success (fixes D2).

Confidence gating (§11): `≥ 0.85` saves automatically and remains editable; below that the UI asks *"Roamora thinks this is X"* with Confirm / Edit / Reject. Nothing incorrect is saved silently.

---

## 5. Route optimization

Replaces "whatever order the user clicked" with a real optimizer (§21, §43):

1. Filter by opening hours and trip window
2. Pairwise travel-time matrix from `RoutingProvider` (cached)
3. Geographic clustering
4. Greedy seed → 2-opt improvement under time budget
5. Insert meal slots at configured times
6. Score: experience value − travel cost − backtracking penalty − fatigue penalty
7. Emit three variants: **Maximum Experience**, **Least Walking**, **Relaxed** (§46)
8. Respect locked stops on regeneration (§73)
9. Return a human-readable justification per ordering decision (§45)

All distances and durations come from the routing provider; none are invented (§40).

---

## 6. Phase plan

Ordered per §96. Each phase ends green: `typecheck && lint && test && build`, with the app runnable.

| Phase | Scope | Exit criteria |
|---|---|---|
| **1 — Foundation** ✅ | Single DB; normalized schema; data migration of 9320 rows; config module; zod validation; honest error reporting; capability detection; Vitest; `.env.example`; npm scripts | **Done** — see §11. Auth deferred to 1b. |
| **2 — Places** | Place service, taxonomy, provenance, `/api/places` with pagination+bbox, place detail page, sources & media surfaced | Place detail renders source + media; map loads via bbox, not full-table |
| **3 — Import** | Ingestion pipeline, source providers, location engine, OCR, classification, dedup, staged progress UI | TikTok/Instagram/Komoot/generic URL import end-to-end with honest failure reporting |
| **4 — Trips** | Bucket list, trip model, optimizer, itinerary timeline, route visualization, three variants, manual editing | Itinerary generated from real geography; lock + regenerate works |
| **5 — Live travel** | Active-trip screen, GPS progress, arrival detection, visited marking, track recording | Verified on a physical phone |
| **6 — Hiking** | Komoot ingestion, GPX import/parse, HikingRoute entity, elevation, map rendering | GPX renders; Komoot URL preserved |
| **7 — Destination intelligence** | Research sessions, hidden-gem & tourist-trap scoring, food research, destination profile | Research persists with per-result sources and timestamps |
| **8 — Flights** | FlightProvider abstraction, opportunity list, destination linkage | Works with a configured provider; explicit empty state without one |
| **9 — Polish** | Offline trip download, share-target, accessibility, performance, error states, AI command layer | §97 definition-of-done met per feature |

---

## 7. Technical risks

| Risk | Mitigation |
|---|---|
| **yt-dlp fragility.** Platforms break extractors frequently; Instagram often requires auth. | Treat as optional capability. Multi-strategy fallback (oEmbed, OpenGraph, manual paste). Never report failure as success. |
| **Migrating live data out of `prisma/dev.db`.** | Back up both files first; migration script is idempotent and verified by row-count assertions before the old file is retired. |
| **Nominatim / Overpass / OSRM usage limits.** These are free community services. | Read-through `ProviderCache`, request deduplication, 1 req/s throttle, honest `User-Agent`, documented self-host path. |
| **Local LLM quality for structured extraction.** | zod-validated outputs, reject-and-retry, confidence gating, always-available manual correction. |
| **Optimizer combinatorics.** | Cluster first, cap candidate set, time-boxed 2-opt, cache the travel matrix. |
| **Leaflet ↔ MapLibre divergence.** | Isolate tile config now; defer renderer swap until a concrete need appears. |

---

## 8. Environment variables

To be delivered as `.env.example` in Phase 1:

```
# DATABASE
DATABASE_URL="file:./prisma/dev.db"

# AUTH
AUTH_SECRET=                  # session signing key
ROAMORA_PASSWORD_HASH=        # argon2 hash, generated by npm run auth:hash

# AI
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# MAP / TILES
MAP_TILE_URL=https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png
MAP_TILE_ATTRIBUTION=

# GEOCODING
GEOCODING_PROVIDER=nominatim
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org
NOMINATIM_USER_AGENT=Roamora/1.0

# ROUTING
ROUTING_PROVIDER=osrm
OSRM_FOOT_URL=https://routing.openstreetmap.de/routed-foot
OSRM_BIKE_URL=https://routing.openstreetmap.de/routed-bike
OSRM_CAR_URL=https://routing.openstreetmap.de/routed-car

# STORAGE
STORAGE_PROVIDER=local
STORAGE_LOCAL_PATH=./storage

# SOURCE INGESTION
YTDLP_PATH=yt-dlp             # optional; absence is reported, not fatal

# SEARCH / FLIGHTS  (Phases 7–8; absent = feature shows explicit empty state)
SEARCH_PROVIDER=
FLIGHT_PROVIDER=
```

No secret is ever exposed to the client; providers are server-only modules (§64).

---

## 9. Testing strategy

- **Unit:** URL normalization, location extraction scoring, dedup matching, classification mapping, GPX parsing, opening-hour constraints, optimizer scoring, distance/duration formatting.
- **Integration:** ingestion pipeline with mocked `SourceProvider`; itinerary generation with mocked `RoutingProvider`; API routes against a temporary SQLite file.
- **Contract:** each provider implementation validated against its interface's schema.
- **Never** hit live third-party APIs in tests — every external call goes through a provider interface precisely so it can be mocked (§84).

---

## 10. Definition of done

Per §97, a feature ships only when: UI works, API works, data persists across refresh, loading/empty/error states exist, mobile and desktop both work, provider failure is handled explicitly, tests exist, and no console errors remain.

Two rules override convenience everywhere in this roadmap:

- **No fabricated functionality** (§98). No demo routes, no placeholder prices, no fake GPS, no invented coordinates. A provider that cannot be reached produces an explicit, named limitation in the UI.
- **No invented facts** (§99). Distances come from the router, coordinates from the geocoder, prices from a provider, each with a timestamp. Unknown is reported as unknown.

---

## 11. Phase 1 — delivered

Verified against the running application, not just compiled.

**Database**
- `src/lib/db.ts` now resolves the path from `DATABASE_URL` (was hardcoded to `prisma/dev.db`), so the CLI and the app finally address the same file. **D1 closed.**
- Schema normalized: 5 models → 18. `PlaceSource`, `Media`, `FieldProvenance`, `Visit`, `BucketListItem`, `TripPreference`, `GpsTrack(+Point)`, `Category`, `Tag`, `PlaceTag`, `ProviderCache`, `AiJob`, `User` added; dead `HikingTrail` (0 rows, 0 references) dropped.
- `Place` gained geography, provenance, confidence, scoring and planning columns, plus a `(lat,lng)` bounding-box index.
- Data migration (`npm run db:migrate-phase1`, idempotent, row-count guarded): 9320 places preserved, 30 categories seeded, 9320 `categoryId` links, 9320 `PlaceSource` rows, 254 tags / 27730 links.
- The 9320 Wikivoyage rows are re-tagged `sourceType = REFERENCE` so they stop presenting as personal saves. Both databases backed up to `.backups/` first.

**Honest failure reporting**
- `/api/extract` returned **200 with an empty payload** when yt-dlp was missing; it now returns **422 `YTDLP_MISSING`** with per-stage results and the install command. Verified end-to-end: the UI shows the failure, names yt-dlp, prints the remedy, and renders **no** blank edit form. **D2 closed.**
- `ai-planner` no longer fabricates activities at `lat 0, lng 0`. Unavailability raises `PlannerUnavailableError`; `/api/trips` returns **503 `AI_UNREACHABLE`** naming the endpoint and model. AI output is zod-validated and every coordinate is snapped back to a real database row. **D5 closed.**
- `/api/places` and `/api/trips` no longer return `[]` with status 200 on failure. **D6 closed.**

**Performance & correctness**
- `/api/places` gained SQL filtering, bounding box and cursor pagination. Default payload: **~4 MB → 47 bytes**. Bbox verified: 4 rows inside a Prague box vs 2000 unbounded, all confirmed inside. **D3 closed.**
- Trip candidates are now geocoded and bbox-limited to ~30 km / 60 places, personal saves outranking reference rows, instead of pushing all 9320 into the prompt. **D4 closed.**
- All API boundaries parse through zod. **D8 closed.**
- Geocoding is cached in `ProviderCache` (90-day TTL) and throttled to Nominatim's 1 req/s policy.
- Fixed a real React violation: a ref was written during render in `LiveLocation`, and `loadTrips` was called before declaration in the plan screen.
- Fixed a Turbopack warning that was tracing the whole project (including `/public`) into the server bundle.

**Tooling**
- `typecheck`, `test`, `test:watch`, `verify`, `db:*`, `icons` scripts added.
- Vitest with 39 tests across taxonomy, geometry/formatting and API schemas. One test caught a genuine bug during development: bounding-box query params were not coerced from strings, so every bbox request failed validation.
- `npm run verify` — typecheck, lint, test, build — passes with **0 errors**.

**Known gaps carried forward**
- Auth (§64) not yet implemented — moved to phase 1b, ahead of phase 2.
- 11 `react-hooks/set-state-in-effect` warnings remain, demoted from error with justification in `eslint.config.mjs`; converting them is phase 9 work.
- `overpass.ts` still queries only `node` elements (**D7 open**) — addressed in phase 3 with the source-provider rework.
- Provider interfaces are not yet extracted; phase 1 introduced the config module and two services (`geocode`, `capabilities`) that phase 2–3 will formalize behind the interfaces in §3.
