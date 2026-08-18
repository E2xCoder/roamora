import { describe, expect, it } from "vitest";
import { haversine, formatDistance, formatDuration } from "@/lib/place-meta";

describe("haversine", () => {
  it("returns zero for identical points", () => {
    const p = { lat: 50.0875, lng: 14.4213 };
    expect(haversine(p, p)).toBe(0);
  });

  it("matches a known distance", () => {
    // Charles Bridge -> Prague Castle, ~1.2 km as the crow flies.
    const charlesBridge = { lat: 50.0865, lng: 14.4114 };
    const praguecastle = { lat: 50.0900, lng: 14.4006 };
    const d = haversine(charlesBridge, praguecastle);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(1400);
  });

  it("is symmetric", () => {
    const a = { lat: 41.0082, lng: 28.9784 };
    const b = { lat: 48.8566, lng: 2.3522 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 6);
  });

  it("handles antimeridian-spanning pairs without producing NaN", () => {
    const a = { lat: 0, lng: 179.9 };
    const b = { lat: 0, lng: -179.9 };
    const d = haversine(a, b);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });
});

describe("formatDistance", () => {
  it("uses metres below a kilometre", () => {
    expect(formatDistance(450)).toBe("450 m");
  });

  it("switches to kilometres at 1000 m", () => {
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1540)).toBe("1.5 km");
  });

  it("renders zero as unknown rather than '0 m'", () => {
    // A missing leg should not read as a real zero-length walk.
    expect(formatDistance(0)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("uses minutes below an hour", () => {
    expect(formatDuration(600)).toBe("10 dk");
  });

  it("splits into hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1 sa");
    expect(formatDuration(5400)).toBe("1 sa 30 dk");
  });

  it("renders zero as unknown", () => {
    expect(formatDuration(0)).toBe("—");
  });
});
