import { describe, expect, it } from "vitest";
import { planBudgetOptimization } from "@/server/services/budget-optimizer";
import type { ScoredCandidate } from "@/server/services/discovery-scoring";
import type { StopInput } from "@/server/services/itinerary-optimizer";

function candidate(
  overrides: Partial<ScoredCandidate> & { id: string; lat?: number; lng?: number; freeTag?: boolean }
): ScoredCandidate {
  return {
    place: {
      id: overrides.id,
      name: overrides.id,
      lat: overrides.lat ?? 52.4,
      lng: overrides.lng ?? 16.9,
      osmTag: "tourism",
      osmValue: "museum",
      tags: overrides.freeTag ? { fee: "no" } : {},
      source: "osm",
    },
    category: "museum",
    notabilityScore: 3,
    distanceFromCenterMeters: 500,
    ...overrides,
  };
}

function stop(input: Partial<StopInput> & { id: string }, scored?: Partial<ScoredCandidate>) {
  const full: StopInput = { name: input.id, lat: 52.4, lng: 16.9, ...input };
  return { input: full, scored: candidate({ id: input.id, category: full.category ?? "museum", ...scored }) };
}

describe("planBudgetOptimization", () => {
  it("does nothing when the budget is already satisfied", () => {
    const stops = [stop({ id: "a", estimatedCost: 20 }), stop({ id: "b", estimatedCost: 20 })];
    const { keptStops, result } = planBudgetOptimization(stops, [], 60);
    expect(result.applied).toBe(false);
    expect(result.satisfied).toBe(true);
    expect(result.originalCost).toBe(40);
    expect(keptStops).toHaveLength(2);
  });

  it(
    "the exact example from the spec: €60 budget, €68 initial route -> replans down to at or under budget",
    () => {
      const stops = [
        stop({ id: "cheap-museum", estimatedCost: 15, category: "museum" }),
        stop({ id: "expensive-attraction", estimatedCost: 33, category: "attraction" }),
        stop({ id: "restaurant", estimatedCost: 20, category: "restaurant" }),
      ];
      const { result } = planBudgetOptimization(stops, [], 60);
      expect(result.originalCost).toBe(68);
      expect(result.applied).toBe(true);
      expect(result.satisfied).toBe(true);
      expect(result.optimizedCost).toBeLessThanOrEqual(60);
      expect(result.savedAmount).toBe(result.originalCost - result.optimizedCost);
      // Removed the single most expensive stop (33) first — that alone
      // already satisfies 68-33=35 <= 60, so nothing else should be touched.
      expect(result.removedStops).toHaveLength(1);
      expect(result.removedStops[0].id).toBe("expensive-attraction");
    }
  );

  it("prefers a free same-category substitute over an outright removal when one exists nearby", () => {
    const expensive = stop({ id: "expensive-museum", estimatedCost: 33, category: "museum", lat: 52.4, lng: 16.9 });
    const freeAlt = candidate({ id: "free-museum", category: "museum", lat: 52.401, lng: 16.901, freeTag: true });
    const stops = [stop({ id: "cheap", estimatedCost: 15, category: "restaurant" }), expensive];
    const { keptStops, result } = planBudgetOptimization(stops, [freeAlt], 20);
    expect(result.replacedStops).toHaveLength(1);
    expect(result.replacedStops[0].removedId).toBe("expensive-museum");
    expect(result.replacedStops[0].addedId).toBe("free-museum");
    expect(result.removedStops).toHaveLength(0);
    expect(keptStops.some((s) => s.input.id === "free-museum")).toBe(true);
    expect(keptStops.some((s) => s.input.id === "expensive-museum")).toBe(false);
  });

  it("does not use a substitute that is too far away", () => {
    const expensive = stop({ id: "expensive-museum", estimatedCost: 33, category: "museum", lat: 52.4, lng: 16.9 });
    const farAlt = candidate({ id: "far-museum", category: "museum", lat: 53.0, lng: 17.5, freeTag: true }); // ~70km away, but genuinely free — distance must be the rejection reason
    const stops = [expensive];
    const { result } = planBudgetOptimization(stops, [farAlt], 10);
    expect(result.replacedStops).toHaveLength(0);
    expect(result.removedStops).toHaveLength(1);
  });

  it("never removes a must-see (protected) stop, even if it's the most expensive", () => {
    const mustSee = stop({ id: "must-see", estimatedCost: 50, category: "museum" });
    const removable = stop({ id: "removable", estimatedCost: 20, category: "restaurant" });
    const { keptStops, result } = planBudgetOptimization([mustSee, removable], [], 40, new Set(["must-see"]));
    expect(keptStops.some((s) => s.input.id === "must-see")).toBe(true);
    expect(result.removedStops.map((s) => s.id)).toEqual(["removable"]);
  });

  it("never removes a locked stop", () => {
    const locked = stop({ id: "locked", estimatedCost: 50, category: "museum", locked: true });
    const removable = stop({ id: "removable", estimatedCost: 20, category: "restaurant" });
    const { keptStops } = planBudgetOptimization([locked, removable], [], 40);
    expect(keptStops.some((s) => s.input.id === "locked")).toBe(true);
  });

  it("never removes a fixed-time (booked event) stop", () => {
    const fixed = stop({ id: "fixed", estimatedCost: 50, category: "museum", fixedTime: "14:00" });
    const removable = stop({ id: "removable", estimatedCost: 20, category: "restaurant" });
    const { keptStops } = planBudgetOptimization([fixed, removable], [], 40);
    expect(keptStops.some((s) => s.input.id === "fixed")).toBe(true);
  });

  it(
    "reports the minimum feasible cost honestly when the budget cannot be satisfied " +
      "because every removable stop is protected",
    () => {
      const mustSee1 = stop({ id: "a", estimatedCost: 40, category: "museum" });
      const mustSee2 = stop({ id: "b", estimatedCost: 40, category: "attraction" });
      const { result } = planBudgetOptimization([mustSee1, mustSee2], [], 30, new Set(["a", "b"]));
      expect(result.satisfied).toBe(false);
      expect(result.minimumFeasibleCost).toBe(80);
      expect(result.removedStops).toHaveLength(0);
    }
  );

  it(
    'reports honestly when NO stop cost is known at all — "budget satisfied" would be ' +
      "misleading when it's really \"nothing was ever priced\" (real live case: a full autoplan " +
      "run where web-research found zero usable prices that day)",
    () => {
      const stops = [stop({ id: "a", category: "museum" }), stop({ id: "b", category: "attraction" })];
      const { result } = planBudgetOptimization(stops, [], 30);
      expect(result.applied).toBe(false);
      expect(result.originalCost).toBe(0);
      expect(result.unknownCostStopCount).toBe(2);
      expect(result.reason).toMatch(/hiçbir durağın maliyeti bilinmiyor/);
    }
  );

  it("excludes unknown-cost stops from the total rather than assuming they're free", () => {
    const known = stop({ id: "known", estimatedCost: 70, category: "museum" });
    const unknown = stop({ id: "unknown", category: "attraction" }); // no estimatedCost
    const { result } = planBudgetOptimization([known, unknown], [], 60);
    expect(result.unknownCostStopCount).toBe(1);
    expect(result.originalCost).toBe(70); // does not silently count "unknown" as 0-and-fine
  });

  it("never touches the same stop twice and stops as soon as budget is met", () => {
    const stops = [
      stop({ id: "a", estimatedCost: 10, category: "museum" }),
      stop({ id: "b", estimatedCost: 10, category: "museum" }),
      stop({ id: "c", estimatedCost: 10, category: "museum" }),
      stop({ id: "d", estimatedCost: 10, category: "museum" }),
    ];
    const { result } = planBudgetOptimization(stops, [], 25);
    expect(result.optimizedCost).toBeLessThanOrEqual(25);
    expect(result.removedStops.length).toBeGreaterThan(0);
    expect(result.removedStops.length).toBeLessThan(4); // did not remove everything
  });
});
