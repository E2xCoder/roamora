import { describe, expect, it } from "vitest";
import { scoreConfidence, isOfficialSource, detectStaleness, selectBestResult, hasNameRelevance } from "@/server/services/confidence";
import type { WebSearchResult } from "@/server/providers/research/types";

describe("scoreConfidence", () => {
  it("official source + exact price found (unambiguous, not stale) -> HIGH", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: true,
        extractionAmbiguous: false,
        stale: false,
        multiSourceAgreement: null,
      })
    ).toBe("high");
  });

  it("official website but ambiguous extraction -> MEDIUM", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: true,
        extractionAmbiguous: true,
        stale: false,
        multiSourceAgreement: null,
      })
    ).toBe("medium");
  });

  it("official source but stale content -> MEDIUM, not HIGH", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: true,
        extractionAmbiguous: false,
        stale: true,
        multiSourceAgreement: null,
      })
    ).toBe("medium");
  });

  it("third-party travel page only -> LOW", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: false,
        extractionAmbiguous: false,
        stale: false,
        multiSourceAgreement: null,
      })
    ).toBe("low");
  });

  it("model guess without source support -> UNKNOWN, regardless of everything else", () => {
    expect(
      scoreConfidence({
        textuallySupported: false,
        officialSource: true,
        extractionAmbiguous: false,
        stale: false,
        multiSourceAgreement: true,
      })
    ).toBe("unknown");
  });

  it("two independent third-party sources agreeing -> MEDIUM (corroboration compensates for not official)", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: false,
        extractionAmbiguous: false,
        stale: false,
        multiSourceAgreement: true,
      })
    ).toBe("medium");
  });

  it("two sources actively disagree -> LOW even if the first looked official", () => {
    expect(
      scoreConfidence({
        textuallySupported: true,
        officialSource: true,
        extractionAmbiguous: false,
        stale: false,
        multiSourceAgreement: false,
      })
    ).toBe("low");
  });
});

describe("isOfficialSource", () => {
  it("recognizes a place's own domain (real case: Rijksmuseum)", () => {
    expect(
      isOfficialSource(
        "https://www.rijksmuseum.nl/de/besuchen/praktische-info/offnungszeiten-und-preise",
        "Öffnungszeiten und preise - Rijksmuseum",
        "Rijksmuseum"
      )
    ).toBe(true);
  });

  it("recognizes an explicit 'OFFICIAL' title claim on a non-matching-slug domain (real case: Eiffel Tower)", () => {
    expect(
      isOfficialSource(
        "https://www.toureiffel.paris/fr/tarifs-horaires",
        "Tarifs des billets et horaires - La tour Eiffel site OFFICIEL",
        "Eiffel Tower"
      )
    ).toBe(true);
  });

  it("rejects a third-party reseller domain despite an hours-focused title (real case: Hagia Sophia)", () => {
    expect(
      isOfficialSource(
        "https://www.hagia-sophia-tickets.com/tr/hagia-sophia-opening-hours/",
        "Ayasofya Açılış Saatleri ve En İyi Ziyaret Saatleri",
        "Hagia Sophia"
      )
    ).toBe(false);
  });

  it("recognizes a restaurant's own domain (real case: Zur letzten Instanz)", () => {
    expect(
      isOfficialSource("https://zurletzteninstanz.com/menu/", "Menu - Zur letzten Instanz", "Zur Letzten Instanz")
    ).toBe(true);
  });

  it(
    "recognizes a domain that is a substring of the place name, not just the reverse " +
      '(regression: a live run found "Brama Poznania ICHOT" against ' +
      '"bramapoznania.pl" returned false — the one-directional check only handled a ' +
      "domain containing the full place name, not a domain matching just its first words)",
    () => {
      expect(
        isOfficialSource("https://bramapoznania.pl/cennik", "Cennik - Brama Poznania ICHOT", "Brama Poznania ICHOT")
      ).toBe(true);
    }
  );

  it("returns false for an unrelated third-party page with no official claim", () => {
    expect(
      isOfficialSource("https://randomtravelblog.example/best-museums", "10 Best Museums to Visit", "Rijksmuseum")
    ).toBe(false);
  });

  it(
    "rejects a short generic word matching only a small prefix of a longer place name " +
      '(regression: a live run had "Stary Rynek Poznań" — "Old Market Square" — match ' +
      '"stary.at", an unrelated Austrian roofing company, because "stary" (Polish for ' +
      '"old") is literally the first 5 of the slug\'s 16 characters. The bidirectional ' +
      "check's absolute length minimum alone wasn't enough; it also needs the shorter " +
      "string to cover a real proportion of the longer one, not just meet a floor.)",
    () => {
      expect(isOfficialSource("https://stary.at/", "Stary - Dach, Fassade, Bad", "Stary Rynek Poznań")).toBe(false);
    }
  );

  it("still recognizes a short domain that covers most of a short place name (not just Brama Poznania's longer case)", () => {
    expect(isOfficialSource("https://rijksmuseum.nl/en", "Home - Rijksmuseum", "Rijksmuseum")).toBe(true);
  });

  it("returns false for a malformed URL rather than throwing", () => {
    expect(isOfficialSource("not a url", "Rijksmuseum Official", "Rijksmuseum")).toBe(false);
  });
});

describe("detectStaleness", () => {
  it("flags an explicit 'last updated <old year>' marker", () => {
    expect(detectStaleness("Hours: Mo-Fr 9-17. Last updated 2019.", new Date("2026-08-21"))).toBe(true);
  });

  it("does not flag a recent update marker", () => {
    expect(detectStaleness("Hours: Mo-Fr 9-17. Last updated 2026.", new Date("2026-08-21"))).toBe(false);
  });

  it("does not flag undated content as stale — absence of a date is not evidence of staleness", () => {
    expect(detectStaleness("Hours: Mo-Fr 9:00-17:00, Adults €25.", new Date("2026-08-21"))).toBe(false);
  });

  it("does not flag an unrelated year mention (e.g. a founding year) as an update marker", () => {
    expect(detectStaleness("Founded in 1885. Hours: Mo-Fr 9-17.", new Date("2026-08-21"))).toBe(false);
  });
});

function result(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { title: "Result", url: "https://example.com/", snippet: "", ...overrides };
}

describe("selectBestResult", () => {
  it(
    "real case: prefers the official result even when it is not first " +
      "(Anne Frank House — index 0 was a Wikipedia disambiguation stub for the name " +
      '"Anne", the real official ticket page was further down the list)',
    () => {
      const results = [
        result({ title: "Anne – Wikipedia", url: "https://de.m.wikipedia.org/wiki/Anne" }),
        result({ title: "Tickets | Anne Frank House", url: "https://www.annefrank.org/en/museum/tickets/" }),
      ];
      expect(selectBestResult(results, "Anne Frank House")?.url).toBe("https://www.annefrank.org/en/museum/tickets/");
    }
  );

  it(
    "production-hardening fix (spec §3, was a documented limitation before this pass): " +
      'when NEITHER result shares any real word with the place name (real case: "St. Vitus ' +
      'Cathedral" vs the real official site katedralasvatehovita.cz, Czech for "cathedral of ' +
      'St. Vitus" — no shared token even after normalization) this used to silently fall back ' +
      "to the first result regardless of relevance — real, live-caught case: a restaurant " +
      "search returning an unrelated Microsoft support page as the \"selected\" source (see " +
      "the hasNameRelevance test below). Now returns undefined — no source is more honest " +
      "than a confidently wrong one.",
    () => {
      const results = [
        result({ title: "STMicroelectronics: Our technology starts with you", url: "https://www.st.com/content/st_com/en.html" }),
        result({ title: "For visitors - Katedrála svatého Víta", url: "https://www.katedralasvatehovita.cz/en/for-visitors/" }),
      ];
      expect(selectBestResult(results, "St. Vitus Cathedral")).toBeUndefined();
    }
  );

  it(
    "real regression case: a restaurant search whose top results include a completely " +
      'unrelated page (live-observed: searching "Oseyo25" Poznań restaurant menu prices ' +
      "surfaced a Microsoft Windows audio-troubleshooting support page as the SearXNG " +
      'result later fed to menu extraction as this restaurant\'s "source") — filtered out ' +
      "entirely rather than selected, since it shares no real word with the place name",
    () => {
      const results = [
        result({
          title: "Fix sound or audio problems in Windows",
          url: "https://support.microsoft.com/en-US/Windows/Hardware/Audio/fix-sound-or-audio-problems-in-windows",
        }),
      ];
      expect(selectBestResult(results, "Oseyo25")).toBeUndefined();
    }
  );

  it("among two non-official results, prefers higher engine agreement over plain rank order", () => {
    const results = [
      result({ title: "Weak match", url: "https://blog.example/a", engineAgreement: 1 }),
      result({ title: "Strong cross-engine agreement", url: "https://blog.example/b", engineAgreement: 3 }),
    ];
    expect(selectBestResult(results, "Blog Example")?.url).toBe("https://blog.example/b");
  });

  it("falls back to SearXNG's own score as a tie-breaker when agreement is equal", () => {
    const results = [
      result({ title: "Lower score", url: "https://blog.example/a", engineAgreement: 1, score: 2 }),
      result({ title: "Higher score", url: "https://blog.example/b", engineAgreement: 1, score: 9 }),
    ];
    expect(selectBestResult(results, "Blog Example")?.url).toBe("https://blog.example/b");
  });

  it("preserves original order among true ties (stable sort, no arbitrary reshuffling)", () => {
    const results = [result({ url: "https://a.example/" }), result({ url: "https://b.example/" })];
    expect(selectBestResult(results, "Example")?.url).toBe("https://a.example/");
  });

  it("returns undefined for an empty result list", () => {
    expect(selectBestResult([], "Some Place")).toBeUndefined();
  });
});

describe("hasNameRelevance", () => {
  it("passes when the result shares a real word with the place name", () => {
    expect(hasNameRelevance(result({ title: "Jolly Restaurant Berlin", url: "https://restaurant-jolly.de/" }), "Jolly")).toBe(true);
  });

  it("fails when nothing in the title or URL relates to the place name at all", () => {
    expect(
      hasNameRelevance(
        result({ title: "Fix sound or audio problems in Windows", url: "https://support.microsoft.com/windows/audio" }),
        "Oseyo25"
      )
    ).toBe(false);
  });

  it("skips the check (returns true) for a name with no token 3+ characters long", () => {
    expect(hasNameRelevance(result({ title: "Anything at all" }), "A B")).toBe(true);
  });
});
