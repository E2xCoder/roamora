import { describe, expect, it } from "vitest";
import {
  pointToSegmentDistanceMeters,
  distanceToRouteCorridorMeters,
  findHiddenGemsNearCorridor,
  HIDDEN_GEM_RADIUS_TIERS_METERS,
} from "@/server/services/hidden-gem";
import type { ScoredCandidate } from "@/server/services/discovery-scoring";

// Poznań's Old Market Square area — real coordinates, short east-west walk.
const A = { lat: 52.4082, lng: 16.9335 };
const B = { lat: 52.4082, lng: 16.9435 }; // ~6.8 km east at this latitude — scaled down below for realistic short legs

// A short, realistic ~140m leg for most tests.
const SHORT_A = { lat: 52.4082, lng: 16.9335 };
const SHORT_B = { lat: 52.4082, lng: 16.9350 }; // ~102m east at this latitude

describe("pointToSegmentDistanceMeters", () => {
  it("returns ~0 for a point on the segment itself", () => {
    const midpoint = { lat: SHORT_A.lat, lng: (SHORT_A.lng + SHORT_B.lng) / 2 };
    expect(pointToSegmentDistanceMeters(midpoint, SHORT_A, SHORT_B)).toBeLessThan(1);
  });

  it("measures real perpendicular distance from a point abreast of the segment's middle, not just distance to an endpoint", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    // ~50m north of the segment's midpoint (1 degree latitude ≈ 111km, so 0.00045deg ≈ 50m)
    const offRoute = { lat: SHORT_A.lat + 0.00045, lng: midLng };
    const d = pointToSegmentDistanceMeters(offRoute, SHORT_A, SHORT_B);
    expect(d).toBeGreaterThan(30);
    expect(d).toBeLessThan(70);
  });

  it("clamps to the nearest endpoint when the point projects beyond the segment", () => {
    const farBeyondB = { lat: SHORT_B.lat, lng: SHORT_B.lng + 0.01 };
    const distToEndpoint = pointToSegmentDistanceMeters(farBeyondB, SHORT_B, SHORT_B);
    const distToSegment = pointToSegmentDistanceMeters(farBeyondB, SHORT_A, SHORT_B);
    expect(distToSegment).toBeCloseTo(distToEndpoint, 0);
  });

  it("handles a zero-length segment (both endpoints identical) without dividing by zero", () => {
    expect(() => pointToSegmentDistanceMeters(SHORT_B, SHORT_A, SHORT_A)).not.toThrow();
  });
});

describe("distanceToRouteCorridorMeters", () => {
  it("returns the minimum distance across all legs of a multi-stop route", () => {
    const far = { lat: 52.5, lng: 17.5 };
    const routePoints = [A, SHORT_A, SHORT_B, B];
    const d = distanceToRouteCorridorMeters(SHORT_A, routePoints);
    expect(d).toBeLessThan(1);
    const dFar = distanceToRouteCorridorMeters(far, routePoints);
    expect(dFar).toBeGreaterThan(1000);
  });

  it("returns Infinity for a route with fewer than 2 points", () => {
    expect(distanceToRouteCorridorMeters(A, [A])).toBe(Infinity);
    expect(distanceToRouteCorridorMeters(A, [])).toBe(Infinity);
  });
});

function candidate(overrides: Partial<ScoredCandidate> & { id: string; lat: number; lng: number }): ScoredCandidate {
  return {
    place: {
      id: overrides.id,
      name: overrides.id,
      lat: overrides.lat,
      lng: overrides.lng,
      osmTag: "tourism",
      osmValue: "artwork",
      tags: {},
      source: "osm",
    },
    category: overrides.category ?? "attraction",
    notabilityScore: overrides.notabilityScore ?? 0,
    distanceFromCenterMeters: 0,
  };
}

describe("findHiddenGemsNearCorridor", () => {
  const routePoints = [SHORT_A, SHORT_B];

  it("finds a real candidate within the tightest (100m) radius tier first", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const near = candidate({ id: "near", lat: SHORT_A.lat, lng: midLng });
    const results = findHiddenGemsNearCorridor([near], routePoints, new Set());
    expect(results).toHaveLength(1);
    expect(results[0].candidate.place.id).toBe("near");
    expect(results[0].radiusTierMeters).toBe(100);
  });

  it("escalates to 200m when nothing is found within 100m", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    // ~150m off the route — outside 100m, inside 200m (0.00135deg ≈ 150m)
    const mid = candidate({ id: "mid-distance", lat: SHORT_A.lat + 0.00135, lng: midLng });
    const results = findHiddenGemsNearCorridor([mid], routePoints, new Set());
    expect(results).toHaveLength(1);
    expect(results[0].radiusTierMeters).toBe(200);
  });

  it("escalates to 300m when nothing is found within 100m or 200m", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    // ~280m off the route (0.0025deg ≈ 280m)
    const far = candidate({ id: "far-but-in-range", lat: SHORT_A.lat + 0.0025, lng: midLng });
    const results = findHiddenGemsNearCorridor([far], routePoints, new Set());
    expect(results).toHaveLength(1);
    expect(results[0].radiusTierMeters).toBe(300);
  });

  it("returns nothing when the only candidate is beyond every tier, rather than reaching for it anyway", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const wayFar = candidate({ id: "way-too-far", lat: SHORT_A.lat + 0.01, lng: midLng }); // ~1.1km
    expect(findHiddenGemsNearCorridor([wayFar], routePoints, new Set())).toEqual([]);
  });

  it("excludes a candidate whose id is already used as a stop", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const near = candidate({ id: "already-a-stop", lat: SHORT_A.lat, lng: midLng });
    const results = findHiddenGemsNearCorridor([near], routePoints, new Set(["already-a-stop"]));
    expect(results).toEqual([]);
  });

  it("excludes food/logistics categories — restaurant selection has its own dedicated system", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const restaurant = candidate({ id: "a-restaurant", lat: SHORT_A.lat, lng: midLng, category: "restaurant" });
    const cafe = candidate({ id: "a-cafe", lat: SHORT_A.lat, lng: midLng, category: "cafe" });
    const hotel = candidate({ id: "a-hotel", lat: SHORT_A.lat, lng: midLng, category: "accommodation" });
    expect(findHiddenGemsNearCorridor([restaurant, cafe, hotel], routePoints, new Set())).toEqual([]);
  });

  it("prefers higher notability among several candidates within the same radius tier", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const low = candidate({ id: "low-notability", lat: SHORT_A.lat, lng: midLng, notabilityScore: 1 });
    const high = candidate({ id: "high-notability", lat: SHORT_A.lat, lng: midLng, notabilityScore: 4 });
    const results = findHiddenGemsNearCorridor([low, high], routePoints, new Set(), 1);
    expect(results).toHaveLength(1);
    expect(results[0].candidate.place.id).toBe("high-notability");
  });

  it("bounds the result count to maxCount even when more real candidates qualify", () => {
    const midLng = (SHORT_A.lng + SHORT_B.lng) / 2;
    const many = Array.from({ length: 5 }, (_, i) => candidate({ id: `gem-${i}`, lat: SHORT_A.lat, lng: midLng }));
    const results = findHiddenGemsNearCorridor(many, routePoints, new Set(), 2);
    expect(results).toHaveLength(2);
  });

  it("returns nothing for a route with fewer than 2 points", () => {
    const near = candidate({ id: "irrelevant", lat: SHORT_A.lat, lng: SHORT_A.lng });
    expect(findHiddenGemsNearCorridor([near], [SHORT_A], new Set())).toEqual([]);
  });

  it("exposes the exact three radius tiers the spec asks for", () => {
    expect(HIDDEN_GEM_RADIUS_TIERS_METERS).toEqual([100, 200, 300]);
  });
});
