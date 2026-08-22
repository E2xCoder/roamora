import { describe, expect, it } from "vitest";
import { scoreConfidence, isOfficialSource, detectStaleness } from "@/server/services/confidence";

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
