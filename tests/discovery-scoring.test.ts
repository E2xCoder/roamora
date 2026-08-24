import { describe, expect, it } from "vitest";
import {
  classifyOsmPlace,
  scoreCandidates,
  pruneAndDiversify,
  isSightseeingCandidate,
  type ScoredCandidate,
} from "@/server/services/discovery-scoring";
import type { DiscoveredPlace } from "@/server/providers/discovery/types";

function place(overrides: Partial<DiscoveredPlace> = {}): DiscoveredPlace {
  return {
    id: `osm:node:${Math.random()}`,
    name: "Test Place",
    lat: 52.4,
    lng: 16.9,
    osmTag: "tourism",
    osmValue: "museum",
    tags: {},
    source: "osm",
    ...overrides,
  };
}

describe("classifyOsmPlace", () => {
  it("maps common OSM tourism tags to the app taxonomy", () => {
    expect(classifyOsmPlace("tourism", "museum")).toBe("museum");
    expect(classifyOsmPlace("tourism", "viewpoint")).toBe("viewpoint");
    expect(classifyOsmPlace("amenity", "place_of_worship")).toBe("church");
    expect(classifyOsmPlace("amenity", "cafe")).toBe("cafe");
    expect(classifyOsmPlace("shop", "bakery")).toBe("bakery");
    expect(classifyOsmPlace("historic", "castle")).toBe("castle");
  });

  it("falls back to a generic historic bucket for an unlisted historic value", () => {
    expect(classifyOsmPlace("historic", "archaeological_site")).toBe("historic");
  });

  it("never returns a category outside the known taxonomy for an unmapped tag", () => {
    expect(classifyOsmPlace("shop", "supermarket")).toBe("attraction");
  });
});

describe("scoreCandidates", () => {
  it("computes real haversine distance from the destination centre", () => {
    const center = { lat: 52.4064, lng: 16.9252 }; // Poznań
    const nearby = place({ lat: 52.4085, lng: 16.9319 }); // Poznań Old Market, ~500m
    const [scored] = scoreCandidates([nearby], center);
    expect(scored.distanceFromCenterMeters).toBeGreaterThan(100);
    expect(scored.distanceFromCenterMeters).toBeLessThan(1000);
  });

  it("scores a place with richer OSM tags higher on notability", () => {
    const center = { lat: 0, lng: 0 };
    const richTags = place({
      lat: 0.001,
      lng: 0.001,
      tags: { wikidata: "Q1", wikipedia: "en:X", website: "https://x", opening_hours: "Mo-Fr 9:00-17:00" },
    });
    const bareTags = place({ lat: 0.001, lng: 0.001, tags: {} });

    const [rich] = scoreCandidates([richTags], center);
    const [bare] = scoreCandidates([bareTags], center);

    expect(rich.notabilityScore).toBeGreaterThan(bare.notabilityScore);
  });
});

describe("pruneAndDiversify", () => {
  function scoredList(counts: Record<string, number>): ScoredCandidate[] {
    const out: ScoredCandidate[] = [];
    for (const [category, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        out.push({
          place: place({ name: `${category}-${i}` }),
          category,
          notabilityScore: n - i, // first one in each category scores highest
          distanceFromCenterMeters: 500,
        });
      }
    }
    return out;
  }

  it("does not let one over-represented category dominate the shortlist", () => {
    // 40 restaurants, 2 museums, 1 castle — a naive top-N by count alone
    // would return an itinerary of nothing but restaurants.
    const scored = scoredList({ restaurant: 40, museum: 2, castle: 1 });
    const result = pruneAndDiversify(scored, 6);

    const categories = new Set(result.map((r) => r.category));
    expect(categories.has("museum")).toBe(true);
    expect(categories.has("castle")).toBe(true);
    expect(categories.has("restaurant")).toBe(true);
  });

  it("respects the requested maximum count exactly when enough candidates exist", () => {
    const scored = scoredList({ museum: 10, cafe: 10 });
    expect(pruneAndDiversify(scored, 8)).toHaveLength(8);
  });

  it("returns fewer than requested rather than duplicating when candidates run out", () => {
    const scored = scoredList({ museum: 2 });
    const result = pruneAndDiversify(scored, 10);
    expect(result).toHaveLength(2);
  });

  it("prefers higher-scored candidates within each category", () => {
    const scored = scoredList({ museum: 3 });
    const result = pruneAndDiversify(scored, 1);
    expect(result[0].place.name).toBe("museum-0"); // highest notabilityScore
  });

  it("weights a category the user cares about more heavily", () => {
    const scored = scoredList({ restaurant: 5, museum: 5 });
    const weighted = pruneAndDiversify(scored, 2, { museum: 5, restaurant: 1 });
    // With a strong museum weight, both top picks should be museums even
    // though categories are round-robined by default.
    expect(weighted.every((r) => r.category === "museum")).toBe(true);
  });
});

describe("isSightseeingCandidate", () => {
  function candidate(category: string, name = "Test Place"): ScoredCandidate {
    return { place: place({ name }), category, notabilityScore: 5, distanceFromCenterMeters: 100 };
  }

  it("rejects a hotel from the general sightseeing shortlist", () => {
    // Real regression: "Hotel Paříž" was scheduled as a scored stop with
    // its own visit window purely because it had good OSM notability tags.
    expect(isSightseeingCandidate(candidate("accommodation", "Hotel Paříž"))).toBe(false);
  });

  it("rejects a transport hub from the general sightseeing shortlist", () => {
    expect(isSightseeingCandidate(candidate("transport", "Praha hlavní nádraží"))).toBe(false);
  });

  it("keeps a real sightseeing category unaffected", () => {
    expect(isSightseeingCandidate(candidate("museum"))).toBe(true);
  });

  it("allows a non-sightseeing place through only when explicitly requested by name", () => {
    const hotel = candidate("accommodation", "Hotel Paříž");
    expect(isSightseeingCandidate(hotel, ["Hotel Paříž"])).toBe(true);
    expect(isSightseeingCandidate(hotel, ["some other hotel"])).toBe(false);
  });
});
