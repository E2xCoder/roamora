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
  if (/restaurant|ristorante|restoran|gaststätte|trattoria|bistro/.test(lower)) return "restaurant";
  if (/cafe|café|coffee|kaffee|kahve/.test(lower)) return "cafe";
  if (/museum|müze|galerie|gallery/.test(lower)) return "museum";
  if (/park|garden|garten|bahçe|forest|wald/.test(lower)) return "nature";
  if (/castle|schloss|kale|palace|palast|cathedral|kirche|church|mosque|cami/.test(lower)) return "historic";
  if (/beach|strand|plaj|sahil/.test(lower)) return "beach";
  if (/viewpoint|aussicht|lookout|panorama|manzara/.test(lower)) return "viewpoint";
  if (/trail|wanderweg|hiking|hike|trek/.test(lower)) return "hiking";
  if (/bar|club|pub|nightclub|disco/.test(lower)) return "nightlife";
  if (/shop|market|bazaar|mall|store/.test(lower)) return "shopping";
  if (/hotel|hostel|airbnb|pension|motel/.test(lower)) return "accommodation";
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
