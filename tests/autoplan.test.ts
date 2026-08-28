import { describe, expect, it } from "vitest";
import { selectEventDiscoverySource, deriveOsmVerifiedFreePrice, buildNoCandidatesError } from "@/server/services/autoplan";
import type { WebSearchResult } from "@/server/providers/research/types";

function result(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { title: "Result", url: "https://example.com/", snippet: "", ...overrides };
}

describe("selectEventDiscoverySource", () => {
  it(
    "real regression: prefers an event-shaped candidate over a generic, official-looking " +
      'travel-guide site — real case: "prague-cz.com" (a "top attractions / where to stay" ' +
      "landing page with zero actual dated events) reads as official-looking by domain slug " +
      'alone and used to win every time, even against a real "whats-on" events page in the ' +
      "same result set",
    () => {
      const results = [
        result({ title: "Prague - Czech Republic | Top Attractions & Hotels", url: "https://prague-cz.com/en/" }),
        result({ title: "What's On in Prague - Events Calendar", url: "https://www.prague.eu/en/whats-on" }),
      ];
      expect(selectEventDiscoverySource(results, "Prague")?.url).toBe("https://www.prague.eu/en/whats-on");
    }
  );

  it("recognizes the real Czech event keyword 'akce' as an event-shaped signal", () => {
    // Both candidates mention "Prague" (real, common bilingual-site behavior for tourism
    // content) so this isolates the actual thing being tested — the "akce" keyword itself —
    // from hasNameRelevance's separate, real "Praha" vs "Prague" endonym/exonym gap (found
    // while writing this test, but a distinct issue from event-shaped source selection).
    const results = [
      result({ title: "Prague Hotels & Attractions", url: "https://prague-guide.example/en/" }),
      result({ title: "Prague - Akce a Program (Events)", url: "https://www.example-prague.cz/akce" }),
    ];
    expect(selectEventDiscoverySource(results, "Prague")?.url).toBe("https://www.example-prague.cz/akce");
  });

  it(
    "real regression, now fixed: a genuinely relevant Czech source using the native \"Praha\" " +
      'spelling used to be rejected outright when destination was the English "Prague" exonym, ' +
      "before destinationAliases existed — without the alias it is still correctly filtered out " +
      "(never weakened for callers that don't have alias data); with the real, Nominatim-sourced " +
      'alias ("Praha", see geocode.ts\'s nameVariants) it is now correctly found and selected',
    () => {
      const results = [result({ title: "Praha - Akce a Program", url: "https://www.example-praha.cz/akce" })];
      expect(selectEventDiscoverySource(results, "Prague")).toBeUndefined();
      expect(selectEventDiscoverySource(results, "Prague", ["Praha"])?.url).toBe("https://www.example-praha.cz/akce");
    }
  );

  it("Vienna/Wien: finds a real event-shaped local-language source once the local-name alias is supplied", () => {
    const results = [result({ title: "Wien - Veranstaltungskalender September 2026", url: "https://example.at/events" })];
    expect(selectEventDiscoverySource(results, "Vienna")).toBeUndefined();
    expect(selectEventDiscoverySource(results, "Vienna", ["Wien"])?.url).toBe("https://example.at/events");
  });

  it(
    "does not let the alias mechanism accept an unrelated page just because it shares the " +
      "destination's country — a different real city (Brno) must still be rejected",
    () => {
      const results = [result({ title: "Brno - Akce a Program (Events)", url: "https://example-brno.cz/akce" })];
      expect(selectEventDiscoverySource(results, "Prague", ["Praha"])).toBeUndefined();
    }
  );

  it(
    "falls back to the previous official/relevance-based selection when NO candidate looks " +
      "event-shaped at all — never worse than before, only better when a real option exists",
    () => {
      const results = [
        result({ title: "Prague - Czech Republic | Top Attractions & Hotels", url: "https://prague-cz.com/en/" }),
      ];
      expect(selectEventDiscoverySource(results, "Prague")?.url).toBe("https://prague-cz.com/en/");
    }
  );

  it("still filters out results with no real relevance to the destination at all", () => {
    const results = [result({ title: "Fix sound or audio problems in Windows", url: "https://support.microsoft.com/audio" })];
    expect(selectEventDiscoverySource(results, "Prague")).toBeUndefined();
  });

  it("returns undefined for an empty result list", () => {
    expect(selectEventDiscoverySource([], "Prague")).toBeUndefined();
  });

  it("prefers the higher-scoring event-shaped candidate when multiple qualify", () => {
    const results = [
      result({ title: "Prague program listing", url: "https://example.com/prague/program" }),
      result({ title: "Prague events calendar and program", url: "https://example.com/prague/events-calendar" }),
    ];
    // Both are event-shaped; the second matches more keywords ("events" + "calendar") than the
    // first ("program" only), so it should be preferred.
    expect(selectEventDiscoverySource(results, "Prague")?.url).toBe("https://example.com/prague/events-calendar");
  });
});

describe("deriveOsmVerifiedFreePrice", () => {
  it(
    'real bug fix: OSM fee="no" (community-verified free admission) used to stay reported as ' +
      '"unverified"/unknown just because it was only ever used to SKIP price research, never to ' +
      "surface the fact it already had — real measured result before this fix: 11 Prague " +
      "attraction stops, 0 with any verified price/access signal, even for places OSM already " +
      "knew were free",
    () => {
      expect(deriveOsmVerifiedFreePrice("no")).toEqual({ priceSource: "osm", priceConfidence: "high", estimatedCost: 0 });
    }
  );

  it('fee="yes" (a real, likely-ticketed place — e.g. Museum Kampa, Sex Machines Museum) is not free by construction — must not be reported as verified-free', () => {
    expect(deriveOsmVerifiedFreePrice("yes")).toBeNull();
  });

  it("no OSM fee tag at all (e.g. Staronová synagoga, Klementinum) is genuinely unknown, not free — must not guess", () => {
    expect(deriveOsmVerifiedFreePrice(undefined)).toBeNull();
  });

  it('an unrelated fee value (e.g. "donation") is not the same fact as a confirmed "no" — must not be treated as verified-free', () => {
    expect(deriveOsmVerifiedFreePrice("donation")).toBeNull();
  });
});

describe("buildNoCandidatesError", () => {
  it(
    "real product bug: a transient Overpass 504/rate-limit used to surface as \"no places found around " +
      "<destination>\" — actively misleading for a real, data-rich city (live-observed case: Prague, " +
      "mid-plan, discovery.complete=false) since it reads as a fact about the destination rather than a " +
      "retry-worthy service hiccup",
    () => {
      const err = buildNoCandidatesError("Prague, Czech Republic", false);
      expect(err.code).toBe("DISCOVERY_UNAVAILABLE");
      expect(err.message).not.toContain("Prague");
      expect(err.message.toLowerCase()).toMatch(/ulaşılamıyor|tekrar/);
    }
  );

  it("a genuinely complete-but-empty discovery (a real tiny/remote destination) keeps the original, accurate message", () => {
    const err = buildNoCandidatesError("Nowhere Atoll", true);
    expect(err.code).toBe("NO_CANDIDATES");
    expect(err.message).toContain("Nowhere Atoll");
  });
});
