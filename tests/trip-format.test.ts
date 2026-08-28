import { describe, expect, it } from "vitest";
import { visitDurationMinutes, formatDuration, stopWeight, deriveDaySummary } from "@/lib/trip-format";
import type { DayResearchSummary } from "@/lib/autoplan-client";

describe("visitDurationMinutes", () => {
  it("real case: Sex Machines Museum 10:00-11:15 -> 75 minutes", () => {
    expect(visitDurationMinutes("10:00", "11:15")).toBe(75);
  });

  it("real case: Franz Kafka statue 09:13-09:23 -> 10 minutes", () => {
    expect(visitDurationMinutes("09:13", "09:23")).toBe(10);
  });

  it("returns null when either time is missing", () => {
    expect(visitDurationMinutes(null, "11:15")).toBeNull();
    expect(visitDurationMinutes("10:00", null)).toBeNull();
    expect(visitDurationMinutes(undefined, undefined)).toBeNull();
  });

  it("returns null for a non-positive span (never a negative or zero mental-math result)", () => {
    expect(visitDurationMinutes("11:00", "10:00")).toBeNull();
    expect(visitDurationMinutes("11:00", "11:00")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats under an hour as just minutes", () => {
    expect(formatDuration(10)).toBe("10dk");
    expect(formatDuration(45)).toBe("45dk");
  });

  it("real case: 75 minutes -> '1s 15dk'", () => {
    expect(formatDuration(75)).toBe("1s 15dk");
  });

  it("formats an exact hour with no leftover minutes", () => {
    expect(formatDuration(60)).toBe("1s");
    expect(formatDuration(120)).toBe("2s");
  });
});

describe("stopWeight", () => {
  it('a 5-10 minute stop (a statue, a photo point) is "quick"', () => {
    expect(stopWeight(5)).toBe("quick");
    expect(stopWeight(10)).toBe("quick");
    expect(stopWeight(20)).toBe("quick");
  });

  it('a real 75-minute museum visit is "major"', () => {
    expect(stopWeight(75)).toBe("major");
    expect(stopWeight(45)).toBe("major");
  });

  it('an in-between visit (e.g. a 30-minute church) is "standard"', () => {
    expect(stopWeight(30)).toBe("standard");
  });

  it("unknown duration is never classified as major or quick — stays standard", () => {
    expect(stopWeight(null)).toBe("standard");
  });
});

describe("deriveDaySummary", () => {
  function research(restaurantName?: string): DayResearchSummary {
    return {
      restaurant: restaurantName
        ? { status: "scheduled", selected: { stopId: "r1", name: restaurantName } as never }
        : { status: "no-candidates" },
      hiddenGems: { status: "none", found: [] },
      weather: { status: "unavailable", badWeatherDay: false, categoriesAdjusted: false },
      departureSafety: { hasDeparturePoint: false, bufferMinutes: 0, requestedDepartureTime: "", latestSafeArrivalTime: "", safe: true, overrunMinutes: 0 },
      budgetOptimization: null,
      budgetWarning: null,
      conflicts: [],
      totalCost: 0,
      costKnown: false,
      totalDistanceMeters: 0,
      events: [],
      provenance: [],
    };
  }

  it(
    "real regression: the day's real Prague activities (Franz Kafka 10min, Sex Machines Museum 75min, " +
      "Pekařství bakery 10min, U Pivrnce restaurant, Staronová synagoga 20min, Pinkasova synagoga 75min) " +
      "picks the two real anchor stops, chronologically ordered — not the restaurant, not the short stops",
    () => {
      const activities = [
        { placeName: "Franz Kafka", arrivalTime: "09:13", departureTime: "09:23" },
        { placeName: "Sex Machines Museum", arrivalTime: "10:00", departureTime: "11:15" },
        { placeName: "Pekařství v Dušní", arrivalTime: "11:21", departureTime: "11:31" },
        { placeName: "U Pivrnce", arrivalTime: "12:00", departureTime: "13:00" },
        { placeName: "Staronová synagoga", arrivalTime: "13:03", departureTime: "13:23" },
        { placeName: "Pinkasova synagoga", arrivalTime: "13:26", departureTime: "14:41" },
      ];
      expect(deriveDaySummary(activities, research("U Pivrnce"))).toBe("Sex Machines Museum + Pinkasova synagoga");
    }
  );

  it("returns null for an empty day", () => {
    expect(deriveDaySummary([], research())).toBeNull();
  });

  it("never includes the selected restaurant even if it happens to have the longest duration", () => {
    const activities = [
      { placeName: "Quick Stop", arrivalTime: "09:00", departureTime: "09:10" },
      { placeName: "Fancy Dinner", arrivalTime: "18:00", departureTime: "20:00" },
    ];
    expect(deriveDaySummary(activities, research("Fancy Dinner"))).toBe("Quick Stop");
  });

  it("falls back to fewer than two names when the day only has one real stop", () => {
    const activities = [{ placeName: "Only Stop", arrivalTime: "09:00", departureTime: "10:00" }];
    expect(deriveDaySummary(activities, research())).toBe("Only Stop");
  });
});
