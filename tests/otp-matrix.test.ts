import { describe, expect, it } from "vitest";
import { pairCacheKey } from "@/server/services/otp-matrix";

/**
 * Real regression coverage for the request-scoped transit-pair cache key
 * (production-hardening spec §1) — the part most likely to silently corrupt
 * data if wrong, since a collision would make routeAndOptimize() reuse one
 * pair's real OTP time for a completely different pair. The batching/
 * network orchestration around it is not unit-tested here, matching this
 * project's existing convention (see official-site-crawler.test.ts) of
 * testing pure logic directly rather than mocking fetch.
 */
describe("pairCacheKey", () => {
  const a = { lat: 52.4064, lng: 16.9252 }; // Poznań
  const b = { lat: 52.4095, lng: 16.9319 };

  it("is stable for the exact same pair, date, and time", () => {
    expect(pairCacheKey(a, b, "2026-09-01", "10:00")).toBe(pairCacheKey(a, b, "2026-09-01", "10:00"));
  });

  it("is directional — A→B and B→A are different keys (transit time is not symmetric)", () => {
    expect(pairCacheKey(a, b, "2026-09-01", "10:00")).not.toBe(pairCacheKey(b, a, "2026-09-01", "10:00"));
  });

  it("differs when the date differs (a schedule from a different day is a different real answer)", () => {
    expect(pairCacheKey(a, b, "2026-09-01", "10:00")).not.toBe(pairCacheKey(a, b, "2026-09-02", "10:00"));
  });

  it("differs when the time differs (different real departure, different real itinerary)", () => {
    expect(pairCacheKey(a, b, "2026-09-01", "10:00")).not.toBe(pairCacheKey(a, b, "2026-09-01", "10:05"));
  });

  it("differs for two distinct points even at very close coordinates", () => {
    const close = { lat: 52.40641, lng: 16.92521 };
    expect(pairCacheKey(a, b, "2026-09-01", "10:00")).not.toBe(pairCacheKey(close, b, "2026-09-01", "10:00"));
  });
});
