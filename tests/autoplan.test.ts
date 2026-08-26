import { describe, expect, it } from "vitest";
import { selectEventDiscoverySource } from "@/server/services/autoplan";
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
    "known, related, distinct limitation found while testing this fix — NOT addressed here: " +
      'hasNameRelevance rejects a genuinely relevant Czech source using the native "Praha" ' +
      'spelling when req.destination is the English "Prague" exonym, since neither name is a ' +
      "substring of the other. A real event-shaped page can still be filtered out upstream by " +
      "this separate check before selectEventDiscoverySource's own event-keyword scoring ever " +
      "gets a chance to prefer it.",
    () => {
      const results = [
        result({ title: "Praha - Akce a Program", url: "https://www.example-praha.cz/akce" }),
      ];
      expect(selectEventDiscoverySource(results, "Prague")).toBeUndefined();
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
