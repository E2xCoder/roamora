/**
 * Pure GeoJSON point-in-polygon geometry — no external dependencies, no
 * network access. Used by provision-transit.ts to find which real
 * Geofabrik OSM-extract region actually contains a destination's
 * coordinates, using the ray-casting algorithm (the standard, textbook
 * approach for this — not a library dependency this project doesn't
 * already have).
 */

export type Point = [number, number]; // [lng, lat] — GeoJSON's own coordinate order
export type Ring = Point[];
export type PolygonCoords = Ring[]; // [outer, ...holes]
export type MultiPolygonCoords = PolygonCoords[];

/** Standard ray-casting point-in-ring test (even-odd rule) — treats the ring as a simple closed polygon, ignoring winding direction. */
export function pointInRing(point: Point, ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** A GeoJSON Polygon: inside the outer ring (index 0) and outside every hole (the remaining rings). */
export function pointInPolygon(point: Point, polygon: PolygonCoords): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(point, polygon[i])) return false; // inside a hole = not really inside
  }
  return true;
}

/** A GeoJSON MultiPolygon: inside any one of its constituent polygons. */
export function pointInMultiPolygon(point: Point, multiPolygon: MultiPolygonCoords): boolean {
  return multiPolygon.some((polygon) => pointInPolygon(point, polygon));
}

export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Dispatches on the real GeoJSON geometry type actually present — Geofabrik's index uses both Polygon and MultiPolygon across different regions. Any other/unrecognised geometry type conservatively reports no match rather than guessing. */
export function pointInGeometry(point: Point, geometry: GeoJsonGeometry): boolean {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates as PolygonCoords);
  if (geometry.type === "MultiPolygon") return pointInMultiPolygon(point, geometry.coordinates as MultiPolygonCoords);
  return false;
}
