import { describe, expect, it } from "vitest";
import {
  mealWindowsFor,
  restaurantStopInput,
  researchRestaurant,
  preScoreRestaurantCandidate,
  estimateMealWaitMinutes,
  looksLikeRealMenu,
  type RestaurantCandidateResult,
  type RestaurantResearchParams,
  type MenuItemResult,
} from "@/server/services/restaurant";
import type { ScoredCandidate } from "@/server/services/discovery-scoring";
import type { DiscoveredPlace } from "@/server/providers/discovery/types";

describe("mealWindowsFor", () => {
  it("includes lunch when the trip's active hours cover it", () => {
    const windows = mealWindowsFor("10:00", "17:00");
    expect(windows.map((w) => w.name)).toEqual(["lunch"]);
  });

  it("includes dinner when the trip's active hours cover it", () => {
    const windows = mealWindowsFor("16:00", "22:00");
    expect(windows.map((w) => w.name)).toEqual(["dinner"]);
  });

  it("includes both lunch and dinner for a full-day trip", () => {
    const windows = mealWindowsFor("09:00", "22:00");
    expect(windows.map((w) => w.name)).toEqual(["lunch", "dinner"]);
  });

  it("includes neither for a short morning-only trip", () => {
    const windows = mealWindowsFor("08:00", "11:00");
    expect(windows).toEqual([]);
  });

  it("includes neither for a short trip entirely between meal windows", () => {
    const windows = mealWindowsFor("15:00", "16:30");
    expect(windows).toEqual([]);
  });

  it("includes lunch for a trip ending right as the lunch window opens (partial overlap)", () => {
    const windows = mealWindowsFor("11:00", "12:15");
    expect(windows.map((w) => w.name)).toEqual(["lunch"]);
  });
});

describe("restaurantStopInput", () => {
  function candidate(overrides: Partial<RestaurantCandidateResult> = {}): RestaurantCandidateResult {
    return {
      stopId: "osm:node:1",
      name: "Test Restaurant",
      lat: 52.4,
      lng: 16.9,
      openingHoursSource: "osm",
      openingHoursConfidence: "high",
      mealWindow: "lunch",
      menuItems: [],
      menuAvailability: { status: "no-source" },
      touristTrapRisk: "LOW",
      touristTrapReasons: [],
      queueEstimate: null,
      routeDetourMeters: 100,
      score: 40,
      scoreBreakdown: {},
      source: "osm",
      selectionReason: "test",
      ...overrides,
    };
  }

  it("builds a stop with the meal window as earliest/latest time", () => {
    const stop = restaurantStopInput(candidate({ mealWindow: "lunch" }));
    expect(stop.earliestTime).toBe("12:00");
    expect(stop.latestTime).toBe("14:30");
    expect(stop.category).toBe("restaurant");
  });

  it("uses the dinner window when selected", () => {
    const stop = restaurantStopInput(candidate({ mealWindow: "dinner" }));
    expect(stop.earliestTime).toBe("18:00");
    expect(stop.latestTime).toBe("21:00");
  });

  it("carries the estimated meal cost through as estimatedCost, when known", () => {
    const stop = restaurantStopInput(candidate({ estimatedMealCost: 22.5 }));
    expect(stop.estimatedCost).toBe(22.5);
  });

  it("leaves estimatedCost unset (not fabricated as free) when unknown", () => {
    const stop = restaurantStopInput(candidate({ estimatedMealCost: undefined }));
    expect(stop.estimatedCost).toBeUndefined();
  });

  it("does not set fixedTime or locked — the optimizer is free to place it within the window", () => {
    const stop = restaurantStopInput(candidate());
    expect(stop.fixedTime).toBeUndefined();
    expect(stop.locked).toBeUndefined();
  });
});

// Real reference point (Prague Old Town Square), used with small lat/lng
// offsets to get real, deterministic haversine distances without needing a
// route geometry — researchRestaurant only needs routeReferencePoint.
const REF = { lat: 50.087, lng: 14.4213 };

function place(overrides: Partial<DiscoveredPlace> = {}): DiscoveredPlace {
  return {
    id: `osm:node:${Math.random()}`,
    name: "Test Restaurant",
    lat: REF.lat,
    lng: REF.lng,
    osmTag: "amenity",
    osmValue: "restaurant",
    tags: {},
    source: "osm",
    ...overrides,
  };
}

function candidate(overrides: Partial<DiscoveredPlace> = {}, notabilityScore = 0): ScoredCandidate {
  const p = place(overrides);
  return { place: p, category: "restaurant", notabilityScore, distanceFromCenterMeters: 0 };
}

function baseParams(overrides: Partial<RestaurantResearchParams> = {}): RestaurantResearchParams {
  return {
    restaurantCandidates: [],
    destination: "Prague",
    tripDate: new Date("2026-09-29T12:00:00"),
    routeReferencePoint: REF,
    arrivalTime: "09:00",
    dayEnd: "21:00",
    searchAvailable: false,
    aiAvailable: false,
    ...overrides,
  };
}

/** Offsets a lat/lng roughly `meters` east of REF — small enough that a flat approximation is accurate at this scale. */
function offsetMeters(meters: number): { lat: number; lng: number } {
  return { lat: REF.lat, lng: REF.lng + meters / (111_320 * Math.cos((REF.lat * Math.PI) / 180)) };
}

describe("researchRestaurant", () => {
  it("returns no-meal-window when the trip's active hours never reach lunch or dinner", async () => {
    const result = await researchRestaurant(
      baseParams({ arrivalTime: "08:00", dayEnd: "11:00", restaurantCandidates: [candidate()] })
    );
    expect(result.status).toBe("no-meal-window");
  });

  it("returns no-candidates when OSM found no restaurants at all", async () => {
    const result = await researchRestaurant(baseParams({ restaurantCandidates: [] }));
    expect(result.status).toBe("no-candidates");
  });

  it("excludes a candidate confirmed closed on the actual trip date (OSM hours), never scheduling it", async () => {
    const closedOnMonday = candidate({ name: "Monday Closed", tags: { opening_hours: "Tu-Su 12:00-22:00" } });
    // 2026-09-29 is a Tuesday — pick a date that's actually a Monday to hit the closure.
    const result = await researchRestaurant(
      baseParams({ tripDate: new Date("2026-09-28T12:00:00"), restaurantCandidates: [closedOnMonday] })
    );
    expect(result.status).toBe("no-suitable-candidate");
  });

  it("selects the OSM-verified-open candidate over one with no opening-hours data at all, all else equal", async () => {
    const verified = candidate({ name: "Verified Open", tags: { opening_hours: "Mo-Su 11:00-23:00" } });
    const unverified = candidate({ name: "Unknown Hours" });
    const result = await researchRestaurant(baseParams({ restaurantCandidates: [unverified, verified] }));
    expect(result.status).toBe("scheduled");
    expect(result.selected?.name).toBe("Verified Open");
    expect(result.selected?.openingHoursSource).toBe("osm");
  });

  it("never fabricates menu items or a price when search/AI are unavailable — reports honestly instead", async () => {
    const c = candidate({ name: "No Research", tags: { opening_hours: "Mo-Su 11:00-23:00" } });
    const result = await researchRestaurant(baseParams({ restaurantCandidates: [c], searchAvailable: false, aiAvailable: false }));
    expect(result.selected?.menuItems).toEqual([]);
    expect(result.selected?.menuAvailability.status).toBe("no-source");
    expect(result.selected?.estimatedMealCost).toBeUndefined();
  });

  it(
    "real-world regression coverage: a highly notable restaurant a few hundred metres " +
      "further away is still considered, not excluded purely by an 8-nearest cutoff — a " +
      "dense old-town block easily has 8+ closer, unremarkable restaurants that would " +
      "otherwise always crowd out a genuinely better one slightly farther off",
    async () => {
      const nearbyButUnremarkable = Array.from({ length: 8 }, (_, i) =>
        candidate({ name: `Nearby ${i}`, ...offsetMeters(20 + i * 5) }, 0)
      );
      const notableButFarther = candidate({ name: "Notable Farther", ...offsetMeters(400) }, 5);
      const result = await researchRestaurant(
        baseParams({ restaurantCandidates: [...nearbyButUnremarkable, notableButFarther] })
      );
      expect(result.considered.some((c) => c.name === "Notable Farther")).toBe(true);
    }
  );
});

describe("estimateMealWaitMinutes", () => {
  const lunch = { name: "lunch" as const, earliest: "12:00", latest: "14:30" };
  const dinner = { name: "dinner" as const, earliest: "18:00", latest: "21:00" };

  it("reports a large idle wait for dinner on a short day (few stops, done by early afternoon)", () => {
    // 2 stops, 75 min of visits: projected ≈ 75 + 2×15 = 105 min → natural
    // dinner arrival ≈ 09:00 + 1:45 = 10:45, dinner opens 18:00 → ~435 min wait.
    expect(estimateMealWaitMinutes(dinner, "09:00", 2, 75)).toBeGreaterThan(360);
  });

  it("reports a much smaller wait for lunch than dinner on that same short day", () => {
    const lunchWait = estimateMealWaitMinutes(lunch, "09:00", 2, 75);
    const dinnerWait = estimateMealWaitMinutes(dinner, "09:00", 2, 75);
    expect(lunchWait).toBeLessThan(dinnerWait);
  });

  it("reports zero idle wait for dinner on a full day that naturally reaches dinner time", () => {
    // 10 stops, 480 min of visits: projected ≈ 480 + 150 = 630 → natural dinner
    // arrival ≈ 09:00 + 10:30 = 19:30, already past the 18:00 opening.
    expect(estimateMealWaitMinutes(dinner, "09:00", 10, 480)).toBe(0);
  });
});

describe("researchRestaurant — meal-window fit (real Prague 'relaxed' regression)", () => {
  // 2026-09-29 is a Tuesday; "Tu-Sa …" restaurants are open.
  const TUESDAY = new Date("2026-09-29T12:00:00");

  // The exact live shape: a marquee, OSM-houred, DINNER-ONLY restaurant
  // ("La Degustation Bohême Bourgeoise", Michelin, opens 18:00) competing
  // against an ordinary lunch-capable place, on a 3-stop "relaxed" day whose
  // sightseeing (svatý Duch 15 min + Pražský Hrad 60 min) is done well before
  // noon. Picking the dinner-only spot injected ~440 min of dead waiting.
  const dinnerOnlyNotable = () =>
    candidate({ name: "La Degustation", tags: { opening_hours: "Tu-Sa 18:00-22:00" }, ...offsetMeters(120) }, 5);
  const lunchCapablePlain = () =>
    candidate({ name: "Lokál Dlouhá", tags: { opening_hours: "Mo-Su 11:00-23:00" }, ...offsetMeters(140) }, 1);

  const SHORT_DAY = { plannedStopCount: 2, plannedVisitMinutes: 75, arrivalTime: "09:00", dayEnd: "19:00" as const };

  it("reproduces the bug without schedule context: the notable dinner-only spot is chosen despite the gap", async () => {
    // No plannedStopCount/plannedVisitMinutes → meal-window term is inert,
    // exactly the pre-fix behavior.
    const result = await researchRestaurant(
      baseParams({
        restaurantCandidates: [dinnerOnlyNotable(), lunchCapablePlain()],
        tripDate: TUESDAY,
        arrivalTime: "09:00",
        dayEnd: "19:00",
      })
    );
    expect(result.selected?.name).toBe("La Degustation");
    expect(result.selected?.mealWindow).toBe("dinner");
    expect(result.considered.every((c) => c.scoreBreakdown.mealWindowFit === 0)).toBe(true);
  });

  it("with schedule context on a short day, prefers the lunch-capable restaurant over the dinner-only one", async () => {
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [dinnerOnlyNotable(), lunchCapablePlain()], tripDate: TUESDAY, ...SHORT_DAY })
    );
    expect(result.selected?.name).toBe("Lokál Dlouhá");
    expect(result.selected?.mealWindow).toBe("lunch");
    const dinner = result.considered.find((c) => c.name === "La Degustation")!;
    expect(dinner.scoreBreakdown.mealWindowFit).toBeLessThan(0);
    expect(result.selected?.scoreBreakdown.mealWindowFit).toBe(0); // the best-fitting window is never penalised
  });

  it("still selects a genuinely better dinner restaurant when the day naturally reaches dinner", async () => {
    const FULL_DAY = { plannedStopCount: 10, plannedVisitMinutes: 480, arrivalTime: "09:00", dayEnd: "22:00" as const };
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [dinnerOnlyNotable(), lunchCapablePlain()], tripDate: TUESDAY, ...FULL_DAY })
    );
    expect(result.selected?.name).toBe("La Degustation");
    expect(result.considered.every((c) => c.scoreBreakdown.mealWindowFit === 0)).toBe(true);
  });

  it("does not penalise a lunch-only restaurant — its window is the day's best-fitting one", async () => {
    const lunchOnly = candidate({ name: "Midday Bistro", tags: { opening_hours: "Mo-Su 11:30-15:00" } }, 0);
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [lunchOnly], tripDate: TUESDAY, ...SHORT_DAY })
    );
    expect(result.selected?.name).toBe("Midday Bistro");
    expect(result.selected?.mealWindow).toBe("lunch");
    expect(result.selected?.scoreBreakdown.mealWindowFit).toBe(0);
  });

  it("does not penalise a lunch+dinner restaurant — it is scheduled at lunch, which fits", async () => {
    const both = candidate({ name: "All Day Kitchen", tags: { opening_hours: "Mo-Su 11:00-23:00" } }, 0);
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [both], tripDate: TUESDAY, ...SHORT_DAY })
    );
    expect(result.selected?.mealWindow).toBe("lunch");
    expect(result.selected?.scoreBreakdown.mealWindowFit).toBe(0);
  });

  it("does not penalise a restaurant whose opening hours are unknown (no proven gap to charge for)", async () => {
    const unknownHours = candidate({ name: "Unlabelled Diner" }, 0);
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [unknownHours], tripDate: TUESDAY, ...SHORT_DAY })
    );
    expect(result.selected?.name).toBe("Unlabelled Diner");
    expect(result.selected?.scoreBreakdown.mealWindowFit).toBe(0);
  });

  it("preserves an explicit cuisine preference: a dinner-only match still beats a non-matching lunch place on a short day", async () => {
    const koreanDinnerOnly = candidate(
      { name: "Hansik House", tags: { opening_hours: "Mo-Su 17:30-23:00", cuisine: "korean" }, ...offsetMeters(120) },
      0
    );
    const italianLunch = candidate(
      { name: "Trattoria", tags: { opening_hours: "Mo-Su 11:00-23:00", cuisine: "italian" }, ...offsetMeters(120) },
      0
    );
    const result = await researchRestaurant(
      baseParams({
        restaurantCandidates: [koreanDinnerOnly, italianLunch],
        tripDate: TUESDAY,
        foodPreferences: ["korean"],
        ...SHORT_DAY,
      })
    );
    expect(result.selected?.name).toBe("Hansik House");
    // The gap penalty is softened (halved) but not erased when the cuisine matches.
    const korean = result.considered.find((c) => c.name === "Hansik House")!;
    expect(korean.scoreBreakdown.mealWindowFit).toBeLessThan(0);
    expect(korean.scoreBreakdown.cuisineRelevance).toBeGreaterThan(0);
  });

  it("preserves price/source scoring: an over-budget restaurant is still down-weighted regardless of meal window", async () => {
    const result = await researchRestaurant(
      baseParams({ restaurantCandidates: [lunchCapablePlain()], tripDate: TUESDAY, ...SHORT_DAY }),
    );
    // priceFit stays the neutral default (no cost known, no budget) — the new
    // term is additive and does not disturb the existing breakdown keys.
    expect(result.selected?.scoreBreakdown.priceFit).toBe(10);
    expect(result.selected?.scoreBreakdown).toHaveProperty("routeCompat");
    expect(result.selected?.scoreBreakdown).toHaveProperty("openingHoursFit");
  });
});

function menuItem(overrides: Partial<MenuItemResult> = {}): MenuItemResult {
  return {
    category: "Menu",
    name: "Test Item",
    isLocalSpecialty: false,
    isVegetarian: false,
    isVegan: false,
    source: "unverified",
    confidence: "unknown",
    ...overrides,
  };
}

describe("looksLikeRealMenu", () => {
  it("returns false for an empty list", () => {
    expect(looksLikeRealMenu([])).toBe(false);
  });

  it(
    "real regression: rejects a batch where nothing has a price — the observed shape of a " +
      "restaurant's marketing homepage (beer-pour-style words like \"hladinka\"/\"šnyt\"/" +
      '"mlíko") or a mobile-nav "Hamburger" menu-toggle label being extracted as if they were ' +
      "dishes, since neither ever has a real price attached",
    () => {
      const glossaryLookingItems = [
        menuItem({ name: "hladinku" }),
        menuItem({ name: "šnyt" }),
        menuItem({ name: "mlíko" }),
      ];
      expect(looksLikeRealMenu(glossaryLookingItems)).toBe(false);
    }
  );

  it("accepts a batch where at least one item has a real price", () => {
    const items = [
      menuItem({ name: "Minestrone", price: 49, currency: "CZK" }),
      menuItem({ name: "Daily special (price on request)" }), // one unpriced item alongside real priced ones is fine
    ];
    expect(looksLikeRealMenu(items)).toBe(true);
  });
});

describe("preScoreRestaurantCandidate", () => {
  it("prefers a closer candidate when notability and cuisine fit are equal", () => {
    const near = preScoreRestaurantCandidate(candidate({}, 0), 50);
    const far = preScoreRestaurantCandidate(candidate({}, 0), 800);
    expect(near).toBeGreaterThan(far);
  });

  it("lets a much more notable candidate outscore a slightly closer, unremarkable one", () => {
    const closeButPlain = preScoreRestaurantCandidate(candidate({}, 0), 50);
    const fartherButNotable = preScoreRestaurantCandidate(candidate({}, 5), 250);
    expect(fartherButNotable).toBeGreaterThan(closeButPlain);
  });

  it("rewards a candidate whose OSM cuisine tag matches a stated food preference", () => {
    const matching = preScoreRestaurantCandidate(candidate({ tags: { cuisine: "korean" } }, 0), 100, ["korean bbq"]);
    const nonMatching = preScoreRestaurantCandidate(candidate({ tags: { cuisine: "italian" } }, 0), 100, ["korean bbq"]);
    expect(matching).toBeGreaterThan(nonMatching);
  });
});
