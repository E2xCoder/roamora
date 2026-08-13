import type { OverpassElement } from "@/types";

const OVERPASS_API = "https://overpass-api.de/api/interpreter";

async function query(overpassQL: string): Promise<OverpassElement[]> {
  const res = await fetch(OVERPASS_API, {
    method: "POST",
    body: `data=${encodeURIComponent(overpassQL)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);
  const data = await res.json();
  return data.elements;
}

export async function searchPOIs(
  lat: number,
  lng: number,
  radiusMeters: number = 5000,
  categories: string[] = ["tourism", "historic", "natural"]
) {
  const filters = categories
    .map((cat) => {
      if (cat === "tourism") return `node["tourism"](around:${radiusMeters},${lat},${lng});`;
      if (cat === "historic") return `node["historic"](around:${radiusMeters},${lat},${lng});`;
      if (cat === "natural") return `node["natural"](around:${radiusMeters},${lat},${lng});`;
      if (cat === "amenity") return `node["amenity"~"restaurant|cafe|bar"](around:${radiusMeters},${lat},${lng});`;
      return `node["${cat}"](around:${radiusMeters},${lat},${lng});`;
    })
    .join("\n");

  const q = `[out:json][timeout:25];(${filters});out body;`;
  return query(q);
}

export async function searchHikingTrails(
  bbox: { south: number; west: number; north: number; east: number },
  trailType: "international" | "national" | "regional" | "all" = "all"
) {
  let networkFilter = "";
  if (trailType === "international") networkFilter = '["network"="iwn"]';
  else if (trailType === "national") networkFilter = '["network"="nwn"]';
  else if (trailType === "regional") networkFilter = '["network"="rwn"]';

  const { south, west, north, east } = bbox;
  const q = `[out:json][timeout:60];
    relation["route"="hiking"]${networkFilter}(${south},${west},${north},${east});
    out body geom;`;
  return query(q);
}

export async function getHiddenGems(
  lat: number,
  lng: number,
  radiusMeters: number = 10000
) {
  const q = `[out:json][timeout:30];
    (
      node["tourism"="attraction"]["name"](around:${radiusMeters},${lat},${lng});
      node["historic"]["name"](around:${radiusMeters},${lat},${lng});
      node["natural"]["name"](around:${radiusMeters},${lat},${lng});
      node["tourism"="viewpoint"]["name"](around:${radiusMeters},${lat},${lng});
      node["leisure"="park"]["name"](around:${radiusMeters},${lat},${lng});
    );
    out body;`;
  return query(q);
}
