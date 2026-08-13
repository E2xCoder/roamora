import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");

const rawDb = new Database(dbPath);
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS "Place" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "imageUrl" TEXT,
    "address" TEXT,
    "rating" REAL,
    "isHiddenGem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "destination" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "preferences" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS "TripDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    CONSTRAINT "TripDay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE TABLE IF NOT EXISTS "TripActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripDayId" TEXT NOT NULL,
    "placeId" TEXT,
    "placeName" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "timeSlot" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "TripActivity_tripDayId_fkey" FOREIGN KEY ("tripDayId") REFERENCES "TripDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TripActivity_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  );
  CREATE TABLE IF NOT EXISTS "HikingTrail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "osmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "distanceKm" REAL,
    "difficulty" TEXT,
    "elevationGain" INTEGER,
    "description" TEXT,
    "geometry" TEXT NOT NULL,
    "trailType" TEXT NOT NULL DEFAULT 'regional',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "HikingTrail_osmId_key" ON "HikingTrail"("osmId");
`);
rawDb.close();

const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

const OVERPASS_API = "https://overpass-api.de/api/interpreter";
const WIKI_API = "https://en.wikivoyage.org/w/api.php";

// Region-based bounding boxes: [south, west, north, east]
const REGIONS: { name: string; country: string; bbox: [number, number, number, number] }[] = [
  // TURKEY - split into regions for manageable queries
  { name: "Turkey West (Istanbul, Bursa, Canakkale)", country: "Turkey", bbox: [39.5, 26.0, 42.1, 30.5] },
  { name: "Turkey Aegean (Izmir, Bodrum, Ephesus)", country: "Turkey", bbox: [36.5, 26.0, 39.5, 29.5] },
  { name: "Turkey Mediterranean (Antalya, Fethiye, Kas)", country: "Turkey", bbox: [36.0, 29.0, 37.5, 33.0] },
  { name: "Turkey Central (Cappadocia, Ankara, Konya)", country: "Turkey", bbox: [37.0, 30.5, 41.0, 36.0] },
  { name: "Turkey East (Trabzon, Kackar, Mardin)", country: "Turkey", bbox: [37.0, 36.0, 41.5, 44.8] },

  // ITALY
  { name: "Italy North (Milan, Venice, Dolomites, Como)", country: "Italy", bbox: [44.5, 6.6, 47.1, 13.8] },
  { name: "Italy Central (Rome, Florence, Tuscany)", country: "Italy", bbox: [41.5, 9.5, 44.5, 14.5] },
  { name: "Italy South (Naples, Amalfi, Puglia)", country: "Italy", bbox: [39.5, 14.0, 41.5, 18.6] },
  { name: "Italy Islands (Sicily, Sardinia)", country: "Italy", bbox: [36.5, 8.0, 41.3, 15.7] },

  // SPAIN
  { name: "Spain Northeast (Barcelona, Girona)", country: "Spain", bbox: [40.5, 0.0, 43.5, 3.5] },
  { name: "Spain Central (Madrid, Toledo, Salamanca)", country: "Spain", bbox: [38.5, -6.0, 41.5, -1.5] },
  { name: "Spain South (Seville, Granada, Malaga, Ronda)", country: "Spain", bbox: [36.0, -7.5, 38.5, -1.5] },
  { name: "Spain North (Bilbao, San Sebastian, Santiago)", country: "Spain", bbox: [41.5, -9.5, 43.8, -1.5] },
  { name: "Spain East (Valencia, Alicante)", country: "Spain", bbox: [37.5, -1.5, 40.5, 0.5] },
  { name: "Spain Islands (Mallorca, Ibiza)", country: "Spain", bbox: [38.5, 1.0, 40.1, 4.5] },
  { name: "Canary Islands", country: "Spain", bbox: [27.5, -18.5, 29.5, -13.3] },

  // FRANCE
  { name: "France Paris & North", country: "France", bbox: [47.5, 0.5, 51.1, 4.0] },
  { name: "France Riviera & Provence", country: "France", bbox: [43.0, 4.5, 44.5, 7.8] },
  { name: "France Alps (Chamonix, Annecy)", country: "France", bbox: [44.5, 5.5, 46.5, 7.8] },
  { name: "France Southwest (Bordeaux, Toulouse, Carcassonne)", country: "France", bbox: [42.5, -2.0, 45.5, 2.5] },
  { name: "France West (Nantes, Mont Saint-Michel, Brittany)", country: "France", bbox: [46.5, -5.2, 49.0, 0.0] },
  { name: "France East (Strasbourg, Colmar, Alsace)", country: "France", bbox: [47.5, 6.5, 49.0, 8.3] },
  { name: "Corsica", country: "France", bbox: [41.3, 8.5, 43.1, 9.6] },

  // GERMANY
  { name: "Germany Berlin & East", country: "Germany", bbox: [50.5, 11.5, 54.5, 15.1] },
  { name: "Germany Bavaria (Munich, Nuremberg)", country: "Germany", bbox: [47.2, 9.5, 50.5, 13.8] },
  { name: "Germany West (Cologne, Frankfurt, Heidelberg)", country: "Germany", bbox: [49.0, 6.0, 52.0, 10.0] },
  { name: "Germany North (Hamburg, Lubeck)", country: "Germany", bbox: [52.5, 8.0, 55.1, 14.5] },
  { name: "Germany Southwest (Black Forest, Freiburg, Stuttgart)", country: "Germany", bbox: [47.2, 7.0, 49.5, 10.0] },

  // AUSTRIA
  { name: "Austria (Vienna, Salzburg, Innsbruck, Hallstatt)", country: "Austria", bbox: [46.3, 9.5, 49.0, 17.2] },

  // SWITZERLAND
  { name: "Switzerland", country: "Switzerland", bbox: [45.8, 5.9, 47.9, 10.5] },

  // PORTUGAL
  { name: "Portugal", country: "Portugal", bbox: [36.9, -9.6, 42.2, -6.2] },
  { name: "Madeira", country: "Portugal", bbox: [32.3, -17.3, 33.2, -16.2] },
  { name: "Azores", country: "Portugal", bbox: [36.9, -31.3, 39.8, -25.0] },

  // GREECE
  { name: "Greece Mainland (Athens, Meteora, Delphi)", country: "Greece", bbox: [37.5, 20.5, 41.8, 24.0] },
  { name: "Greece Islands (Santorini, Mykonos, Crete, Rhodes)", country: "Greece", bbox: [34.5, 23.0, 38.5, 29.5] },
  { name: "Greece North (Thessaloniki)", country: "Greece", bbox: [38.5, 22.0, 41.8, 26.5] },

  // CROATIA
  { name: "Croatia", country: "Croatia", bbox: [42.3, 13.5, 46.6, 19.5] },

  // CZECHIA
  { name: "Czechia", country: "Czechia", bbox: [48.5, 12.1, 51.1, 18.9] },

  // HUNGARY
  { name: "Hungary", country: "Hungary", bbox: [45.7, 16.1, 48.6, 22.9] },

  // POLAND
  { name: "Poland South (Krakow, Zakopane, Wroclaw)", country: "Poland", bbox: [49.0, 14.1, 52.0, 22.0] },
  { name: "Poland North (Warsaw, Gdansk)", country: "Poland", bbox: [52.0, 14.1, 55.0, 24.2] },

  // NETHERLANDS
  { name: "Netherlands", country: "Netherlands", bbox: [51.3, 3.3, 53.6, 7.3] },

  // BELGIUM
  { name: "Belgium", country: "Belgium", bbox: [49.5, 2.5, 51.6, 6.4] },

  // SCANDINAVIA
  { name: "Denmark", country: "Denmark", bbox: [54.5, 8.0, 57.8, 15.2] },
  { name: "Sweden South (Stockholm, Gothenburg)", country: "Sweden", bbox: [55.3, 11.0, 60.5, 19.2] },
  { name: "Sweden North (Lapland, Abisko)", country: "Sweden", bbox: [63.0, 14.0, 69.1, 24.2] },
  { name: "Norway South (Oslo, Bergen, Fjords)", country: "Norway", bbox: [57.9, 4.5, 63.0, 15.5] },
  { name: "Norway North (Lofoten, Tromso)", country: "Norway", bbox: [66.0, 12.0, 71.2, 31.2] },
  { name: "Finland South (Helsinki)", country: "Finland", bbox: [59.7, 21.0, 64.0, 30.5] },
  { name: "Finland North (Rovaniemi, Lapland)", country: "Finland", bbox: [64.0, 24.0, 70.1, 30.0] },
  { name: "Iceland West (Reykjavik, Golden Circle)", country: "Iceland", bbox: [63.3, -24.6, 66.6, -18.0] },
  { name: "Iceland East", country: "Iceland", bbox: [63.3, -18.0, 66.6, -13.5] },
  { name: "Faroe Islands", country: "Denmark", bbox: [61.3, -7.5, 62.5, -6.2] },

  // BALTICS
  { name: "Estonia", country: "Estonia", bbox: [57.5, 21.7, 59.7, 28.2] },
  { name: "Latvia", country: "Latvia", bbox: [55.6, 20.9, 58.1, 28.3] },
  { name: "Lithuania", country: "Lithuania", bbox: [53.9, 20.9, 56.5, 26.9] },

  // BALKANS
  { name: "Slovenia", country: "Slovenia", bbox: [45.4, 13.3, 46.9, 16.6] },
  { name: "Montenegro", country: "Montenegro", bbox: [41.8, 18.4, 43.6, 20.4] },
  { name: "Bosnia & Herzegovina", country: "Bosnia", bbox: [42.5, 15.7, 45.3, 19.7] },
  { name: "Serbia", country: "Serbia", bbox: [42.2, 18.8, 46.2, 23.1] },
  { name: "North Macedonia", country: "North Macedonia", bbox: [40.8, 20.4, 42.4, 23.1] },
  { name: "Albania", country: "Albania", bbox: [39.6, 19.2, 42.7, 21.1] },
  { name: "Kosovo", country: "Kosovo", bbox: [41.8, 20.0, 43.3, 21.8] },

  // ROMANIA & BULGARIA
  { name: "Romania West (Transylvania, Brasov, Sibiu)", country: "Romania", bbox: [44.5, 22.0, 47.5, 26.5] },
  { name: "Romania East (Bucharest, Black Sea)", country: "Romania", bbox: [43.5, 26.0, 48.3, 30.0] },
  { name: "Bulgaria", country: "Bulgaria", bbox: [41.2, 22.3, 44.2, 28.7] },

  // UK & IRELAND
  { name: "England South (London, Bath, Oxford, Cotswolds)", country: "UK", bbox: [50.5, -3.5, 52.5, 1.5] },
  { name: "England North (York, Lake District, Liverpool)", country: "UK", bbox: [52.5, -3.5, 55.8, 0.0] },
  { name: "Scotland", country: "UK", bbox: [54.6, -8.0, 58.7, -0.7] },
  { name: "Wales", country: "UK", bbox: [51.3, -5.4, 53.5, -2.6] },
  { name: "Northern Ireland", country: "UK", bbox: [53.9, -8.2, 55.4, -5.4] },
  { name: "Ireland", country: "Ireland", bbox: [51.3, -10.7, 55.5, -5.9] },

  // SMALL COUNTRIES
  { name: "Luxembourg", country: "Luxembourg", bbox: [49.4, 5.7, 50.2, 6.6] },
  { name: "Malta", country: "Malta", bbox: [35.8, 14.1, 36.1, 14.6] },
  { name: "Cyprus", country: "Cyprus", bbox: [34.5, 32.2, 35.7, 34.6] },
  { name: "Monaco & surroundings", country: "Monaco", bbox: [43.7, 7.3, 43.8, 7.5] },
  { name: "San Marino", country: "San Marino", bbox: [43.88, 12.38, 43.99, 12.52] },
  { name: "Andorra", country: "Andorra", bbox: [42.4, 1.4, 42.7, 1.8] },
  { name: "Liechtenstein", country: "Liechtenstein", bbox: [47.04, 9.47, 47.27, 9.64] },

  // MOROCCO (close to Europe, popular destination)
  { name: "Morocco North (Chefchaouen, Fez, Tangier)", country: "Morocco", bbox: [33.5, -6.5, 36.0, -4.0] },
  { name: "Morocco Marrakech & Atlas", country: "Morocco", bbox: [30.5, -9.0, 33.5, -6.5] },
];

function categorize(tags: Record<string, string>): string {
  const t = tags;
  if (t.tourism === "viewpoint" || t.natural === "peak") return "viewpoint";
  if (t.tourism === "museum" || t.tourism === "gallery") return "museum";
  if (t.amenity === "place_of_worship" || t.building === "church" || t.building === "mosque" || t.building === "cathedral") return "historic";
  if (t.historic === "castle" || t.historic === "fort" || t.historic === "ruins" || t.historic === "archaeological_site" || t.historic === "monument" || t.historic === "memorial" || t.historic === "city_gate") return "historic";
  if (t.historic) return "historic";
  if (t.natural === "beach" || t.leisure === "beach_resort") return "beach";
  if (t.natural === "waterfall" || t.natural === "cave_entrance" || t.natural === "hot_spring" || t.natural === "spring" || t.natural === "arch" || t.natural === "cliff" || t.natural === "glacier") return "nature";
  if (t.natural === "volcano") return "nature";
  if (t.natural || t.leisure === "park" || t.leisure === "garden" || t.leisure === "nature_reserve" || t.boundary === "national_park") return "nature";
  if (t.tourism === "attraction" || t.tourism === "artwork") return "attraction";
  if (t.amenity === "restaurant") return "restaurant";
  if (t.amenity === "cafe") return "cafe";
  if (t.amenity === "bar" || t.amenity === "pub" || t.amenity === "nightclub") return "nightlife";
  if (t.tourism === "hotel" || t.tourism === "hostel" || t.tourism === "guest_house" || t.tourism === "camp_site") return "accommodation";
  if (t.shop === "mall" || t.amenity === "marketplace") return "shopping";
  if (t.tourism) return "attraction";
  return "other";
}

function isHiddenGem(tags: Record<string, string>): boolean {
  if (tags.tourism === "viewpoint") return true;
  if (tags.natural && ["waterfall", "cave_entrance", "peak", "hot_spring", "spring", "arch", "cliff", "glacier", "volcano"].includes(tags.natural)) return true;
  if (tags.historic === "ruins" || tags.historic === "archaeological_site") return true;
  if (tags.historic === "castle" || tags.historic === "fort") return true;
  if (tags.leisure === "nature_reserve" || tags.boundary === "national_park") return true;
  return false;
}

interface OverpassElement {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function fetchRegionPOIs(bbox: [number, number, number, number]): Promise<OverpassElement[]> {
  const [south, west, north, east] = bbox;
  const b = `${south},${west},${north},${east}`;

  const q = `[out:json][timeout:90];
(
  node["tourism"~"attraction|viewpoint|museum|gallery|artwork"]["name"](${b});
  way["tourism"~"attraction|viewpoint|museum|gallery|artwork"]["name"](${b});
  node["historic"]["name"](${b});
  way["historic"]["name"](${b});
  node["natural"~"waterfall|cave_entrance|peak|hot_spring|spring|arch|cliff|beach|glacier|volcano"]["name"](${b});
  way["natural"~"waterfall|cave_entrance|beach|cliff|glacier"]["name"](${b});
  node["leisure"~"park|garden|nature_reserve"]["name"](${b});
  way["leisure"~"park|garden|nature_reserve"]["name"](${b});
  relation["leisure"="nature_reserve"]["name"](${b});
  relation["boundary"="national_park"]["name"](${b});
  node["amenity"="place_of_worship"]["name"]["tourism"](${b});
  way["amenity"="place_of_worship"]["name"]["tourism"](${b});
  node["amenity"="place_of_worship"]["name"]["heritage"](${b});
  way["amenity"="place_of_worship"]["name"]["heritage"](${b});
  node["amenity"~"restaurant|cafe|bar"]["name"]["cuisine"](${b});
  way["tourism"~"hotel|hostel|guest_house|camp_site"]["name"]["stars"](${b});
  node["tourism"="camp_site"]["name"](${b});
);
out center body;`;

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    body: `data=${encodeURIComponent(q)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  Overpass error ${res.status}: ${text.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  return data.elements || [];
}

async function fetchWikivoyageForRegion(regionName: string, country: string) {
  const cities = regionName
    .replace(/\(([^)]+)\)/, "$1")
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && !s.includes("&") && !s.includes("South") && !s.includes("North") && !s.includes("West") && !s.includes("East") && !s.includes("Islands"));

  const searchTerms = cities.length > 0 ? cities.slice(0, 3) : [country];
  const allListings: Array<{
    name: string;
    lat?: number;
    lng?: number;
    address?: string;
    description?: string;
    type: string;
  }> = [];

  for (const term of searchTerms) {
    try {
      const searchParams = new URLSearchParams({
        action: "query", list: "search", srsearch: term,
        srnamespace: "0", srlimit: "1", format: "json", origin: "*",
      });
      const searchRes = await fetch(`${WIKI_API}?${searchParams}`);
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();
      const results = searchData.query?.search;
      if (!results || results.length === 0) continue;

      const contentParams = new URLSearchParams({
        action: "parse", page: results[0].title, prop: "wikitext",
        format: "json", origin: "*",
      });
      const contentRes = await fetch(`${WIKI_API}?${contentParams}`);
      if (!contentRes.ok) continue;
      const contentData = await contentRes.json();
      const wikitext: string = contentData.parse?.wikitext?.["*"] || "";

      const listingRegex = /\{\{(?:listing|see|do|eat|drink|sleep|buy)\s*\|([^}]+)\}\}/gi;
      let match;
      while ((match = listingRegex.exec(wikitext)) !== null) {
        const params = match[1];
        const getParam = (key: string) => {
          const m = params.match(new RegExp(`${key}\\s*=\\s*([^|]+)`));
          return m ? m[1].trim() : undefined;
        };
        const name = getParam("name");
        if (!name) continue;
        const latStr = getParam("lat");
        const lngStr = getParam("long");
        if (!latStr || !lngStr) continue;

        allListings.push({
          name,
          lat: parseFloat(latStr),
          lng: parseFloat(lngStr),
          address: getParam("address"),
          description: getParam("content") || getParam("description"),
          type: match[0].match(/\{\{(\w+)/)?.[1] || "listing",
        });
      }

      await sleep(300);
    } catch {
      continue;
    }
  }

  return allListings;
}

function wikiTypeToCategory(type: string): string {
  switch (type.toLowerCase()) {
    case "see": return "attraction";
    case "do": return "attraction";
    case "eat": return "restaurant";
    case "drink": return "cafe";
    case "sleep": return "accommodation";
    case "buy": return "shopping";
    default: return "other";
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 25; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function main() {
  console.log(`\n=== Roamora Data Seeder ===`);
  console.log(`${REGIONS.length} regions to process\n`);

  let existingCount = 0;
  try {
    existingCount = await prisma.place.count();
  } catch { /* table might be empty */ }
  console.log(`Current places in DB: ${existingCount}\n`);

  // Load existing place keys for dedup
  let existingKeys = new Set<string>();
  try {
    const existing = await prisma.place.findMany({
      select: { name: true, lat: true, lng: true },
    });
    existingKeys = new Set(
      existing.map((p) => `${p.name.toLowerCase()}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`)
    );
  } catch { /* empty db */ }

  let totalAdded = 0;

  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i];
    console.log(`[${i + 1}/${REGIONS.length}] ${region.name} (${region.country})`);

    // Overpass query
    let elements: OverpassElement[] = [];
    try {
      elements = await fetchRegionPOIs(region.bbox);
      console.log(`  Overpass: ${elements.length} elements`);
    } catch (err) {
      console.error(`  Overpass failed:`, (err as Error).message);
    }

    // Rate limit for Overpass
    await sleep(1500);

    // Wikivoyage
    let wikiListings: Array<{
      name: string; lat?: number; lng?: number;
      address?: string; description?: string; type: string;
    }> = [];
    try {
      wikiListings = await fetchWikivoyageForRegion(region.name, region.country);
      if (wikiListings.length > 0) console.log(`  Wikivoyage: ${wikiListings.length} listings`);
    } catch {
      // ignore
    }

    // Process and deduplicate
    const seenNames = new Set<string>();
    const batch: Array<{
      id: string; name: string; lat: number; lng: number; category: string;
      tags: string; notes: string; source: string; address?: string; isHiddenGem: boolean;
    }> = [];

    for (const el of elements) {
      if (!el.tags?.name) continue;
      const name = el.tags.name;
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) continue;

      let lat = el.lat;
      let lng = el.lon;
      if (!lat || !lng) {
        if (el.center) {
          lat = el.center.lat;
          lng = el.center.lon;
        } else {
          continue;
        }
      }

      const dedupKey = `${nameKey}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
      if (existingKeys.has(dedupKey)) continue;

      seenNames.add(nameKey);
      existingKeys.add(dedupKey);

      const cat = categorize(el.tags);
      const tagsArr = [region.country];
      if (el.tags.cuisine) tagsArr.push(el.tags.cuisine);
      if (el.tags.historic) tagsArr.push(el.tags.historic);
      if (el.tags.natural) tagsArr.push(el.tags.natural);

      batch.push({
        id: generateId(),
        name,
        lat,
        lng,
        category: cat,
        tags: JSON.stringify(tagsArr),
        notes: el.tags.description || el.tags["description:en"] || "",
        source: "overpass",
        address: el.tags["addr:street"]
          ? `${el.tags["addr:street"]} ${el.tags["addr:housenumber"] || ""}`.trim()
          : undefined,
        isHiddenGem: isHiddenGem(el.tags),
      });
    }

    for (const listing of wikiListings) {
      if (!listing.lat || !listing.lng) continue;
      const nameKey = listing.name.toLowerCase();
      if (seenNames.has(nameKey)) continue;
      const dedupKey = `${nameKey}|${listing.lat.toFixed(3)}|${listing.lng.toFixed(3)}`;
      if (existingKeys.has(dedupKey)) continue;

      seenNames.add(nameKey);
      existingKeys.add(dedupKey);

      batch.push({
        id: generateId(),
        name: listing.name,
        lat: listing.lat,
        lng: listing.lng,
        category: wikiTypeToCategory(listing.type),
        tags: JSON.stringify([region.country, "wikivoyage"]),
        notes: listing.description || "",
        source: "wikivoyage",
        address: listing.address,
        isHiddenGem: false,
      });
    }

    // Bulk insert using raw SQLite for speed
    if (batch.length > 0) {
      const db = new Database(dbPath);
      const stmt = db.prepare(`INSERT OR IGNORE INTO "Place" (id, name, lat, lng, category, tags, notes, source, address, isHiddenGem, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);
      const insertMany = db.transaction((places: typeof batch) => {
        for (const p of places) {
          stmt.run(p.id, p.name, p.lat, p.lng, p.category, p.tags, p.notes, p.source, p.address || null, p.isHiddenGem ? 1 : 0);
        }
      });
      insertMany(batch);
      db.close();

      totalAdded += batch.length;
      console.log(`  -> Added ${batch.length} places`);
    } else {
      console.log(`  -> No new places`);
    }

    // Rate limit between regions
    if (i < REGIONS.length - 1) {
      await sleep(1000);
    }
  }

  const finalDb = new Database(dbPath);
  const finalCount = finalDb.prepare(`SELECT COUNT(*) as count FROM "Place"`).get() as { count: number };
  finalDb.close();

  console.log(`\n=== Done ===`);
  console.log(`Added: ${totalAdded} places`);
  console.log(`Total in DB: ${finalCount.count}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
