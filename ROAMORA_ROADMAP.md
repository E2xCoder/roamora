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
| **1b — Auth** ✅ | scrypt password hashing, signed session cookie, middleware gate, login page, `auth:hash` script | **Done** — see §12 |
| **2 — Places** 🟡 | Place service, taxonomy, provenance, `/api/places` with pagination+bbox, place detail page, sources & media surfaced | Detail page, provenance, soft delete and nearby done; media upload and full edit UI remain |
| **3 — Import** 🟡 | Ingestion pipeline, source providers, location engine, OCR, classification, dedup, staged progress UI | Pipeline, six providers, dedup and staged UI done — see §13. OCR/screenshot and file upload remain |
| **4 — Trips** 🟡 | Bucket list, trip model, optimizer, itinerary timeline, route visualization, three variants, manual editing | Deterministic single-day optimizer done — see §14. Persisted multi-day trips, three route variants, locked-stop regeneration UI remain |
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

---

## 12. Phase 1b & 2 — delivered

**Authentication (§64)**
- scrypt from Node's standard library — memory-hard, no native dependency, no recurring cost. Parameters are embedded in the hash so they can be raised later without invalidating existing credentials.
- Stateless HMAC-signed session cookie; httpOnly, SameSite=Lax, Secure in production. No session table needed for one user.
- `middleware.ts` gates every route; API callers get `401 UNAUTHENTICATED`, browsers are redirected to `/login`.
- **If `AUTH_SECRET` / `ROAMORA_PASSWORD_HASH` are unset the instance runs open**, so a fresh clone is usable — but `/api/auth/status` reports that, so the UI can warn rather than implying the instance is protected.
- `npm run auth:hash -- "password"` prints both values ready to paste into `.env`.
- The login redirect only accepts same-origin relative paths, so a crafted `?next=` cannot bounce the browser off-site.
- 12 tests: verification, salt uniqueness, malformed-hash handling, signature forgery, expiry, and the configured/unconfigured decision.

**Place detail (§17)**
- `/api/places/:id` returns sources, media, tags, per-field provenance, visits and nearby places (3 km box).
- Detail page shows where a place came from, its confidence bar and location source, the original links, editable notes, coordinates, a map and nearby saves.
- **Soft delete**: `deletedAt` is set, so a place removed by accident keeps its sources and can be recovered. Verified: the row disappears from queries, re-fetch is 404, and a second delete is 404 rather than an error.
- `PATCH` records `MANUAL` provenance per edited field, so later automated passes cannot overwrite a human's correction (§90).

**A destructive bug found and fixed during verification**

`updatePlaceSchema` was defined as `createPlaceSchema.partial()`. `.partial()` makes keys optional but **keeps their defaults**, so zod materialised `category: "other"`, `sourceType: "MANUAL"`, `source: "manual"`, `tags: []` for every field the caller omitted.

A PATCH that only changed `notes` therefore rewrote the record's classification and provenance. Observed live: a Wikivoyage row flipped `REFERENCE → MANUAL` and `attraction → other`, leaking a reference place into the personal pool — defeating the §33 separation the whole phase was built around.

Fixed by declaring the update schema explicitly with no defaults. `scripts/repair-source-types.ts` reconstructs `sourceType` from the untouched `PlaceSource.platform`; the one affected row's category was restored from the pre-migration backup. Four regression tests now assert that a partial patch materialises nothing.

---

## 13. Phase 3 — ingestion pipeline

**The pipeline works without yt-dlp.** That was the central design decision: TikTok and YouTube publish keyless oEmbed endpoints, Google Maps encodes coordinates in the URL, and everything else exposes OpenGraph. yt-dlp became an *enrichment* step rather than a prerequisite, so the core loop is usable today.

**Stages** (`src/server/services/ingestion.ts`): validate → detect → metadata → media → location → geocode → classify → dedupe. Each reports `ok | skipped | failed` with a human-readable detail, rendered as a checklist in the UI.

**Source providers** (`src/server/providers/source/`): TikTok (oEmbed → OpenGraph), YouTube (oEmbed), Instagram (OpenGraph, honest about login walls), Google Maps (three URL coordinate forms plus short-link resolution), Komoot, and a generic OpenGraph fallback. All behind one `SourceProvider` interface.

**Location engine** (`location-extraction.ts`): ordered strategies — pin emoji, labelled "location:", prepositions, capitalised multi-word phrases, hashtags — each carrying a base confidence. A 40-word stopword list keeps `#travel`, `#fyp` and `#wanderlust` out. Geocoding then corroborates or refutes: a hit raises confidence, a miss cuts it to ≤ 0.35. Text plus geocoding never reaches certainty; only an explicit coordinate does (0.97).

**Deduplication** (§14): normalized-name Dice similarity plus geographic proximity, with exact source-URL and platform-id shortcuts. Verified live — Charles Bridge imported from Google Maps and then from Wikipedia produced **one place with two sources**, 90 m apart, name similarity 1.0.

**SSRF protection** (§64): `url-safety.ts` rejects non-HTTP schemes, loopback, RFC1918, CGNAT, link-local (including `169.254.169.254`) and IPv4-mapped IPv6, and resolves DNS so a public hostname pointing inside the network is caught. Response bodies are capped at 2 MB with a 15 s timeout.

**Two real bugs caught by verification**

1. *Confident nonsense.* A deleted TikTok still serves the platform's chrome. The pipeline read "TikTok - Make Your Day" as post content, extracted "Make Your Day" as a place, geocoded it to an unrelated shop in Greece, and reported **0.65 confidence** — precisely the fabrication §99 forbids. `boilerplate.ts` now rejects platform chrome outright unless the source supplied coordinates; the same URL returns `422 BOILERPLATE_ONLY` explaining the post is deleted, private or region-locked.

2. *Category silently downgraded.* The pipeline emits taxonomy ids, but the save path ran them through `legacyCategoryToId`, which only knew the old free-text values — so a place classified `castle` was stored as `other`. The resolver now passes through values that are already valid ids.

---

## 14. Phase 4 (partial) — deterministic single-day itinerary optimizer

**Why this exists.** The user's actual workflow before Roamora: mark places one at a time, hand the list to ChatGPT, watch it sequence them starting from the farthest point and working inward — because an LLM has no real notion of geographic distance — then manually pull walking/transit distances from Google Maps and opening-hours constraints himself and feed them back in until the model produced something usable. The ask was explicit: *"ben bir programi eğitmek ve onun bunu bana yapmasını istiyorum"* — a program that does the distance-fetching and sequencing itself, not a chat he has to keep correcting.

**Design consequence.** Sequencing never goes through an LLM. `/api/trips`'s existing Ollama-based planner is untouched but is a separate, older path (§1 §12) — this is a new, independent feature: a real distance matrix plus a real constrained-insertion algorithm.

**`src/server/services/osrm-matrix.ts`** — one OSRM `/table/` call returns the full pairwise duration/distance matrix for all stops, instead of O(n²) `/route/` calls. Falls back to a straight-line matrix, explicitly flagged (`matrixSource: "fallback"`), if the routing provider is unreachable.

**`src/server/services/itinerary-optimizer.ts`** — pure, synchronous, no network, no randomness: same input always produces the same output. Cheapest-insertion construction (the classic TSP heuristic) extended with time-window feasibility checks, followed by a bounded 2-opt pass that only reorders unlocked, non-fixed-time stops. Per-stop inputs are exactly what the user was calculating by hand: `earliestTime` (opens at), `latestTime` (last entry), `fixedTime` (a timed show — a hard anchor the solver builds everything else around), `visitMinutes`, `estimatedCost`, `locked` (pin a stop's position).

**Failure is reported, not hidden** (master-spec §30, "Failure Mode"): an unreachable fixed-time appointment names the stop and the earliest possible arrival; a day that runs past its end time reports the overrun in minutes; a stop that cannot be inserted anywhere without breaking another stop's fixed time is flagged individually. Cost is summed only when every included stop has a price — otherwise `costKnown: false`, never a guessed total.

**`POST /api/itinerary/optimize`** — stateless: takes the current stop list plus constraints, returns the solved order and full schedule. No trip record has to be created first, matching the "pick places, get a route" flow directly.

**UI** — the existing map-page route builder (tap pins → add to route) gained a "Zamanlama ve Optimizasyon" panel: start location (current GPS, or first stop), day start/end, and per-stop constraint fields behind an expand toggle. "Rotayı Optimize Et" reorders the visible stop list to match the solved sequence and shows arrival/departure time chips, wait time, and any conflicts inline.

**Two real bugs caught during testing, both in the conflict-reporting path, not the ordering itself:**

1. A fixed-time stop's "did we make it" check compared the *forced* schedule time against itself, which is always equal by construction — so a genuinely missed appointment silently reported `feasible: true`. Fixed by checking the pre-adjustment raw arrival against the target instead.
2. `latestTime` was treated as a hard gate during insertion, so a stop that could not make its own cutoff from any position was dropped from the plan entirely (a vague "unplaceable") rather than being placed at its best slot with a specific "you'll arrive after last entry" conflict. `earliestTime`/`latestTime` are now soft — they only gate a wait or a reported violation; only `fixedTime` (an explicit appointment) blocks insertion outright, to protect it from being pushed later by another stop.

**Verified live against real Prague coordinates and the live OSRM service** (not mocked): three real places submitted in a deliberately bad order resolved to a geographically sensible sequence (3.89 km, 62 min) with `matrixSource: "osrm"`. An impossible fixed-time appointment (09:05, unreachable from the given start) was correctly rejected with the precise earliest possible arrival (09:39) and correctly identified the *other* stops as the ones that would need to be dropped to protect it. An `earliestTime` constraint produced a genuine computed wait (72 minutes) rather than silently ignoring it. Cost summed correctly across stops and reported `costKnown: false` when one stop's price was left blank. Exercised through the actual UI (button clicks, not direct API calls): route mode → add real stops → expand scheduling → optimize → time chips and cost warning rendered correctly.

11 new tests (`tests/itinerary-optimizer.test.ts`) cover the algorithm in isolation, including a direct reproduction of the reported bug — three points submitted farthest-first, asserting the solver produces the efficient start→near→mid→far order instead. `npm run verify` clean at 117 tests total.

**What remains for the full Phase 4 scope**: this optimizes one day, ephemerally, in the browser session — it does not yet persist into a `Trip`/`TripDay`/`TripActivity` record, generate multiple days, or produce the three named variants (Maximum Experience / Least Walking / Relaxed) from §5 of this document. Those build on the same solver; the hard part — real distances plus constraint-respecting sequencing — is done.

**Verified end-to-end:** dead TikTok → honest 422; Google Maps URL → Prague Castle at 0.97 confidence, auto-classified `castle`; Wikipedia → same bridge within 10 m of the Maps coordinate; duplicate detected and merged; notes preserved. 99 tests, `npm run verify` clean.

---

## 15. Phase 3.5 — autonomous discovery (destination in, itinerary out, no manual place entry)

**The ask, precisely stated by the user:** the app itself must research a destination — attractions, restaurants, hidden spots, opening hours, prices — from only a destination, date, arrival/departure time and budget. Web research is required, not optional; the requirement was never "no research," it was "no *manual* research by the user." Google Maps/Places/Routes must not be a hard dependency; the stack must be open-source and self-hostable wherever practical, matching every provider choice already made in this project (OSRM, Nominatim, Overpass, Wikipedia).

**What this phase delivers, honestly divided into two categories.**

### Verified working now, zero extra infrastructure

`POST /api/itinerary/autoplan` — `{ destination, date, arrivalTime, departureTime, budget?, interests? }` in, a scheduled itinerary out:

```
geocode destination → Overpass discovery (OSM) → score + classify + diversify
  → OSM opening_hours resolution for the actual trip date
  → Wikipedia summary enrichment
  → the EXISTING, unmodified deterministic optimizer (§14) → itinerary
```

- **`overpass-discovery.ts`** — one `nwr` (combined node+way+relation) Overpass query across ten categories (attractions, historic sites, worship, food, bakeries, parks, natural features, markets, monuments, accommodation). `nwr` also closes D7 from the original audit (`src/lib/overpass.ts`'s manual Explore screen still queries `node` only, missing most real POIs, which are mapped as ways/relations).
- **`discovery-scoring.ts`** — deterministic OSM-tag → taxonomy classification (a lookup table, not a guess: `tourism=museum` really does mean museum) and a smooth-weighted-round-robin pruning pass so a category with far more raw OSM entries (restaurants, always) cannot crowd out everything else, while a stated interest can still legitimately dominate the shortlist when the user weights it heavily.
- **`src/lib/opening-hours.ts`** — a conservative parser for OSM's `opening_hours` mini-language: weekday ranges, multiple daily windows, exceptions ("Mo-Su 09:00-18:00; Th off"), a leading month range. Anything outside that grammar (sunrise/sunset, week numbers) is refused as `unparseable` rather than guessed — a wrong hard constraint fed into the optimizer is worse than an honestly-missing one.
- **`wikipedia-summary.ts`** — real, sourced "why visit" text via Wikipedia's own geosearch + extract API, not an LLM paraphrase. Shares its rate-limit/backoff state with the existing photo lookup (`wikimedia.ts`) through a new common `wikipedia-client.ts`, specifically to avoid recreating the exact 429 bug already fixed once this session (two independent 1-req/sec throttles against the same host still add up to 2 req/sec).
- Every fact carries its source and confidence (`StopProvenance`): `osm/medium` for a resolved OSM opening-hours tag, `unverified/unknown` when nothing could be confirmed. Nothing is invented to fill a gap.

**Verified live, real destination, real bugs found and fixed by that testing — not simulated:**

Ran against Poznań (the user's own example) end to end. Result: a real, walkable 8-stop, 4.64 km itinerary — Św. Jan Nepomucen, Czerwona Papryka, Zamek Cesarski, Studnia Bamberki, Ministerstwo Śledzia i Wódki, Pijalnia Czekolady Wedel, Hotel Śródka, Brama Poznania ICHOT — discovered from zero manually-entered places, `feasible: true`, no conflicts, in 15–17 seconds.

Two real defects surfaced only by that live run, not by unit tests:

1. **Overpass's public instance grants a client two concurrent "slots"** (confirmed via its own `/api/status` endpoint). An earlier version of the discovery provider split the ten categories into several smaller sequential batches to keep each request cheap — this made things *worse*: a batch whose response arrived after this process's own client-side timeout had already given up left that slot occupied server-side, starving the next batch and cascading into more timeouts and eventually a 429. Rewritten as a single request; combined with narrowing the unrestricted `historic=*` filter (which alone was expensive enough in a dense old town to push the whole query past a minute) to the specific values worth visiting, and reducing the default search radius to 1500 m, discovery now reliably completes in single-digit seconds.
2. **Overnight-spanning opening hours produced a nonsensical constraint.** "Ministerstwo Śledzia i Wódki" — a real, well-known Poznań bar — publishes `12:00-02:00`. Read naively, `02:00` became a same-day cutoff, so the optimizer correctly (from its own perspective) reported a 10:27 arrival as eight hours late for closing. `widestWindow()` now excludes any window where `close < open` — the itinerary optimizer has no notion of a stop that closes "tomorrow," so an overnight window is left unconstrained rather than fed in wrong. Both bugs have regression tests.

### Architecturally ready, requires infrastructure this session cannot deploy

Two capabilities are real, working code paths behind the same honest "not configured" pattern already used for yt-dlp and Ollama (`getCapabilities()`) — but this is a sandboxed coding session, not a place a Java service or a Docker container can be stood up and left running, so neither is claimed as verified:

- **Web research** (`SEARXNG_URL`) — a `ResearchProvider` against SearXNG (self-hostable, keyless — `docker run -d -p 8080:8080 searxng/searxng`) plus a schema-validated Ollama fact-extractor (`fact-extraction.ts`) fill in opening hours/prices OSM does not carry. Unconfigured, `autoplan` runs on OSM + Wikipedia alone and says so in its trace rather than silently returning less. The extraction schema, prompt and JSON validation are real and unit-tested; the live search → fetch → extract chain itself was not exercised end-to-end because no SearXNG instance exists in this environment.
- **Transit routing** (`OTP_URL`) — OpenTripPlanner is genuine infrastructure (a separate service fed OSM + destination-specific GTFS), not an API call this codebase can complete on its own. The provider interface and capability probe exist; itineraries use walking only until it is deployed.

### Explicitly not attempted this pass, and why

Event discovery (needs live web research — see above), tourist-trap/review-sentiment scoring (needs many real reviews per place, which needs a search/reviews API this project has no free source for), automatic budget-triggered attraction removal (§31 of the master spec — flagged as a warning today, not auto-resolved), multi-scenario generation (Plan A/B/C), delay simulation. Attempting all of these in one pass, unverified, would have meant claiming a much larger surface area works than was actually tested — the same standard applied to every other phase of this project.

30 new tests across `opening-hours.test.ts` (20) and `discovery-scoring.test.ts` (10), including direct regressions for both live-discovered bugs. `npm run verify` clean at 147 tests.
