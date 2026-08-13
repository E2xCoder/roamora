import type { PlaceFormData } from "@/types";

interface GoogleSavedPlace {
  geometry?: {
    location?: { lat: number; lng: number };
  };
  location?: { latitudeE7?: number; longitudeE7?: number };
  name?: string;
  title?: string;
  address?: string;
  placeUrl?: string;
  comment?: string;
  note?: { text?: string };
}

interface GoogleTakeoutFeature {
  type: string;
  geometry: {
    type: string;
    coordinates: number[];
  };
  properties: {
    Title?: string;
    "Google Maps URL"?: string;
    Location?: {
      "Business Name"?: string;
      Address?: string;
      "Geo Coordinates"?: { Latitude: number; Longitude: number };
    };
    Published?: string;
    Updated?: string;
  };
}

interface GoogleTakeoutGeoJSON {
  type: string;
  features: GoogleTakeoutFeature[];
}

function guessCategory(name: string, address?: string): string {
  const lower = (name + " " + (address || "")).toLowerCase();
  if (/restaurant|ristorante|restoran|gaststätte|trattoria|bistro|miam/.test(lower)) return "restaurant";
  if (/cafe|café|coffee|kaffee|kahve|bar\b/.test(lower)) return "cafe";
  if (/museum|müze|galerie|gallery/.test(lower)) return "museum";
  if (/park|garden|garten|bahçe|forest|wald|valley|valley|tal\b/.test(lower)) return "nature";
  if (/castle|schloss|kale|şato|palace|palast|cathedral|kirche|church|mosque|cami|kilise|bazilika|chateau|château|fortress|cathedral|anıt/.test(lower)) return "historic";
  if (/beach|strand|plaj|sahil|plage|spiaggia/.test(lower)) return "beach";
  if (/viewpoint|aussicht|lookout|panorama|manzara|terrazza/.test(lower)) return "viewpoint";
  if (/trail|wanderweg|hiking|hike|trek|waterfall|wasserfall|şelale|cascade|falls|klamm|gorge|schlucht/.test(lower)) return "hiking";
  if (/bar\b|club|pub|nightclub|disco/.test(lower)) return "nightlife";
  if (/shop|market|bazaar|mall|store/.test(lower)) return "shopping";
  if (/hotel|hostel|airbnb|pension|motel|camping|resort/.test(lower)) return "accommodation";
  if (/lake|see\b|göl|lac\b|lago/.test(lower)) return "nature";
  if (/island|ada\b|isola|île/.test(lower)) return "nature";
  return "other";
}

export function parseGoogleTakeout(jsonContent: string): PlaceFormData[] {
  const data = JSON.parse(jsonContent);
  const places: PlaceFormData[] = [];

  if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
    const geojson = data as GoogleTakeoutGeoJSON;
    for (const feature of geojson.features) {
      const coords = feature.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;

      const name =
        feature.properties?.Location?.["Business Name"] ||
        feature.properties?.Title ||
        "Unknown Place";
      const address = feature.properties?.Location?.Address;

      places.push({
        name,
        lng: coords[0],
        lat: coords[1],
        category: guessCategory(name, address),
        tags: [],
        notes: "",
        source: "google",
        address,
      });
    }
    return places;
  }

  const items: GoogleSavedPlace[] = Array.isArray(data) ? data : data.features || data.items || [];
  for (const item of items) {
    let lat: number | undefined;
    let lng: number | undefined;

    if (item.geometry?.location) {
      lat = item.geometry.location.lat;
      lng = item.geometry.location.lng;
    } else if (item.location?.latitudeE7 != null) {
      lat = item.location.latitudeE7 / 1e7;
      lng = item.location.longitudeE7! / 1e7;
    }

    if (lat == null || lng == null) continue;

    const name = item.name || item.title || "Unknown Place";
    places.push({
      name,
      lat,
      lng,
      category: guessCategory(name, item.address),
      tags: [],
      notes: item.comment || item.note?.text || "",
      source: "google",
      address: item.address,
    });
  }

  return places;
}

export interface CsvPlace {
  name: string;
  note: string;
  url: string;
  tags: string;
  comment: string;
}

export function parseGoogleCsv(csvContent: string): CsvPlace[] {
  const lines = csvContent.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const places: CsvPlace[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const fields = parseCsvLine(line);
    const name = fields[0]?.trim();
    if (!name) continue;

    places.push({
      name,
      note: fields[1]?.trim() || "",
      url: fields[2]?.trim() || "",
      tags: fields[3]?.trim() || "",
      comment: fields[4]?.trim() || "",
    });
  }
  return places;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export async function geocodePlaces(
  csvPlaces: CsvPlace[],
  onProgress?: (done: number, total: number) => void
): Promise<PlaceFormData[]> {
  const results: PlaceFormData[] = [];
  const total = csvPlaces.length;

  for (let i = 0; i < csvPlaces.length; i++) {
    const place = csvPlaces[i];
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place.name)}&format=json&limit=1`,
        { headers: { "User-Agent": "Roamora/1.0" } }
      );
      const data = await res.json();

      if (data.length > 0) {
        results.push({
          name: place.name,
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          category: guessCategory(place.name),
          tags: place.tags ? place.tags.split(",").map((t: string) => t.trim()) : [],
          notes: place.note || place.comment || "",
          source: "google",
        });
      }
    } catch {
      // skip failed geocoding
    }

    onProgress?.(i + 1, total);

    // Nominatim rate limit: 1 request per second
    if (i < csvPlaces.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  return results;
}

export { guessCategory };
