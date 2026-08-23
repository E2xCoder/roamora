import { describe, expect, it } from "vitest";
import { mealWindowsFor, restaurantStopInput, type RestaurantCandidateResult } from "@/server/services/restaurant";

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
