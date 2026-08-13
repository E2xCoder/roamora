const WAYMARKED_API = "https://hiking.waymarkedtrails.org/api/v1";

export interface WaymarkedRoute {
  id: number;
  name: string;
  group: string;
  symbol_description: string;
  mapped_length: number;
  official_length: number;
}

export interface WaymarkedRouteDetail extends WaymarkedRoute {
  description: string;
  tags: Record<string, string>;
  subroutes: WaymarkedRoute[];
}

export async function searchTrails(query: string, page: number = 1) {
  const res = await fetch(
    `${WAYMARKED_API}/list/search?query=${encodeURIComponent(query)}&page=${page}`
  );
  if (!res.ok) throw new Error(`Waymarked API error: ${res.status}`);
  return res.json() as Promise<{ results: WaymarkedRoute[]; page: number; total: number }>;
}

export async function getTrailsByBbox(
  bbox: { south: number; west: number; north: number; east: number }
) {
  const { south, west, north, east } = bbox;
  const res = await fetch(
    `${WAYMARKED_API}/list/by-area?bbox=${west},${south},${east},${north}`
  );
  if (!res.ok) throw new Error(`Waymarked API error: ${res.status}`);
  return res.json() as Promise<WaymarkedRoute[]>;
}

export async function getTrailDetail(id: number) {
  const res = await fetch(`${WAYMARKED_API}/details/${id}`);
  if (!res.ok) throw new Error(`Waymarked API error: ${res.status}`);
  return res.json() as Promise<WaymarkedRouteDetail>;
}

export async function getTrailGeometry(id: number) {
  const res = await fetch(`${WAYMARKED_API}/details/${id}/geometry/geojson`);
  if (!res.ok) throw new Error(`Waymarked API error: ${res.status}`);
  return res.json();
}

export async function getTrailElevation(id: number) {
  const res = await fetch(`${WAYMARKED_API}/details/${id}/elevation`);
  if (!res.ok) throw new Error(`Waymarked API error: ${res.status}`);
  return res.json();
}
