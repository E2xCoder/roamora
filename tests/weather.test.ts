import { describe, expect, it } from "vitest";
import { classifyWeatherCode, isBadWeatherDay } from "@/server/providers/research/weather";

describe("classifyWeatherCode", () => {
  it("classifies real WMO clear-sky codes", () => {
    expect(classifyWeatherCode(0)).toBe("clear");
    expect(classifyWeatherCode(1)).toBe("clear");
  });

  it("classifies real WMO cloudy codes", () => {
    expect(classifyWeatherCode(2)).toBe("cloudy");
    expect(classifyWeatherCode(3)).toBe("cloudy");
  });

  it("classifies real WMO fog codes", () => {
    expect(classifyWeatherCode(45)).toBe("fog");
    expect(classifyWeatherCode(48)).toBe("fog");
  });

  it("classifies real WMO rain/drizzle/rain-shower codes", () => {
    expect(classifyWeatherCode(51)).toBe("rain"); // light drizzle
    expect(classifyWeatherCode(63)).toBe("rain"); // moderate rain
    expect(classifyWeatherCode(67)).toBe("rain"); // heavy freezing rain
    expect(classifyWeatherCode(80)).toBe("rain"); // slight rain showers
    expect(classifyWeatherCode(82)).toBe("rain"); // violent rain showers
  });

  it("classifies real WMO snow codes", () => {
    expect(classifyWeatherCode(71)).toBe("snow");
    expect(classifyWeatherCode(77)).toBe("snow"); // snow grains
    expect(classifyWeatherCode(85)).toBe("snow"); // snow showers
    expect(classifyWeatherCode(86)).toBe("snow");
  });

  it("classifies real WMO thunderstorm codes", () => {
    expect(classifyWeatherCode(95)).toBe("storm");
    expect(classifyWeatherCode(99)).toBe("storm"); // thunderstorm with heavy hail
  });

  it("treats an unrecognised code as the mildest non-clear bucket rather than guessing", () => {
    expect(classifyWeatherCode(9999)).toBe("cloudy");
  });
});

describe("isBadWeatherDay", () => {
  function forecast(overrides: Partial<Parameters<typeof isBadWeatherDay>[0]> = {}) {
    return {
      date: "2026-09-10",
      weatherCode: 0,
      condition: "clear" as const,
      precipitationProbability: null,
      temperatureMaxC: 20,
      temperatureMinC: 10,
      ...overrides,
    };
  }

  it("is never bad for a clear or cloudy day", () => {
    expect(isBadWeatherDay(forecast({ condition: "clear" }))).toBe(false);
    expect(isBadWeatherDay(forecast({ condition: "cloudy" }))).toBe(false);
  });

  it("is never bad for fog alone", () => {
    expect(isBadWeatherDay(forecast({ condition: "fog" }))).toBe(false);
  });

  it("is always bad for a storm, regardless of precipitation probability", () => {
    expect(isBadWeatherDay(forecast({ condition: "storm", precipitationProbability: null }))).toBe(true);
    expect(isBadWeatherDay(forecast({ condition: "storm", precipitationProbability: 5 }))).toBe(true);
  });

  it("is bad for rain at or above 50% probability", () => {
    expect(isBadWeatherDay(forecast({ condition: "rain", precipitationProbability: 50 }))).toBe(true);
    expect(isBadWeatherDay(forecast({ condition: "rain", precipitationProbability: 90 }))).toBe(true);
  });

  it("is NOT bad for rain below 50% probability — a low-chance drizzle should not flip the whole day", () => {
    expect(isBadWeatherDay(forecast({ condition: "rain", precipitationProbability: 10 }))).toBe(false);
    expect(isBadWeatherDay(forecast({ condition: "rain", precipitationProbability: 49 }))).toBe(false);
  });

  it("treats missing probability data for rain/snow as bad — real evidence of rain with no known odds is not treated as safe", () => {
    expect(isBadWeatherDay(forecast({ condition: "rain", precipitationProbability: null }))).toBe(true);
    expect(isBadWeatherDay(forecast({ condition: "snow", precipitationProbability: null }))).toBe(true);
  });

  it("applies the same 50% threshold to snow", () => {
    expect(isBadWeatherDay(forecast({ condition: "snow", precipitationProbability: 60 }))).toBe(true);
    expect(isBadWeatherDay(forecast({ condition: "snow", precipitationProbability: 20 }))).toBe(false);
  });
});
