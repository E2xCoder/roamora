import { describe, expect, it } from "vitest";
import { normalizeUrl } from "@/server/providers/source/types";
import { coordsFromGoogleUrl } from "@/server/providers/source/providers";
import {
  parseHtmlMeta,
  coordsFromJsonLd,
  extractHashtags,
} from "@/server/providers/source/html-meta";
import { checkBoilerplate } from "@/server/services/boilerplate";
import { guessCategoryFromText } from "@/server/services/classify";
import {
  extractLocationCandidates,
  combineConfidence,
} from "@/server/services/location-extraction";
import { nameSimilarity, normalizeName } from "@/server/services/dedup";
import { isPrivateIPv4, isPrivateIPv6 } from "@/server/services/url-safety";

describe("normalizeUrl", () => {
  it("strips tracking parameters so the same link dedupes", () => {
    const a = normalizeUrl(
      new URL("https://www.tiktok.com/@u/video/123?utm_source=x&is_from_webapp=1")
    );
    const b = normalizeUrl(new URL("https://tiktok.com/@u/video/123"));
    expect(a).toBe(b);
  });

  it("drops the fragment and trailing slash", () => {
    expect(normalizeUrl(new URL("https://example.com/a/#section"))).toBe(
      "https://example.com/a"
    );
  });

  it("keeps meaningful query parameters", () => {
    expect(normalizeUrl(new URL("https://youtube.com/watch?v=abc"))).toContain(
      "v=abc"
    );
  });
});

describe("coordsFromGoogleUrl", () => {
  it("reads the @lat,lng form", () => {
    expect(
      coordsFromGoogleUrl("https://www.google.com/maps/place/X/@50.0865,14.4114,17z")
    ).toEqual({ lat: 50.0865, lng: 14.4114 });
  });

  it("reads the !3d!4d form", () => {
    expect(coordsFromGoogleUrl("https://maps.google.com/?x=1!3d41.0082!4d28.9784")).toEqual(
      { lat: 41.0082, lng: 28.9784 }
    );
  });

  it("reads the ?q=lat,lng form", () => {
    expect(coordsFromGoogleUrl("https://maps.google.com/?q=48.8584,2.2945")).toEqual({
      lat: 48.8584,
      lng: 2.2945,
    });
  });

  it("rejects null island and out-of-range values", () => {
    expect(coordsFromGoogleUrl("https://x/@0.0,0.0,17z")).toBeNull();
    expect(coordsFromGoogleUrl("https://x/@91.0,14.0,17z")).toBeNull();
  });

  it("returns null when there are no coordinates", () => {
    expect(coordsFromGoogleUrl("https://www.google.com/maps")).toBeNull();
  });
});

describe("parseHtmlMeta", () => {
  const html = `
    <html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Charles Bridge &amp; Old Town">
      <meta property="og:description" content="A 14th-century bridge">
      <meta property="og:image" content="https://cdn.example/img.jpg">
      <script type="application/ld+json">
        {"@type":"TouristAttraction","geo":{"latitude":50.0865,"longitude":14.4114}}
      </script>
    </head></html>`;

  it("prefers OpenGraph over the title tag", () => {
    expect(parseHtmlMeta(html).title).toBe("Charles Bridge & Old Town");
  });

  it("decodes HTML entities", () => {
    expect(parseHtmlMeta(html).title).toContain("&");
    expect(parseHtmlMeta(html).title).not.toContain("&amp;");
  });

  it("falls back to <title> when OpenGraph is absent", () => {
    expect(parseHtmlMeta("<html><head><title>Only This</title></head></html>").title).toBe(
      "Only This"
    );
  });

  it("survives malformed JSON-LD without throwing", () => {
    const bad = `<script type="application/ld+json">{not json}</script>`;
    expect(() => parseHtmlMeta(bad)).not.toThrow();
    expect(parseHtmlMeta(bad).jsonLd).toEqual([]);
  });

  it("finds coordinates in JSON-LD geo blocks", () => {
    expect(coordsFromJsonLd(parseHtmlMeta(html).jsonLd)).toEqual({
      lat: 50.0865,
      lng: 14.4114,
    });
  });
});

describe("extractHashtags", () => {
  it("reads unicode hashtags", () => {
    expect(extractHashtags("güzel #istanbul ve #beşiktaş")).toEqual([
      "istanbul",
      "beşiktaş",
    ]);
  });
});

describe("checkBoilerplate", () => {
  it("rejects TikTok's generic page", () => {
    // Regression: this chrome was extracted as the place "Make Your Day" and
    // geocoded to an unrelated shop in Greece with 0.65 confidence.
    const v = checkBoilerplate("TikTok - Make Your Day", "");
    expect(v.isBoilerplate).toBe(true);
    expect(v.reason).toBeTruthy();
  });

  it("rejects Instagram login walls and Cloudflare interstitials", () => {
    expect(checkBoilerplate("Instagram", "").isBoilerplate).toBe(true);
    expect(checkBoilerplate("Just a moment...", "").isBoilerplate).toBe(true);
    expect(checkBoilerplate("Login • Instagram", "").isBoilerplate).toBe(true);
  });

  it("rejects empty metadata", () => {
    expect(checkBoilerplate(undefined, undefined).isBoilerplate).toBe(true);
    expect(checkBoilerplate("", "").isBoilerplate).toBe(true);
  });

  it("accepts genuine post content", () => {
    expect(
      checkBoilerplate("📍 Letná Park", "best sunset view in Prague").isBoilerplate
    ).toBe(false);
  });

  it("accepts a real title even without a description", () => {
    expect(checkBoilerplate("Charles Bridge", "").isBoilerplate).toBe(false);
  });
});

describe("guessCategoryFromText", () => {
  it("prefers the more specific rule", () => {
    // "coffee shop" must not land on shopping.
    expect(guessCategoryFromText("cosy coffee shop downtown")).toBe("cafe");
  });

  it("classifies across languages", () => {
    expect(guessCategoryFromText("harika bir kahvaltı mekanı")).toBe("cafe");
    expect(guessCategoryFromText("muhteşem manzara, gün batımı")).toBe("viewpoint");
    expect(guessCategoryFromText("zorlu bir yürüyüş rotası")).toBe("hike");
  });

  it("weights the place name over the surrounding text", () => {
    expect(guessCategoryFromText("great place to visit", "National Museum")).toBe(
      "museum"
    );
  });

  it("falls back to attraction rather than guessing", () => {
    expect(guessCategoryFromText("really nice spot")).toBe("attraction");
  });

  it("only ever returns a known taxonomy id", () => {
    for (const text of ["", "???", "castle hike cafe museum"]) {
      expect(typeof guessCategoryFromText(text)).toBe("string");
    }
  });
});

describe("extractLocationCandidates", () => {
  it("ranks the pin emoji highest", () => {
    const c = extractLocationCandidates("📍 Letná Park\nbest sunset in Prague");
    expect(c[0].name).toBe("Letná Park");
    expect(c[0].strategy).toBe("pin-emoji");
  });

  it("finds capitalised multi-word landmarks", () => {
    const names = extractLocationCandidates(
      "We walked across Charles Bridge at dawn"
    ).map((c) => c.name);
    expect(names).toContain("Charles Bridge");
  });

  it("drops generic travel hashtags", () => {
    const names = extractLocationCandidates("#travel #fyp #viral #wanderlust").map(
      (c) => c.name
    );
    expect(names).toHaveLength(0);
  });

  it("keeps place-like hashtags and splits camel case", () => {
    const names = extractLocationCandidates("#PragueCastle").map((c) => c.name);
    expect(names).toContain("Prague Castle");
  });

  it("returns nothing for empty input", () => {
    expect(extractLocationCandidates("")).toEqual([]);
    expect(extractLocationCandidates("   ")).toEqual([]);
  });

  it("does not emit punctuation-only or numeric candidates", () => {
    for (const c of extractLocationCandidates("### 123 !!! 456")) {
      expect(c.name).toMatch(/\p{L}/u);
    }
  });
});

describe("combineConfidence", () => {
  it("trusts explicit coordinates most", () => {
    expect(combineConfidence(0.3, false, true)).toBeGreaterThan(0.9);
  });

  it("penalises a candidate the geocoder could not confirm", () => {
    expect(combineConfidence(0.7, false)).toBeLessThan(0.4);
  });

  it("never reaches certainty on text plus geocoding alone", () => {
    expect(combineConfidence(1, true)).toBeLessThan(1);
  });
});

describe("dedup name matching", () => {
  it("ignores case, accents and articles", () => {
    expect(normalizeName("The Charles Bridge")).toBe(normalizeName("charles bridge"));
    expect(normalizeName("Letná Park")).toBe(normalizeName("letna park"));
  });

  it("scores identical names 1", () => {
    expect(nameSimilarity("Charles Bridge", "charles bridge")).toBe(1);
  });

  it("scores a contained name highly", () => {
    expect(nameSimilarity("Charles Bridge", "Charles Bridge Tower")).toBeGreaterThan(0.8);
  });

  it("scores unrelated names low", () => {
    expect(nameSimilarity("Charles Bridge", "Prague Castle")).toBeLessThan(0.4);
  });

  it("handles empty input without throwing", () => {
    expect(nameSimilarity("", "x")).toBe(0);
  });
});

describe("SSRF guards", () => {
  it("blocks loopback, private and link-local IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });

  it("blocks loopback and unique-local IPv6, including mapped IPv4", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
  });
});
