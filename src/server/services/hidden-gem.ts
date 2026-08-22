import type { ScoredCandidate } from "@/server/services/discovery-scoring";

/**
 * Route-aware hidden-gem engine (spec §Priority 5).
 *
 * Deliberately network-free: every candidate this searches was already
 * fetched by the same single Overpass discovery call autoplan.ts already
 * makes for the destination as a whole (a 1500 m radius comfortably covers
 * any real walking corridor inside it) — this module only re-filters that
 * already-discovered, already-scored list by real distance to the ACTUAL
 * route geometry, not the destination's center point. No new external
 * request, no new cost, and nothing here can itself fail from a flaky
 * upstream service.
 *
 * "100/200/300m" is an escalating search, not three independent radii
 * tried at once: the tightest tier is checked first, and a wider one is
 * only consulted when the tighter one turns up nothing — a gem 80m off
 * the path is preferred over one that's 250m off it, and a corridor with
 * no real gem at all within 300m correctly reports none rather than
 * reaching for something further away.
 */

const EARTH_RADIUS_METERS = 6371000;

/** Local, short-range planar approximation — valid at the scale this module operates at (a few hundred meters), same trade-off haversineMeters already makes elsewhere in this codebase for similarly short distances. */
function toLocalMeters(origin: { lat: number; lng: number }, p: { lat: number; lng: number }): { x: number; y: number } {
  const dLat = ((p.lat - origin.lat) * Math.PI) / 180;
  const dLng = ((p.lng - origin.lng) * Math.PI) / 180;
  const x = dLng * EARTH_RADIUS_METERS * Math.cos((origin.lat * Math.PI) / 180);
  const y = dLat * EARTH_RADIUS_METERS;
  return { x, y };
}

/** Real point-to-segment distance (not point-to-endpoint), so a gem abreast of the middle of a long walking leg is correctly measured against the path itself, not just how far it is from whichever stop happens to be nearest. */
export function pointToSegmentDistanceMeters(
  point: { lat: number; lng: number },
  segA: { lat: number; lng: number },
  segB: { lat: number; lng: number }
): number {
  const p = toLocalMeters(segA, point);
  const b = toLocalMeters(segA, segB);

  const abx = b.x;
  const aby = b.y;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq === 0 ? 0 : Math.max(0, Math.min(1, (p.x * abx + p.y * aby) / abLenSq));

  const closestX = t * abx;
  const closestY = t * aby;
  const dx = p.x - closestX;
  const dy = p.y - closestY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Minimum distance from a point to any leg of an ordered route polyline. */
export function distanceToRouteCorridorMeters(
  point: { lat: number; lng: number },
  routePoints: Array<{ lat: number; lng: number }>
): number {
  if (routePoints.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < routePoints.length - 1; i++) {
    const d = pointToSegmentDistanceMeters(point, routePoints[i], routePoints[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Food/logistics categories are excluded — restaurant selection already has its own dedicated system (restaurant.ts), and accommodation/transport/other are never "discoveries" in the hidden-gem sense. */
const HIDDEN_GEM_EXCLUDED_CATEGORIES = new Set([
  "restaurant", "cafe", "bar", "bakery", "market", "accommodation", "transport", "other",
]);

export const HIDDEN_GEM_RADIUS_TIERS_METERS = [100, 200, 300] as const;
const MAX_HIDDEN_GEMS = 2;

export interface HiddenGemFinding {
  candidate: ScoredCandidate;
  distanceMeters: number;
  radiusTierMeters: number;
}

/**
 * Escalating corridor search: tries 100 m first, then 200 m, then 300 m,
 * stopping at the first tier with any real match. Already-used stop ids
 * are excluded so this can never re-discover a place the trip is already
 * visiting. Ties broken by notability (a real OSM-tag-completeness proxy,
 * same metric discovery-scoring.ts already uses), then by proximity.
 */
export function findHiddenGemsNearCorridor(
  candidates: ScoredCandidate[],
  routePoints: Array<{ lat: number; lng: number }>,
  excludeIds: ReadonlySet<string>,
  maxCount = MAX_HIDDEN_GEMS
): HiddenGemFinding[] {
  if (routePoints.length < 2) return [];

  const eligible = candidates.filter(
    (c) => !excludeIds.has(c.place.id) && !HIDDEN_GEM_EXCLUDED_CATEGORIES.has(c.category)
  );
  if (eligible.length === 0) return [];

  for (const radius of HIDDEN_GEM_RADIUS_TIERS_METERS) {
    const within: HiddenGemFinding[] = eligible
      .map((candidate) => ({
        candidate,
        distanceMeters: distanceToRouteCorridorMeters(candidate.place, routePoints),
        radiusTierMeters: radius,
      }))
      .filter((f) => f.distanceMeters <= radius)
      .sort((a, b) => b.candidate.notabilityScore - a.candidate.notabilityScore || a.distanceMeters - b.distanceMeters);

    if (within.length > 0) return within.slice(0, maxCount);
  }

  return [];
}
