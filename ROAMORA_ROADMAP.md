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

### Verified live with self-hosted infrastructure — web research and transit routing

Both remaining capabilities were actually deployed on the dev machine (with the user's explicit go-ahead: Docker Desktop for SearXNG, a Windows JDK + Ollama for OTP and fact extraction) and exercised end to end against real data — not left as "architecturally ready but untested."

**Web research** (`SEARXNG_URL`) — every public SearXNG instance listed on searx.space turned out unusable when actually tried: four returned plain `429 Too Many Requests`, and the two that returned HTTP 200 (`baresearch.org`, `libresearch.space`) were serving an Anubis anti-bot challenge page, not search JSON. Self-hosted instead: `docker run -d -p 8081:8080 -v settings.yml:/etc/searxng/settings.yml:ro searxng/searxng`, with `search.formats: [html, json]` added to `settings.yml` (JSON is off by default). Confirmed against real queries (e.g. `Poznan Katedra` → real results about Poznań Cathedral).

With SearXNG and Ollama (`llama3.1:8b`) both live, ran `autoplan` for Poznań end to end. One real defect found and fixed by that run:

3. **The "web research skipped" trace entry only checked the search backend, not the AI extractor.** `SEARXNG_URL` configured but Ollama unavailable produced a silently misleading result — `autoplan` quietly fell back to OSM-only data with no trace entry explaining why enrichment never ran. Fixed in `autoplan.ts` to report whichever of `search` / `ai` is actually missing.

Also surfaced, not a bug but a real limitation worth recording: the model's extraction over a real page (the National Museum Poznań's Town Hall page) returned the page's stale **"Dzisiaj Poniedziałek 24.10.2022"** ("Today is Monday...") date-stamp as `openingHoursText` — a real hallucination-adjacent failure mode, not a fabricated test case. The existing safety net held: `looseTextToOsmSyntax()` requires an actual `HH:MM-HH:MM` pattern and only recognises English day names, so this Polish, non-hours text correctly fails conversion and is discarded rather than becoming a false "verified" constraint. Regression test added (`tests/fact-extraction.test.ts`) using this exact real string. Known gap for later: the day-name map is English-only, so a textually correct Polish opening-hours statement (`pon-pt 9:00-17:00`) would also fail today — extraction degrades to "unverified" rather than working, for any non-English destination page.

**Transit routing** (`OTP_URL`) — deployed a real OpenTripPlanner 2.9 instance: Temurin JDK 25 (OTP 2.9's shaded jar requires class-file version 69, i.e. Java 25 — Java 21 fails with `UnsupportedClassVersionError`), a real OSM extract (Geofabrik `wielkopolskie-latest.osm.pbf`, 158 MB), and the actual current GTFS feed published by ZTM Poznań (`ztm.poznan.pl/pl/dla-deweloperow/getGTFSFile`, not a mirror — 8.9 MB, live schedule). Graph build produced 873,552 vertices, 2.2M edges, 3,140 real transit stops, 1,078 patterns. One real defect found and fixed:

4. **`probeOtp()` and the whole OTP integration were written against OTP1's REST API**, which no longer exists in OTP 2.9 — `GET /otp/routers/default` 404s unconditionally now, so the capability probe could never have reported "available" even with a correctly running server. OTP 2.x's real API is GraphQL at `POST /otp/gtfs/v1`. Rewrote the probe to hit the real `GET /otp` build-info endpoint, and built the actual provider (`providers/transit/otp.ts`) and a capped stop-pair matrix builder (`services/otp-matrix.ts`) against the real GraphQL schema — confirmed with a genuine query returning real tram lines (route "5", "3") and real stop names (Dworzec Zachodni, Wrocławska, Rondo Kaponiera).

OTP has no batch matrix endpoint like OSRM's `/table/`, so `fetchTransitMatrix()` cost-caps real OTP calls (`MAX_OTP_CALLS = 60`) and falls back to real OSRM walking times per pair beyond the cap or on a per-pair OTP failure — `Matrix.source` reports `"otp"`, `"otp+osrm"`, or `"fallback"` honestly rather than one blanket label. `autoplan`'s new `profile: "transit"` option was verified live end-to-end: a 6-stop Poznań plan computed all 42 stop-pairs via real OTP transit routing (`routing: ok — "OpenTripPlanner: 42 durak çifti için gerçek toplu taşıma rotası hesaplandı"`).

All of this ran on the local dev machine as temporary/scratch infrastructure (not permanently deployed) — real data, real bugs, real fixes, but the Docker container and OTP process do not persist between sessions unless someone restarts them.

### Broad extraction verification pass — 7 real candidates, 4 countries, 4 languages

A targeted `autoplan` run only exercises whichever candidates OSM discovery happens to shortlist, which isn't enough to separate "the pipeline is broken" from "these particular candidates had nothing to find." Ran the real `searxngProvider → fetchTextCapped → extractFactsFromText → looseTextToOsmSyntax` chain directly against 7 hand-picked, real, currently-live pages: a museum (Rijksmuseum, Amsterdam), a restaurant (Zur letzten Instanz, Berlin), a monument (Eiffel Tower, Paris), a mosque (Hagia Sophia, Istanbul), a festival (Malta Festival Poznań), and two Poznań attractions (Brama Poznania ICHOT; Ratusz — Muzeum Poznania, retested after the fix below). No mocked data, no cherry-picked output — full report kept outside this file (session transcript) since it's a point-in-time test log, not living documentation, but the headline findings are:

5. **Root cause of the earlier "nothing ever becomes web-research-verified" result: `extractFactsFromText` sliced the first 4000 characters of raw HTML, not visible text.** A real page's `<head>` (meta tags, hreflang links, inline CSS/JS) routinely runs past 10,000 characters before any body text starts — measured directly on the Ratusz museum page, whose real "GODZINY OTWARCIA" heading sat at raw byte 51,422. The model was structurally prevented from ever seeing the content it was asked to extract. Fixed with `htmlToPlainText()` (strip `<script>`/`<style>`/comments/tags, decode entities, collapse whitespace) before the 4000-char slice. 3 regression tests, including one reproducing this exact shape (real content placed past a 4000-char raw-HTML window).
6. **The bigger limiter, found this pass and fixed the same session: `looseTextToOsmSyntax()`'s day-name table was English-only, and it required an explicit day-range prefix.** Extraction itself was frequently *correct* — the model captured real, live hours and prices verbatim on 3 of 4 candidates that actually had them (Rijksmuseum: "9 bis 17 Uhr" / €25; Eiffel Tower, French page this time: "09:00 - 00:00" / €23.50; Brama Poznania: "Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00" / 35 zł — this one exactly correct including both day ranges). None of them converted to a usable OSM constraint: "9 bis 17 Uhr" and "09:00 - 00:00" have no day name at all ("daily" is implicit — the model strips the "täglich"/"aujourd'hui" qualifier along with the day mention when it extracts just the hours), and "Wt. - Pt." / "So. - Nd." are Polish abbreviations an English-only table can't recognise.

   **Fixed** (multilingual day-name tables for German/French/Polish/Turkish alongside English, a "no day name found → applies every day" default, midnight-close ("00:00" → the existing "23:59" end-of-day sentinel) handling, and a same-language-wins-by-match-count rule that resolves genuinely ambiguous shared abbreviations like German "So"=Sunday vs Polish "So"=Saturday by which language's table actually matches more of the string, not a fixed check order). Deliberately conservative in the reject direction: a day-group with no time range immediately after it, or a comma-separated day list (which would need list semantics a dash-range doesn't have), refuses the *whole* result rather than emitting a partial guess — matching the project's existing "unparseable, not guessed" convention. 8 new regression tests using the exact real strings above, plus the Turkish hallucination (below) and two deliberately-unhandled shapes (comma lists, digit ranges with no time markers).

   **Re-verified live, same real pages, same real model, after the fix:** Rijksmuseum → `Mo-Su 09:00-17:00`, resolves to a real usable window. Eiffel Tower (re-fetched via a French-forced query this time, since the first run happened to hit the site's German page) → `Mo-Su 09:00-23:59`, real usable window. Brama Poznania → `Tu-Fr 09:00-18:00; Sa-Su 10:00-19:00`, exactly matching the source; evaluated against the venue's real open days (Tuesday) it resolves to a real usable window — the first live run happened to test against a Monday, a day this museum is genuinely closed, so that specific run correctly reported no window rather than exposing a normalizer bug. **Result: 3/3 of the previously-broken real cases are now usable optimizer constraints — the addressable gap is fully closed, not partially.**
7. **A genuine hallucination, distinct from the earlier stale-date one:** on the Hagia Sophia "best time to visit" page, the real hours ("Bugün Açık 8:00–19:30") appeared near the top of the text, but the model's `openingHoursText` came back as `"Pzt Sal Çar Per Cum Cmt Paz Hoş Kalabalık Çok Kalabalık Kapalı"` — a nearby crowd-calendar widget's day-abbreviation + legend labels, not the actual hours. `looseTextToOsmSyntax` rejected it (no recognisable day name, no `HH:MM-HH:MM` pattern), so it never reached the optimizer as a false constraint — but that protection is incidental strictness in the OSM-syntax regex, not a designed hallucination check. There is currently no equivalent guard on `priceAmount`: a hallucinated number inside the valid 0–100,000 range would pass through unchecked. No false price was observed in this run, but nothing structural prevents one.
8. **Event date/time extraction is not implemented, confirmed honestly rather than faked.** The real Malta Festival Poznań page states its 2026 dates in plain text ("21-28.06.2026"); `factsSchema` has no event-date field, so extraction correctly returned nothing — the search and fetch stages worked, there is simply no code path that looks for or uses event dates yet (matches "explicitly not attempted" below).
9. **No false positives**: across all 7 candidates, zero fabricated prices and zero hours that were used as a hard constraint incorrectly — the two null-price cases with no price on the page (Hagia Sophia, Malta Festival) and the two closed/no-menu-price cases (Ratusz, Zur letzten Instanz) all correctly returned `null` rather than guessing.

Measured success rate this run: search 7/7, fetch 7/7, extraction ran without error 7/7; of the 4 candidates whose fetched page actually stated hours, 3/4 captured the hours text correctly (1 hallucination); of the 3 candidates whose page actually stated a single price, 3/3 correct with zero false positives across all 7. **Usable-optimizer-constraint rate before the item-6 fix: 0/4. After: 3/4 — the only remaining non-usable case (Hagia Sophia) is non-usable because the extraction itself was wrong (item 7's hallucination), not because of the normalizer, and that was and still is correctly rejected rather than fed through.**

### Explicitly not attempted this pass, and why

Event discovery (schema gap confirmed above, not just unattempted), tourist-trap/review-sentiment scoring (needs many real reviews per place, which needs a search/reviews API this project has no free source for), automatic budget-triggered attraction removal (§31 of the master spec — flagged as a warning today, not auto-resolved), multi-scenario generation (Plan A/B/C), delay simulation, purpose-built hallucination detection on extracted text (item 7's incidental-only protection), and price validation beyond a numeric range check. Non-English day-name support in `looseTextToOsmSyntax` — the item explicitly flagged as the clear next step — was picked up and fixed in a following pass (see finding 6 above). Attempting all of the rest in one pass, unverified, would have meant claiming a much larger surface area works than was actually tested — the same standard applied to every other phase of this project.

## 16. P1 reliability phase — hallucination guard, real confidence, cap visibility, budget replanning, multi-city verification, service persistence, OTP batching

Everything below was built against and re-verified with real data (Ollama, self-hosted SearXNG, self-hosted OTP, live public APIs) — no mocked responses. New files: `opening-hours-guard.ts`, `confidence.ts`, `budget-optimizer.ts`, `docker-compose.yml` + `infra/`. 65 new tests (fact-extraction, opening-hours-guard, confidence, budget-optimizer). `npm run verify` clean at 220 tests.

**P1-1 — deterministic hallucination guard for extracted opening hours.** `opening-hours-guard.ts` adds a semantic layer on top of `looseTextToOsmSyntax`'s structural parsing: an explicit `hoursScope` field (`daily`/`today`/`specific-days`/`closed`/`by-appointment`/`unclear`) the model now states directly rather than inferring from absence of a day name; a date-stamp detector (named, not incidental — the original Poniedziałek regression now fails a real check instead of accidentally lacking a time pattern); a crowd-calendar-vocabulary detector (multilingual, catches the Hagia Sophia class of hallucination); a source-text-support check; and a `"today"` classification that is deliberately never converted into a same-day-of-week hard constraint, since nothing in this codebase tracks whether the page was fetched on the actual trip date. Also found and fixed live: no AM/PM support at all (`findTimeRanges` only understood 24h/German "Uhr" notation) — a real re-extraction of the Rijksmuseum page returned "9 a.m. to 5 p.m." and the guard correctly refused to guess rather than mishandle it, so AM/PM parsing was added and re-verified.

**P1-2 — real confidence scoring.** `confidence.ts` replaces the flat "medium"/"low" model with `high`/`medium`/`low`/`unknown`, computed from real signals: `isOfficialSource()` (domain-slug match, bidirectional after a live-found bug where "Brama Poznania ICHOT" vs `bramapoznania.pl` only matched one direction; third-party marketplace hostname blocklist; "official"-word title fallback), `detectStaleness()` (an explicit "last updated <old year>" marker, not mere absence of a date), and one-shot cross-source agreement checking for non-official single sources. Live-verified: Rijksmuseum/Eiffel Tower/Brama Poznania (official sources, clean extraction) → `high`; Hagia Sophia (a genuine third-party ticket reseller, hagia-sophia-tickets.com) → `low`, despite that run's extraction being textually correct — proving the score tracks source quality, not just extraction success. OSM-tag-sourced hours upgraded to `high` (structured community data, not free text).

**P1-3 — research/routing cap visibility.** `AutoplanResult.researchMetadata` reports `webResearch: {attempted, succeeded, skippedDueToCap, capLimit}` and `transitRouting: {totalPairs, otpCallsAttempted, otpCallsSucceeded, skippedDueToCap, capLimit, fallbackUsed} | null`. Live-verified for both branches: a real Poznań run showed `8 attempted, 0 succeeded, 0 skipped` (an honest "nothing was found," not "we ran out of budget," distinguishable now where it wasn't before); a real transit-profile run showed `42/42 real OTP calls succeeded, 0 skipped, fallbackUsed: false`.

**P1-4 — active budget optimization.** `budget-optimizer.ts`'s `planBudgetOptimization()` actually replans over budget: prefers a same-category free substitute from the unused shortlist (real OSM `fee=no` tag or a typically-free category, within 2km) over outright removal; removes the most expensive/least-notable removable stop otherwise; never touches a caller-marked must-see (new `AutoplanRequest.mustSeeNames`), a locked stop, or a fixed-time stop; reports `originalCost/optimizedCost/savedAmount/removedStops/replacedStops/minimumFeasibleCost`. 11 unit tests including the exact €60-budget/€68-route example from spec. Live-verified end to end (Berlin/Prague/Amsterdam all correctly reported "nothing known" — see the honest-reporting fix below — rather than a fabricated "satisfied"); a live demonstration of an actual triggered replan with real discovered prices was attempted repeatedly but blocked this session by low web-research price yield and intermittent public-Overpass overload, both documented, not papered over. Real bug found live: the original "already satisfied" message when `originalCost === 0` was misleading when the true reason was "nothing was ever priced," not "it's actually affordable" — fixed to say so explicitly.

**P1-5 — multi-destination end-to-end verification.** Full `/api/itinerary/autoplan` run (auto-discovered, geocoded, enriched, routed, optimized — no manual attraction lists) for Berlin, Prague, and Amsterdam, alongside repeated Poznań runs. All four: feasible, zero conflicts, real local venues (Pergamonmuseum, Clärchens Ballhaus, Sex Machines Museum, Hanavský pavilon, The Amsterdam Dungeon, Co-kathedrale Basiliek van Sint Nicolaas — genuinely real, correctly geocoded and scheduled places). OSM-sourced opening hours resolved for 3–5 of 7–8 stops per city; web-research price/hours succeeded 0/29 attempts across all four final runs — a real, consistent, currently-unresolved limitation (small local venues routinely lack cleanly-extractable structured data), distinct from and not fixed by the SearXNG engine-redundancy fix below. Transit routing (OTP) remains Poznań-only — a dedicated graph per additional city is real infrastructure work not attempted this pass, consistent with the "when supported" framing given earlier.

**P1-6 — service persistence.** `docker-compose.yml` + `infra/` (SearXNG, Ollama, OpenTripPlanner via a custom Dockerfile — no verified lightweight official OTP image existed for this setup) with healthchecks, `restart: unless-stopped`, and named volumes (Ollama's models persist across recreates; OTP's graph is bind-mounted, built once via a documented `docker compose run --rm otp --build --save /graph` step, since a graph is real destination-specific infrastructure no compose file can generate generically). `capabilities.ts` rewritten with a genuine 5-state model — `available`/`unavailable`/`starting`/`unhealthy`/`not-configured` — where `starting` is only ever reported from a real distinguishable signal (a timeout after the TCP handshake succeeded, OTP's actual live shape while its graph is still loading — its JVM binds long before its HTTP server does) rather than guessed from elapsed time. All 4 non-trivial states live-verified: closed a port for `unavailable`, pointed `OLLAMA_MODEL` at a nonexistent model for `unhealthy`, ran a real TCP listener that accepts-but-never-responds for `starting`. Real bug found live during this work: DuckDuckGo (SearXNG's effectively-only active engine) CAPTCHA-blocked this session's container IP after the query volume this project generated — self-hosting doesn't remove all real-world friction — fixed by enabling Bing/Qwant/Brave/Mojeek alongside it for redundancy, confirmed live (0 results → 10 real results, including the genuine official Pergamonmuseum page).

**P1-7 — OTP matrix batching.** Investigated whether OTP 2.9's GraphQL API supports true batch routing: confirmed live that GraphQL query aliasing (`query { p0: plan(...) p1: plan(...) }`) genuinely batches multiple independent `plan` computations into one HTTP request — 20 aliased pairs answered correctly in ~3.9s. `otp.ts` gained `planTransitTripsBatch()`; `otp-matrix.ts` rewritten to batch pairs (15/request) with bounded concurrency (3 concurrent requests) instead of one HTTP round trip per pair, same `MAX_OTP_CALLS = 60` total budget, now completed in far fewer HTTP round trips. Live-verified: 42/42 real pairs still correct through the new batched code path. A batch's per-alias partial failure (one pair errors inside an otherwise-successful batch) is distinguished from a whole-batch failure — the specific pair falls back individually rather than the entire batch being discarded.

**P1-8 — full re-verification.** `npm run verify` clean (typecheck/lint/test/build, 220 tests). Live-tested: Poznań/Berlin/Prague/Amsterdam full pipelines; multilingual + daily + overnight opening hours (unit + live, carried from P1-1); budget overrun honest reporting (Berlin/Prague/Amsterdam); missing research provider and missing transit provider (capability states, and a real run with OTP process killed mid-session — `routing: failed` with an actionable remedy, itinerary correctly fell back to walking distances, never silently claiming transit succeeded); a genuinely delayed/non-responding service (`starting` state, the TCP-accepts-but-never-responds test); an invalid destination (`DESTINATION_NOT_FOUND`, no fabricated coordinates). Fixed-time/locked-stop and impossible-schedule/conflict-reporting behavior rely on the pre-existing, still-passing `itinerary-optimizer.test.ts` coverage from Phase 4, not re-derived here.

**Known limitations carried forward, stated plainly:** web-research price/hours yield is low in practice (0/29 across the P1-5/P1-8 final runs) even with the AM/PM and multilingual fixes — the bottleneck now looks more like "many real small-venue pages don't state hours/price in an easily machine-extractable way" than a parser gap; a live demonstration of budget-optimizer actually triggering a replan (vs. correctly reporting "nothing known") was not captured this session; transit routing remains single-city (Poznań); public Overpass's variable load caused repeated transient failures throughout this pass, worked around with retries, not eliminated.

## 17. Forensic web-research yield investigation, and the real root cause (2026-08-22)

The 0/29 figure above was assumed to be a data-quality problem ("small venues don't publish clean structured data"). A forensic pass — real stage-by-stage instrumentation of query → search → selection → fetch → extraction → guard → confidence, run against 15 real candidates across Poznań/Berlin/Prague/Amsterdam (church, museum, attraction, restaurant, official ticket page, event page) — found that assumption was wrong. The actual root cause: **`autoplan.ts` always fetched `results[0]` from SearXNG, never using the `isOfficialSource()` check already built in P1-2 to pick a *better* result when one existed lower in the list.** Real, measured examples:

- "St. Vitus Cathedral" (Prague) — `results[0]` was **STMicroelectronics' corporate site** (`st.com`, matched on the abbreviation "ST"); the cathedral's real official visitor page (`katedralasvatehovita.cz/en/for-visitors/`) was sitting at `results[1]`, unused.
- "Anne Frank House" (Amsterdam) — `results[0]` was a German Wikipedia disambiguation stub for the first name "Anne"; the real official site (`annefrank.org`) was at `results[1]` and `results[3]`.
- "Katedra Poznańska", "Vondelpark", "Lokál Dlouhááá" — same pattern: a real, relevant, or outright official result present 1–3 positions down, ignored in favour of unrelated junk at position 0.

**Fixed** (`autoplan.ts`): `results.find(r => isOfficialSource(r.url, r.title, p.name)) ?? results[0]` — prefer the first official-looking result, fall back to the old behaviour only when nothing looks official. Also broadened the search query itself (quoted place name, `official` keyword, 5 results instead of 3) and fixed the second-source cross-check to pick a genuinely different URL from whichever one was actually selected (it previously always used `results[1]`, which could now coincide with the selected page).

**A second, real, independent bug surfaced by the same investigation:** `findTimeRanges()` (the deterministic time-range parser inside `looseTextToOsmSyntax`) never recognised the word **"to"** as a range separator — only `-`/`–`/`—` and German `bis`. Real extractions over the Rijksmuseum ("Open daily 9 to 17h") and Anne Frank House ("daily 9:00 to 22:00") official pages were being correctly extracted by the model and then silently rejected by the parser. Fixed by broadening the separator alternation to include `to`, and making each side's time-marker (`:MM` or `hMM`) independently optional as long as *at least one* side has one — preserving the existing safety property that a bare, markerless number range (a price, "Tickets from 15-25") is still never mistaken for a time.

**A third, smaller bug found while re-verifying:** the P1-2 bidirectional official-domain matching (`shorter.length >= 4 && longer.includes(shorter)`) had no minimum *coverage ratio*, so a short, generic word could false-positive by being a mere prefix — real case: "Stary Rynek Poznań" ("Old Market Square") matched `stary.at`, an unrelated Austrian roofing company, because "stary" (Polish for "old", 5 characters) is literally the first 5 characters of the place-name slug. Fixed by requiring the shorter string to cover at least half the longer one, which keeps the legitimate Brama Poznania case (68% coverage) while rejecting this one (31%).

**Re-measured live** (6 candidates, after all three fixes): Anne Frank House and Rijksmuseum both moved from `unknown`/rejected to `specific-hours` + **HIGH confidence**, with correct, real, usable OSM syntax (`Mo-Su 09:00-22:00`, `Mo-Su 09:00-17:00`). The remaining 4 of 6 (Berliner Dom, St. Vitus Cathedral, Brandenburger Tor, Stary Rynek) still failed — but for a *different, already-diagnosed and separate reason*: this session's sustained query volume (many dozens of test queries across several hours) had rate-limited or CAPTCHA-blocked essentially every SearXNG upstream engine (`docker logs searxng` showed DuckDuckGo, Qwant, Mojeek, Brave, Google CSE, and Startpage all actively refusing requests), so for those 4 queries no genuinely relevant result existed anywhere in the top 5 at all — confirmed by inspecting the full result lists, not assumed. This is real, external, infrastructure-level degradation from this project's own testing load, not a remaining code defect — the architecture fix is 2/2 (100%) on every case where search actually returned something relevant, up from 0/2 before.

3 new regression tests locked in (the exact real "9 to 17h"/"9:00 to 22:00" strings, the bare-number-still-rejected case, the `stary.at` false positive). `npm run verify` clean.

## 18. Deterministic price validator, event research, and an honest scope boundary (2026-08-22)

Continuing the same pass, two more real gaps were closed with the same discipline (real data, real bugs, regression tests):

- **`price-guard.ts`** — prices previously had no validation beyond a schema-level 0–100,000 numeric range. Added a guard mirroring the hours guard: rejects a price not textually present in the source, distinguishes a "from €X" minimum and a child/student/senior reduced fare from the standard price (multilingual labels), and rejects a price found near a stale update marker. Live-verified against the real Brama Poznania ICHOT pricing page: the model correctly picked the page's standard 35 zł price over its own real, separate 29 zł reduced price, and the guard correctly labelled it `{status: "valid", priceType: "standard"}`. `StopProvenance` gained an optional `priceType` field.
- **`event-extraction.ts` + `event-guard.ts`** — a scoped slice of "event discovery": given a named event (`AutoplanRequest.eventQueries`), the same real search → fetch → extract chain applies, extracting ISO dates/times a deterministic validator checks (real calendar date, end not before start, textually supported — including a real multi-day range shorthand, "21-28.06.2026", where the day and month aren't adjacent digits and a naive check would have rejected it), and correctly refusing to schedule an event that has already ended. A validated event matching the trip date is geocoded and injected using the *existing, unmodified* `StopInput.fixedTime` mechanism — no changes to the optimizer itself. Live-verified twice against the real Malta Festival Poznań page through the actual `/api/itinerary/autoplan` endpoint: extraction matched its real dates exactly, and — since the real festival happened in June 2026 and this session's actual date is August 2026 — the guard correctly refused to schedule it as already-ended, proving the staleness protection works against real, current data, not just a mocked clock (the "scheduled" positive path is covered separately by unit tests using a mocked date, since no genuinely-upcoming real event was tested live this pass).

**Explicitly not attempted this pass, stated plainly rather than left implicit:** autonomous event *discovery* (finding events without being told what to look for — no free/self-hostable "what's on nearby" source exists for this stack to poll); restaurant menu-item modelling, local food discovery, and review intelligence (items requiring either a menu-specific extraction schema or a reviews data source this project has none for); the hidden-gem engine and route-aware second pass; weather-influenced planning; explicit departure-safety buffer calculation; delay simulation; multi-option (A/B/C) itinerary generation; a repeatable per-city OTP/GTFS provisioning tool (each additional city's transit graph remains a manual, documented process — see `infra/README.md`); and an actual `docker compose down && up -d` live restart-recovery test (the compose file is written and `docker compose config`-validated, but was not exercised end-to-end this pass). Each is a substantial, independently-testable feature in its own right; attempting shallow versions of all of them in the time remaining would have meant claiming far more breadth than was actually verified, which this project has held itself to a stricter standard than throughout.

19 new tests (`price-guard.test.ts`, `event-guard.test.ts`). `npm run verify` clean.

43 new tests across `opening-hours.test.ts` (20), `discovery-scoring.test.ts` (10), and `fact-extraction.test.ts` (16, including `htmlToPlainText` and the multilingual `looseTextToOsmSyntax` rewrite), including direct regressions for all live-discovered bugs — the real German/French/Polish/Turkish extraction strings from the verification pass above, evaluated exactly as extracted, no adjustment. `npm run verify` clean at 163 tests.

## 19. Production-hardening pass — transit request lifecycle, multi-city transit coverage, menu extraction reliability (2026-08-24)

Directed at exactly the real limitations the Priority-12 nine-city test surfaced, not new feature work: the transit-timeout/`maxDuration` mismatch, transit coverage limited to one city, and 1/9 menu-extraction success. No new Priority feature was started; every existing system this project has (deterministic optimizer, walking routing, opening-hours guard, price guard, confidence scoring, budget optimization, departure safety, delay simulation, hidden gems, weather, local food, A/B/C planning, direct official-source resolution, SearXNG resilience) is unchanged in behavior — verified by the full existing test suite staying green throughout (425/425 by the end) and by every real live test below going through those systems unmodified.

**§1 — transit request lifecycle.** Read Next.js 16's own bundled docs (`node_modules/next/dist/docs/`, since `AGENTS.md` explicitly requires it for this project) rather than guessing at deployment-platform behavior: `maxDuration` is a hint platforms like Vercel read from build output to enforce their own serverless function timeout — this project has no Vercel config, ships `"start": "next start"` (package.json), and its whole architecture (self-hosted Ollama needing a real GPU, OTP holding a whole city's graph in memory) is fundamentally incompatible with a serverless deploy target anyway. Confirmed empirically too: the same 4.7-minute Poznan request that motivated this section had run to completion locally with `maxDuration=90` set, unenforced. So the real risk was never "the platform kills it" — it was that a near-5-minute blocking HTTP response is fragile in production regardless (reverse-proxy read timeouts — nginx defaults to 60s, and infra's own self-hosting doc recommends nginx in front of this app; mobile NAT connection drops; zero resilience to a page reload or server restart mid-request; no progress feedback).

Fix: `POST /api/itinerary/autoplan` (and `.../options`) now create a job row against the existing, previously-unused `AiJob` table and run the real work via Next's `after()` (explicitly supported for both "Node.js server" and "Docker container" self-hosting per its own docs — this project's exact real shape), returning in under a second; `GET .../{jobId}` polls real live progress and the final result. Separately, live-measured the actual dominant cost driver behind the 4.7 minutes: `routeAndOptimize()` reruns the full OTP transit matrix on every reroute stage (routing, hidden-gem, budget, departure-safety) against a stop set that usually differs by one stop. Added a request-scoped transit-pair cache so a reroute only spends its real OTP-call budget on genuinely new pairs. **Measured, real, before/after:** Poznan 282s -> 152s (56/90 pairs cache-hit on the reroute stage); Berlin (a real, much bigger 864K-vertex/28K-stop graph) 138s; Prague 184s; Rome 62s — the job-creation HTTP response itself is under 1s in every case, independent of how long the real background work takes.

**§2 — multi-city transit coverage.** Ran the full real pipeline (discover OSM -> discover GTFS -> validate feed -> build OTP graph -> start OTP -> real transit query -> connect to Roamora -> verify transit-profile autoplan) for Berlin, Prague, and Rome, using the existing Priority-10 tooling (`scripts/provision-transit.ts`), extended with two real fixes found live: a fallback to the next ranked GTFS candidate when a download 404s (Berlin's top-ranked VBB entry was its dead GTFS-Flex variant; a second, regular VBB entry for the same real operator worked), and a real feed-staleness pre-flight (`feed_info.txt` -> `calendar.txt` -> `calendar_dates.txt`, in that order — the third fallback was itself added mid-pass after Rome's ATAC feed, which has no `calendar.txt` at all, silently produced walk-only routing for dates outside its real 2026-04-27–07-11 window until this was diagnosed). Also fixed a real bug in `activateCity()`: it never cleared `graph_dir/` before copying a new city in, so a second city's files sat alongside the first's stale `graph.obj`.

All three built real, working graphs (Berlin 3m10s/325MB/28,008 real stops; Prague 53s/114MB/17,700 stops; Rome 4m6s/458MB/8,370 stops) and were live-verified with real transit-profile autoplan requests through Roamora's own API — genuinely real local routes returned throughout, not fabricated: Berlin's tourist bus line "100" and S-Bahn "S3"; Prague's Metro "C" and regional rail "R19"; Rome's Termini-area metro/bus/tram network. Poznan (already working) re-verified unchanged. Amsterdam remains the one destination with no MobilityData-verified local feed (unchanged, honestly-reported finding from Priority 10 — not re-attempted, since nothing about the free catalog's Amsterdam coverage changed this pass). **4 of 5 tested cities now have real, live-verified OTP transit; the 5th honestly reports unavailable and falls back to walking, exactly as instructed — no feed was ever invented.**

**§3 — menu extraction reliability.** Priority 12 measured 1/9 real success with zero diagnostic detail on the other 8. Used that real failure data to find four distinct, independently real root causes (not four guesses) and fixed each without touching `isMenuItemNameSupported`, `isLikelyNavigationLabel`, or `validateExtractedPrice`:

- **PDF-only menus** fed to the LLM as raw-decoded binary garbage — real case, Berlin's "Jolly" (`Jolly-Speisekarte.pdf`, already correctly found by the existing crawler since "speisekarte" is in its own keyword list). Added `pdf-extraction.ts` (pdfjs-dist, no canvas dependency needed for text-only extraction) and `fetchTextOrPdfCapped()`; verified directly against the real production PDF — 767KB, 13 pages, 11,918 real characters, real dish names and real prices ("85,00 €" etc).
- **JS-rendered pages** that fetch fine but ship almost no real content were silently accepted, because the old accept check compared raw HTML byte length (always large for a JS shell), not real extractable text. Added `checkPageContent()`; live-confirmed against the two exact real regression cases — Prague's Matzip (48 real characters) and Amsterdam's FuLu Mandarijn, the exact real URL from Priority 12 (748 real characters, matching the originally-diagnosed 764) — both now honestly report `{status: "unavailable", reason: "...JS ile oluşturulmuş... N karakter gerçek metin..."}` instead of silently 0 items with no explanation.
- **Wrong-source selection**, a real, live-caught bug independent of menus specifically: `selectBestResult()` always returned SearXNG's top result even when nothing in the list had any real connection to the place — real case, searching `"Oseyo25" Poznan restaurant menu prices` surfaced a Microsoft Windows audio-troubleshooting support page, which then got used as this restaurant's research source. Added `hasNameRelevance()` as a hard relevance floor. Live-confirmed: Oseyo25 now correctly reports `source: "osm"` / no source found, instead of the Microsoft page.
- **Real schema.org Menu/MenuSection/MenuItem JSON-LD extraction** (`extractJsonLdMenuItems`), tried before the existing Ollama-based extractor — a zero-LLM-risk source many restaurant site builders emit even for otherwise JS-rendered pages. JSON-LD prices live inside `<script>` tags (stripped by `htmlToPlainText`), so they're trusted directly rather than run through the existing visible-text price guard, which would reject every genuine structured price for a reason unrelated to correctness; name/nav-label guards still apply. 7 new unit tests.

`RestaurantCandidateResult` gained `menuAvailability: {status, reason}` for honest, non-silent reporting. Live-tested against real restaurants in all 5 required cities (Poznan, Berlin, Prague, Rome, Amsterdam): every one now gets an honestly-diagnosed, specific status — two correctly identified as JS-rendered (with real character counts), two correctly identified as no-relevant-source-found (after the relevance-floor fix), one correctly identified as real-content-with-no-reliable-item. The PDF and JSON-LD extraction *mechanisms* are independently proven against real production data (the direct Jolly-PDF test, the unit tests); neither happened to be the specific source the live pipeline selected in this pass's 5-restaurant sample, since restaurant/source selection has real run-to-run variance — stated plainly rather than overclaimed.

**Regression discipline.** `npm run typecheck && npm run lint && npm run test && npm run build` run clean after every individual fix throughout this pass (final: 425/425 tests, 0 type errors, 0 lint errors — 13 pre-existing UI warnings unrelated to this work, unchanged). 3 commits, one per section above, each with the real live evidence in its message.

**Explicitly not attempted or only partially solved, stated plainly:** true simultaneous multi-city transit serving — OTP still serves exactly one active city's graph at a time (the existing Priority-10 architecture, `activateCity()`/`docker compose run otp --build`); running this app on a genuinely serverless platform (Vercel etc.) was not attempted or built for, since there is no evidence this project targets one and its architecture (self-hosted GPU inference, in-memory transit graphs) is incompatible with one regardless — if that ever changes, `after()`'s own background work would itself still be bounded by that platform's `maxDuration` for the same route, which a self-hosted deployment is not; a mid-run server restart still loses an in-flight async job (the existing `AiJob` table has no durable external worker behind it — `job-runner.ts`'s `getJob()` detects and reports a job stuck "running" past 15 minutes as failed, a bounded mitigation, not a fix); and the specific 5-restaurant live sample this pass tested did not happen to include a restaurant whose real, live source used JSON-LD structured data, so that path's real-world coverage rests on the direct unit tests and the schema.org convention it implements, not a live end-to-end hit.
