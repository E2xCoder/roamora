import { describe, expect, it } from "vitest";
import { deriveMaxStopsForPace } from "@/server/services/trip-options";

describe("deriveMaxStopsForPace", () => {
  it("increases stop count for max_experience relative to the caller's own request", () => {
    const base = 8;
    expect(deriveMaxStopsForPace(base, "max_experience")).toBeGreaterThan(base);
  });

  it("leaves stop count exactly unchanged for balanced", () => {
    expect(deriveMaxStopsForPace(8, "balanced")).toBe(8);
    expect(deriveMaxStopsForPace(5, "balanced")).toBe(5);
  });

  it("decreases stop count for relaxed relative to the caller's own request", () => {
    const base = 8;
    expect(deriveMaxStopsForPace(base, "relaxed")).toBeLessThan(base);
  });

  it("orders the three options consistently: relaxed <= balanced <= max_experience", () => {
    for (const base of [4, 6, 8, 10, 12, 16]) {
      const relaxed = deriveMaxStopsForPace(base, "relaxed");
      const balanced = deriveMaxStopsForPace(base, "balanced");
      const maxExp = deriveMaxStopsForPace(base, "max_experience");
      expect(relaxed).toBeLessThanOrEqual(balanced);
      expect(balanced).toBeLessThanOrEqual(maxExp);
    }
  });

  it("never goes below the real floor of 3 stops even for a very small base request", () => {
    expect(deriveMaxStopsForPace(1, "relaxed")).toBeGreaterThanOrEqual(3);
    expect(deriveMaxStopsForPace(2, "relaxed")).toBeGreaterThanOrEqual(3);
  });

  it("never exceeds the optimizer's real ceiling of 16 stops even for a very large base request", () => {
    expect(deriveMaxStopsForPace(16, "max_experience")).toBeLessThanOrEqual(16);
    expect(deriveMaxStopsForPace(14, "max_experience")).toBeLessThanOrEqual(16);
  });
});
