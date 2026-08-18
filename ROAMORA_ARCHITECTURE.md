# ROAMORA — Current Architecture (Audit)

**Audit date:** 2026-08-18
**Commit audited:** `fe318f9`
**Method:** static inspection of the repository plus live probes against the running dev server and both SQLite files.

This document describes the system **as it exists today**, not as it should be. Target state lives in `ROAMORA_ROADMAP.md`.

---

## 1. Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router, Turbopack) | 16.3.0 | `AGENTS.md` warns this version diverges from older conventions |
| UI | React | 19.2.8 | |
| Language | TypeScript | 5.x | `strict` via `next/tsconfig` |
| Styling | Tailwind CSS | v4 (`@tailwindcss/postcss`) | CSS-variable theming in `globals.css`, no `tailwind.config.ts` |
| Map | Leaflet + react-leaflet | 1.9.4 / 5.0.0 | Carto Voyager raster tiles |
| Clustering | supercluster | 9.0.0 | |
| ORM | Prisma | 7.9.1 | driver-adapter mode |
| DB driver | better-sqlite3 via `@prisma/adapter-better-sqlite3` | 13.0.3 | |
| Icons | lucide-react | 1.31.0 | |
| LLM | Ollama (raw `fetch`) | — | `ollama` npm package installed but **never imported** |

**Absent entirely:** authentication, object/file storage layer, provider abstraction, caching layer, background jobs, validation schemas, tests, CI.

`package.json` scripts: `dev`, `build`, `start`, `lint`. No `typecheck`, `test`, `db:migrate`, or `db:seed`.

---

## 2. Directory map

```
src/
  app/
    layout.tsx            shell: <main> + BottomNav + ServiceWorkerRegistrar
    page.tsx              MAP screen (full-screen map, bottom sheet, route builder)
    explore/page.tsx      Overpass + Wikivoyage search
    plan/page.tsx         trips list + AI trip generation
    hiking/page.tsx       Waymarked trail search (external links only)
    import/page.tsx       Google Takeout CSV/JSON upload
    api/
      places/route.ts         GET (all rows) / POST
      places/[id]/route.ts    PUT / DELETE
      trips/route.ts          GET / POST (AI generation)
      trips/[id]/route.ts     GET / DELETE
      extract/route.ts        POST (analyse URL) / PUT (save)
      route/route.ts          POST (OSRM routing)
      explore/route.ts        GET (Overpass | Wikivoyage)
      hiking/route.ts         GET (Waymarked | Overpass)
      hiking/[id]/route.ts    GET (detail|geometry|elevation)  ← never called by UI
      import/route.ts         POST (Google Takeout)
  components/
    MapView.tsx           Leaflet map, clustering, route layer, live GPS
    BottomNav.tsx         mobile bottom bar / desktop side rail
    PlaceCard.tsx         place list card
    ExtractPanel.tsx      URL paste + confirm form
    RoutePanel.tsx        route summary, legs, profile switch, reorder
    AddPlaceModal.tsx     manual place creation
    ServiceWorkerRegistrar.tsx
  lib/
    db.ts                 Prisma singleton
    place-meta.ts         shared category colours/emoji, Place type, haversine, formatters
    extract-place.ts      yt-dlp wrapper, text patterns, Ollama, Nominatim
    ai-planner.ts         Ollama trip planning + fabricated fallback
    overpass.ts           Overpass API client
    wikivoyage.ts         Wikivoyage API client
    waymarked.ts          Waymarked Trails API client
    google-import.ts      Takeout parsers + Nominatim geocoding
  types/index.ts          form types, Overpass types, CATEGORIES, TRIP_PREFERENCES
  generated/prisma/       Prisma client output (gitignored)
prisma/schema.prisma
prisma/dev.db             ← live data (9320 places)
dev.db                    ← migration-tracked, empty
public/                   manifest.json, sw.js, icons/
scripts/
  seed-places.ts          Wikivoyage bulk seeder (creates tables via raw SQL)
  generate-icons.js       PWA icons via sharp
```

---

## 3. Data model (as implemented)

Five models in `prisma/schema.prisma`: `Place`, `Trip`, `TripDay`, `TripActivity`, `HikingTrail`.

`Place` columns: `id, name, lat, lng, category, tags (JSON string), notes, source, imageUrl, address, rating, isHiddenGem, createdAt, updatedAt`.

Structural characteristics:
- `tags` and `preferences` are **JSON strings**, not relations — not queryable.
- No `city`, `country`, `subcategory`, `confidence`, or any provenance field.
- No `Source` or `Media` entity. A place can hold exactly **one** `imageUrl` and **no** source URL — `/api/extract` accepts `sourceUrl` in its body and **silently discards it**.
- No unique constraint or index supporting deduplication.
- No geographic index.
- `HikingTrail` is **entirely dead** — never read or written anywhere in `src/`.

### Live data census

| DB file | Size | `_prisma_migrations` | Place | Trip | TripDay | TripActivity | HikingTrail |
|---|---|---|---|---|---|---|---|
| `prisma/dev.db` (**used by app**) | 4.0 MB | **absent** | **9320** | 0 | 0 | 0 | 0 |
| `dev.db` (**`DATABASE_URL` target**) | 56 KB | 1 row | 0 | 0 | 0 | 0 | 0 |

All 9320 places: `source = 'wikivoyage'`. **Zero** have `imageUrl`.
Categories: attraction 3510, restaurant 1959, accommodation 1738, other 979, cafe 718, shopping 416.

**There is no user-saved content in this application. There is no media. `public/thumbnails/` does not exist.**

---

## 4. Critical defects

### D1 — Split-brain database *(blocks all schema evolution)*
`src/lib/db.ts` hardcodes the path:
```ts
const dbPath = path.join(process.cwd(), "prisma", "dev.db");
```
It ignores `DATABASE_URL`. Meanwhile `.env` and `prisma.config.ts` resolve to `<root>/dev.db`.

Consequence: the Prisma CLI's migration history lives in one file while all application data lives in another. `prisma migrate` can never modify live data — this is the root cause of the earlier "db push says in sync but the table doesn't exist" failures. `prisma/dev.db` was created by raw `CREATE TABLE` statements in `scripts/seed-places.ts` and therefore has no migration ledger at all.

### D2 — The core import loop is non-functional *(product-critical)*
Live probe, real TikTok URL:
```
POST /api/extract  →  200 OK in 181 ms
{"extracted":{"title":"","description":"","platform":"tiktok",
  "category":"attraction","sourceUrl":"..."},"needsConfirmation":true}
```
No title, no description, no place name, no coordinates, no thumbnail.

Cause chain: `yt-dlp` is **not installed** (verified) → `extractFromUrl` catches and continues with empty strings → AI fallback calls Ollama at `localhost:11434`, which is **not running** (verified) → returns empty.

The endpoint reports **HTTP 200**, so the UI shows an empty form the user must fill in by hand rather than an error naming the missing dependency. Violates spec §55 (show the failed stage) and §98 (no fake functionality).

### D3 — `/api/places` ships the entire table
No pagination, no bbox filter. The route reads `category`/`search` query params, but `page.tsx` calls bare `fetch("/api/places")` and filters all 9320 rows in the browser. Full dataset transferred on every load.

### D4 — Unbounded LLM prompt
`/api/trips` POST calls `prisma.place.findMany()` with **no filter** and passes every row into `generateTripPlan`. With 9320 places the prompt is far beyond any practical context window.

### D5 — Fabricated data in the planner fallback
`ai-planner.ts → generateFallbackPlan` emits activities named `"Explore {destination} - Activity {n}"` at **`lat: 0, lng: 0`** whenever Ollama is unreachable — which is the current state. Renders pins in the Gulf of Guinea. Direct violation of spec §98/§99.

### D6 — Errors reported as success
`/api/places` and `/api/trips` GET handlers catch exceptions and return `[]` with **status 200**. Database failures are indistinguishable from an empty database.

### D7 — Overpass queries miss most POIs
`getHiddenGems` and `searchPOIs` request only `node` elements. The majority of OSM POIs are `way`/`relation`. (`scripts/seed-places.ts` was fixed for this; `src/lib/overpass.ts` was not.)

### D8 — No input validation
Every POST/PUT handler consumes `await request.json()` and uses fields directly. No schema validation, no type guards, no size limits. `zod` is present transitively but unused and not a declared dependency.

### D9 — No provider abstraction, no caching
Hardcoded throughout: Ollama URL + `llama3.1:8b` model (2 sites), Nominatim (2 sites), Overpass, Waymarked, OSRM hosts. Nothing is configurable by environment. Identical geocodes and routes are re-fetched on every request; nothing is cached or persisted.

### D10 — No authentication, storage layer, or tests
Zero tests in the project. No auth despite spec §64. No storage abstraction for media.

---

## 5. Dead code inventory

| Item | Status |
|---|---|
| `HikingTrail` model | Never read or written. 0 rows. |
| `/api/hiking/[id]` | Functional endpoint; UI never calls it. Trail geometry is never drawn. |
| `overpass.searchPOIs` | No callers. |
| `wikivoyage.getDestinationSection` | No callers. |
| `waymarked.getTrailsByBbox` | Reachable via API; UI never uses it. |
| `overpass.searchHikingTrails` | Reachable via API; UI never uses it. |
| `ollama` npm package | Installed, never imported. |
| `Place.rating`, `Place.isHiddenGem` | Written on create; never read or displayed. |

The Hiking screen is a search box that links out to `waymarkedtrails.org`. No trail is stored, drawn, or associated with a trip.

---

## 6. Working functionality — must be preserved

Verified working during this audit:

- **Map + clustering.** supercluster + viewport culling reduce 9320 places to ~5–15 DOM markers. Cluster expansion, icon caching, category markers all function.
- **Routing (`/api/route`).** Genuinely working against public FOSSGIS OSRM. Verified: 3 Prague waypoints → 875 m / 702 s, 68-point street-following geometry, `fallback:false`. Foot vs car profiles return correctly different results (1.4 km/20 min vs 2.0 km/9 min). Straight-line fallback on provider failure.
- **Route rendering.** Three-layer glow polyline + numbered gold stop markers verified present in the DOM.
- **Live GPS component.** `watchPosition`, accuracy circle, heading arrow, follow-camera, 40 m arrival auto-advance. Code is correct; not yet validated on a physical device.
- **PWA scaffolding.** manifest, service worker (network-first API, cache-first tiles), generated icons, standalone meta.
- **Responsive shell.** Bottom bar on mobile, side rail on desktop. Verified at 375×812: no horizontal or vertical overflow on any of the five screens.
- **Wikivoyage + Waymarked clients.** Hit live APIs successfully.
- **Google Takeout import.** CSV and GeoJSON parsers, batched Nominatim geocoding with 1.1 s rate limiting.
- **Incremental list rendering.** 40 cards per page; reduced page DOM from 454 KB to 13.8 KB.

---

## 7. Environment & deployment

`.env` contains only `DATABASE_URL="file:./dev.db"` — and that value is ignored at runtime (D1). No `.env.example`. No deployment configuration, Dockerfile, or CI. `.gitignore` correctly excludes `.env*`, `*.db`, `.claude/`, `CLAUDE.md`, `AGENTS.md`, `/public/thumbnails/`, `/src/generated/prisma`.

Target runtime is a personal Ubuntu server (`npm run build && npm start`); development on Windows.

---

## 8. Assessment against the master specification

| Spec area | State |
|---|---|
| Place as rich entity (§4, §58) | ~15% of the specified fields exist. No provenance, confidence, city/country, or scores. |
| Sources (§15, §59) | **Absent.** Source URL accepted then discarded. |
| Media (§16, §60) | **Absent.** No storage layer, zero media rows. |
| Ingestion pipeline (§9–11) | Single-strategy, broken (D2). No OCR, no provider architecture. |
| Duplicate detection (§14) | **Absent.** |
| Classification (§13) | Keyword regex only. No taxonomy, no subcategory, no confidence. |
| Trips/itineraries (§19, §23) | Model exists; generation produces fabricated data (D5). |
| Route optimization (§21, §43) | **Absent.** No optimizer — stop order is whatever the user clicked. |
| Live GPS (§25) | Component built, unverified on device. |
| Hiking/Komoot/GPX (§27, §28) | Search-and-link only. No GPX, no Komoot, no geometry. |
| Destination research (§29–34) | **Absent.** |
| Flights (§35–37) | **Absent.** |
| AI tool layer (§39, §40) | **Absent.** |
| PWA (§9) | Scaffolding present; share-target absent. |
| Auth/security (§64) | **Absent.** |
| Tests (§84) | **Absent.** |
| Provider abstraction (§66) | **Absent.** |

The current repository is roughly a **Phase-2 skeleton with a working map and router**. The distinguishing features of Roamora — sources, media, confidence, deduplication, optimization, research — are not yet present.
