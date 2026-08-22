import { describe, expect, it } from "vitest";
import { isOutdoorCategory, isIndoorCategory, applyWeatherWeights } from "@/server/services/weather-routing";

describe("isOutdoorCategory / isIndoorCategory", () => {
  it("classifies real outdoor taxonomy categories", () => {
    for (const c of ["viewpoint", "park", "nature", "beach", "hike", "monument", "landmark"]) {
      expect(isOutdoorCategory(c)).toBe(true);
      expect(isIndoorCategory(c)).toBe(false);
    }
  });

  it("classifies real indoor taxonomy categories", () => {
    for (const c of ["museum", "church", "castle", "historic", "architecture"]) {
      expect(isIndoorCategory(c)).toBe(true);
      expect(isOutdoorCategory(c)).toBe(false);
    }
  });

  it("treats an ambiguous/neutral category as neither", () => {
    expect(isOutdoorCategory("attraction")).toBe(false);
    expect(isIndoorCategory("attraction")).toBe(false);
    expect(isOutdoorCategory("restaurant")).toBe(false);
    expect(isIndoorCategory("restaurant")).toBe(false);
  });
});

describe("applyWeatherWeights", () => {
  const allCategories = ["museum", "park", "church", "viewpoint", "attraction"];

  it("returns the weights completely unchanged on a good-weather day", () => {
    const base = { museum: 3 };
    const result = applyWeatherWeights(base, allCategories, false);
    expect(result).toEqual({ museum: 3 });
  });

  it("does not mutate the caller's original weights object", () => {
    const base = { museum: 3 };
    applyWeatherWeights(base, allCategories, true);
    expect(base).toEqual({ museum: 3 }); // unchanged — a fresh copy was returned, not a mutation
  });

  it("boosts indoor categories and reduces outdoor categories on a bad-weather day", () => {
    const result = applyWeatherWeights({}, allCategories, true);
    expect(result.museum).toBeGreaterThan(1);
    expect(result.church).toBeGreaterThan(1);
    expect(result.park).toBeLessThan(1);
    expect(result.viewpoint).toBeLessThan(1);
  });

  it("leaves a neutral/ambiguous category's weight untouched even on a bad-weather day", () => {
    const result = applyWeatherWeights({ attraction: 5 }, allCategories, true);
    expect(result.attraction).toBe(5);
  });

  it("applies the multiplier on top of the user's own existing interest weight, not instead of it", () => {
    const result = applyWeatherWeights({ museum: 3, park: 3 }, allCategories, true);
    expect(result.museum).toBeGreaterThan(3); // still gets the user's own boost, amplified further
    expect(result.park).toBeLessThan(3); // reduced, but not to zero — the user's stated interest still counts for something
    expect(result.park).toBeGreaterThan(0);
  });
});
