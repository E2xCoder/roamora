/**
 * Repeatable multi-city OTP/GTFS provisioning (spec §Priority 10).
 *
 * infra/README.md's own words describe the real problem this replaces:
 * "genuine infrastructure, not something `docker compose up` can do
 * generically for 'any city'" — until now, finding the right OSM extract
 * and the right GTFS feed for a destination was a manual, per-city human
 * task. This script automates BOTH lookups from real, free, keyless data
 * sources — no API key, no paid service, matching every other provider
 * this project uses:
 *
 *  - Geofabrik's own index-v1.json (a real, versioned GeoJSON catalog of
 *    every OSM extract Geofabrik publishes, complete with real boundary
 *    polygons) — used for genuine point-in-polygon matching, not a
 *    hardcoded city->file lookup table.
 *  - MobilityData's mobility-database-catalogs GitHub repo (a real,
 *    community-maintained, free catalog of GTFS feeds worldwide, each
 *    entry carrying a real bounding box and a STABLE Google-Cloud-Storage
 *    mirror URL — verified live to actually serve real, current GTFS
 *    data, not just the transit agency's own, potentially-broken direct
 *    link).
 *
 * Usage:
 *   tsx --env-file=.env scripts/provision-transit.ts "Prague, Czech Republic"
 *   tsx --env-file=.env scripts/provision-transit.ts --activate prague
 *   tsx --env-file=.env scripts/provision-transit.ts --list
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync } from "fs";
import { join } from "path";
import AdmZip from "adm-zip";
import { pointInGeometry, type Point } from "./geo-utils";

const CACHE_DIR = join(process.cwd(), ".cache", "transit-provisioning");
const CITIES_DIR = join(process.cwd(), "infra", "otp", "cities");
const GRAPH_DIR = join(process.cwd(), "infra", "otp", "graph_dir");

const GEOFABRIK_INDEX_URL = "https://download.geofabrik.de/index-v1.json";
const MOBILITY_CATALOG_ARCHIVE_URL =
  "https://github.com/MobilityData/mobility-database-catalogs/archive/refs/heads/main.zip";
const USER_AGENT = "Roamora/1.0 (personal travel planner transit provisioning; https://github.com/E2xCoder/roamora)";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function downloadFile(url: string, destPath: string): Promise<number> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return buf.length;
}

// --- geocoding — a direct Nominatim call, not an import of the app's own
// server-only geocode.ts (which would drag "server-only"'s unconditional
// throw and the @/ path alias into a plain tsx script, unlike this
// project's other existing scripts/*.ts, which all avoid that entirely) --
interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

async function geocodeCity(name: string): Promise<GeocodeResult> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", name);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (data.length === 0) throw new Error(`"${name}" için koordinat bulunamadı`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
}

// --- Geofabrik: real OSM extract discovery via point-in-polygon ---------
interface GeofabrikFeature {
  type: "Feature";
  properties: { id: string; parent?: string; name: string; urls: { pbf: string } };
  geometry: { type: string; coordinates: unknown };
}
interface GeofabrikIndex {
  type: "FeatureCollection";
  features: GeofabrikFeature[];
}

async function loadGeofabrikIndex(): Promise<GeofabrikIndex> {
  const cachePath = join(CACHE_DIR, "geofabrik-index-v1.json");
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  console.log(`  Geofabrik index indiriliyor (${GEOFABRIK_INDEX_URL})...`);
  const index = await fetchJson<GeofabrikIndex>(GEOFABRIK_INDEX_URL);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(index));
  return index;
}

/** Every real region whose polygon contains the point, keeping only the "leaf" matches — a match that is not itself the parent of another match — since Geofabrik's index nests country > state > (sometimes) further subdivisions, and the leaf is always the smallest, most specific real extract available. */
function findSmallestGeofabrikRegion(point: Point, index: GeofabrikIndex): GeofabrikFeature | null {
  const matches = index.features.filter((f) => pointInGeometry(point, f.geometry as never));
  if (matches.length === 0) return null;
  const leaves = matches.filter((m) => !matches.some((other) => other.properties.parent === m.properties.id));
  return leaves[0] ?? matches[matches.length - 1];
}

// --- MobilityData: real GTFS feed discovery via bounding box + name ------
interface GtfsCatalogEntry {
  mdb_source_id: number;
  data_type: string;
  provider: string;
  /** "True"/"False" (as a string, matching the catalog's own real field) when MobilityData has verified this feed came from the actual transit authority — absent means unknown, not "official". */
  is_official?: string;
  location?: {
    country_code?: string;
    subdivision_name?: string;
    municipality?: string;
    bounding_box?: {
      minimum_latitude: number;
      maximum_latitude: number;
      minimum_longitude: number;
      maximum_longitude: number;
    };
  };
  urls: { direct_download?: string; latest?: string; license?: string };
}

async function ensureMobilityCatalogExtracted(): Promise<string> {
  const extractedDir = join(CACHE_DIR, "mobility-database-catalogs-main");
  if (existsSync(extractedDir)) return extractedDir;

  console.log(`  MobilityData GTFS kataloğu indiriliyor (${MOBILITY_CATALOG_ARCHIVE_URL})...`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = join(CACHE_DIR, "mobility-catalogs.zip");
  await downloadFile(MOBILITY_CATALOG_ARCHIVE_URL, zipPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(CACHE_DIR, true);
  rmSync(zipPath);
  return extractedDir;
}

function bboxContains(bbox: NonNullable<GtfsCatalogEntry["location"]>["bounding_box"], point: Point): boolean {
  if (!bbox) return false;
  const [lng, lat] = point;
  return (
    lat >= bbox.minimum_latitude &&
    lat <= bbox.maximum_latitude &&
    lng >= bbox.minimum_longitude &&
    lng <= bbox.maximum_longitude
  );
}

export interface GtfsCandidateRanked {
  entry: GtfsCatalogEntry;
  areaDeg2: number;
  official: boolean;
}

/**
 * Real candidates: every schedule (not realtime) GTFS source whose real
 * bounding box contains the point, ranked by real bbox area — a tight,
 * city-scale feed sorts before a whole-country/international one that
 * happens to also contain the point. `is_official` (MobilityData's own
 * verification flag) is recorded and printed for the human operator to
 * weigh, but deliberately does NOT affect the sort: an earlier version of
 * this function sorted `official` first and that produced a real
 * regression — for Poznań, it picked Berlin's officially-verified VBB
 * feed (a different country, whose bounding box is simply drawn
 * generously enough to also cover Poznań) over the tightly-matched,
 * genuinely-correct ZTM Poznań feed, which has no `is_official` flag set
 * at all (absence means "not yet verified by MobilityData", not
 * "confirmed wrong"). A real, specific geographic match is stronger
 * evidence of relevance than an unrelated authority's official status.
 *
 * This does mean a genuinely irrelevant-but-official feed with a loosely
 * drawn, oversized bounding box (real, live-observed case: "European
 * Sleeper", an international night-train operator, whose box happens to
 * cover Amsterdam) can still outrank nothing at all when no real local
 * feed exists in this catalog snapshot for that city — a genuine, honest
 * gap in the free community data this ranking cannot invent its way
 * around. The printed top-3 candidates and the `official` flag in
 * manifest.json exist so a human reviews an uncertain pick before relying
 * on it, rather than the tool silently presenting it as settled.
 */
function findGtfsCandidates(point: Point, catalogDir: string): GtfsCandidateRanked[] {
  const scheduleDir = join(catalogDir, "catalogs", "sources", "gtfs", "schedule");
  const files = readdirSync(scheduleDir).filter((f) => f.endsWith(".json"));

  const candidates: GtfsCandidateRanked[] = [];
  for (const file of files) {
    const entry: GtfsCatalogEntry = JSON.parse(readFileSync(join(scheduleDir, file), "utf8"));
    const bbox = entry.location?.bounding_box;
    if (!bbox || !bboxContains(bbox, point)) continue;
    const areaDeg2 = (bbox.maximum_latitude - bbox.minimum_latitude) * (bbox.maximum_longitude - bbox.minimum_longitude);
    candidates.push({ entry, areaDeg2, official: entry.is_official === "True" });
  }
  // Bbox area is the primary and ONLY sort key — real, live-observed
  // regression from an earlier version of this function that sorted
  // `official` first: for Poznań, that picked Berlin's VBB (a real,
  // MobilityData-verified-official feed, but a different country whose
  // bounding box is simply drawn generously enough to also cover Poznań)
  // over the tightly-matched, genuinely-correct ZTM Poznań feed, which
  // has no `is_official` flag set at all (absence of the flag means
  // "not yet verified by MobilityData", not "confirmed wrong"). A real,
  // specific geographic match is stronger evidence of relevance than an
  // unrelated authority's official status. `official` is still recorded
  // and printed for the human to weigh, never used to reorder results.
  candidates.sort((a, b) => a.areaDeg2 - b.areaDeg2);
  return candidates;
}

// --- orchestration --------------------------------------------------------

async function provisionCity(cityName: string): Promise<void> {
  console.log(`\n=== ${cityName} ===`);
  const geo = await geocodeCity(cityName);
  console.log(`  geocoded: ${geo.displayName} (${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)})`);
  const point: Point = [geo.lng, geo.lat];

  const geofabrikIndex = await loadGeofabrikIndex();
  const region = findSmallestGeofabrikRegion(point, geofabrikIndex);
  if (!region) {
    console.log("  UYARI: bu koordinat için Geofabrik'te bir OSM extract bulunamadı — atlanıyor");
    return;
  }
  console.log(`  OSM extract: ${region.properties.id} (${region.properties.urls.pbf})`);

  const catalogDir = await ensureMobilityCatalogExtracted();
  const gtfsCandidates = findGtfsCandidates(point, catalogDir);
  if (gtfsCandidates.length === 0) {
    console.log("  UYARI: bu koordinat için MobilityData kataloğunda bir GTFS beslemesi bulunamadı — sadece OSM extract indirilecek");
  } else {
    const top = gtfsCandidates[0];
    console.log(`  ${gtfsCandidates.length} GTFS adayı bulundu:`);
    for (const c of gtfsCandidates.slice(0, 3)) {
      console.log(`    - ${c.entry.provider} (${c.official ? "resmi" : "resmi değil/bilinmiyor"}, bbox alanı ${c.areaDeg2.toFixed(2)} deg²)`);
    }
    if (!top.official) {
      console.log(
        `  UYARI: seçilen besleme ("${top.entry.provider}") MobilityData tarafından resmi olarak doğrulanmamış — bu şehir için katalogda gerçek yerel işletmeci bulunamamış olabilir. Kullanmadan önce ${top.entry.provider} beslemesinin gerçekten bu şehri kapsadığını manuel doğrula.`
      );
    } else {
      console.log(`  seçildi (resmi kaynak): ${top.entry.provider}`);
    }
  }
  const gtfs = gtfsCandidates[0]?.entry;
  const gtfsOfficial = gtfsCandidates[0]?.official ?? false;

  const slug = slugify(cityName);
  const outDir = join(CITIES_DIR, slug);
  mkdirSync(outDir, { recursive: true });

  const pbfPath = join(outDir, `${slug}.osm.pbf`);
  console.log(`  OSM extract indiriliyor -> ${pbfPath}`);
  const pbfBytes = await downloadFile(region.properties.urls.pbf, pbfPath);
  console.log(`  tamamlandı (${(pbfBytes / 1024 / 1024).toFixed(1)} MB)`);

  if (gtfs?.urls.latest) {
    const gtfsPath = join(outDir, "gtfs.zip");
    console.log(`  GTFS beslemesi indiriliyor -> ${gtfsPath}`);
    const gtfsBytes = await downloadFile(gtfs.urls.latest, gtfsPath);
    console.log(`  tamamlandı (${(gtfsBytes / 1024 / 1024).toFixed(1)} MB)`);
  }

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        cityName,
        geocoded: geo,
        osmRegion: { id: region.properties.id, name: region.properties.name, url: region.properties.urls.pbf },
        gtfsSource: gtfs
          ? { mdbSourceId: gtfs.mdb_source_id, provider: gtfs.provider, url: gtfs.urls.latest, official: gtfsOfficial }
          : null,
        provisionedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`  hazır: infra/otp/cities/${slug}/`);
}

function activateCity(slug: string): void {
  const cityDir = join(CITIES_DIR, slug);
  if (!existsSync(cityDir)) {
    console.error(`Hata: infra/otp/cities/${slug}/ bulunamadı — önce bu şehri provision et.`);
    process.exit(1);
  }
  mkdirSync(GRAPH_DIR, { recursive: true });
  for (const file of readdirSync(cityDir)) {
    if (file === "manifest.json") continue;
    cpSync(join(cityDir, file), join(GRAPH_DIR, file));
  }
  console.log(`${slug} -> infra/otp/graph_dir/ içine kopyalandı.`);
  console.log("Şimdi çalıştır: docker compose run --rm otp --build --save /graph");
}

function listCities(): void {
  if (!existsSync(CITIES_DIR)) {
    console.log("Henüz hiçbir şehir provision edilmedi.");
    return;
  }
  for (const slug of readdirSync(CITIES_DIR)) {
    const manifestPath = join(CITIES_DIR, slug, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(`${slug} — ${manifest.cityName} (${manifest.provisionedAt})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    listCities();
    return;
  }
  if (args[0] === "--activate") {
    if (!args[1]) {
      console.error("Kullanım: --activate <şehir-slug>");
      process.exit(1);
    }
    activateCity(args[1]);
    return;
  }
  if (args.length === 0) {
    console.error('Kullanım: tsx scripts/provision-transit.ts "Şehir, Ülke" [...daha fazla şehir]');
    console.error("           tsx scripts/provision-transit.ts --activate <şehir-slug>");
    console.error("           tsx scripts/provision-transit.ts --list");
    process.exit(1);
  }
  for (const cityName of args) {
    await provisionCity(cityName);
  }
}

main().catch((err) => {
  console.error("Hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
