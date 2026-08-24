import { describe, expect, it } from "vitest";
import { validateExtractedPrice, normalizeCurrency } from "@/server/services/price-guard";

// Real plain text captured this session from bramapoznania.pl/cennik (Brama
// Poznania ICHOT's real, official ticket price page) — genuinely has both a
// standard adult price (35 zł) and a reduced/child-and-student price (29 zł)
// on the same page, which is exactly the ambiguity this guard exists for.
const REAL_BRAMA_POZNANIA_TEXT =
  "Cennik Bilety na ekspozycję Bramy Poznania Kup bilet Normalny 35 zł / od osoby " +
  "Przysługuje osobie dorosłej Normalny Poznańska Karta Turystyczna 21 zł / od osoby " +
  "Ulgowy 29 zł / od osoby Przysługuje: dzieciom i młodzieży szkolnej, studentom do 26. roku życia";

describe("validateExtractedPrice", () => {
  it("real case: the standard adult price (35 zł) on a page that also has a reduced price is not flagged reduced", () => {
    expect(validateExtractedPrice(35, "zł", REAL_BRAMA_POZNANIA_TEXT)).toEqual({
      status: "valid",
      amount: 35,
      currency: "zł",
      priceType: "standard",
    });
  });

  it("real case: the reduced/student price (29 zł) on the same real page is correctly flagged as reduced, not standard", () => {
    expect(validateExtractedPrice(29, "zł", REAL_BRAMA_POZNANIA_TEXT)).toEqual({
      status: "valid-reduced",
      amount: 29,
      currency: "zł",
    });
  });

  it("flags a 'from €X' minimum price rather than reporting it as the standard price", () => {
    expect(validateExtractedPrice(23, "€", "Tickets from €23 per person, options available")).toEqual({
      status: "valid-minimum",
      amount: 23,
      currency: "€",
    });
  });

  it("flags a German 'ab' minimum price", () => {
    expect(validateExtractedPrice(15, "€", "Eintritt ab 15 € pro Person")).toEqual({
      status: "valid-minimum",
      amount: 15,
      currency: "€",
    });
  });

  it("flags a child price even when labeled in German", () => {
    expect(validateExtractedPrice(10, "€", "Erwachsene 25 €, Kinder 10 €")).toEqual({
      status: "valid-reduced",
      amount: 10,
      currency: "€",
    });
  });

  it("rejects a price not actually present in the source text (hallucination-shaped, nothing to support it)", () => {
    expect(validateExtractedPrice(99, "€", "This page has no prices mentioned at all.")).toEqual({
      status: "unknown",
      reason: "çıkarılan fiyat kaynak sayfada bulunamadı",
    });
  });

  it("rejects a price found near an explicit old update marker (stale, not current)", () => {
    expect(
      validateExtractedPrice(20, "€", "Tickets: 20 €. Last updated 2019, prices may have changed since.")
    ).toEqual({
      status: "unknown",
      reason: "fiyat eski bir güncelleme tarihi yakınında bulundu, güncel olmayabilir",
    });
  });

  it("rejects a null price", () => {
    expect(validateExtractedPrice(null, null, "some text")).toEqual({
      status: "unknown",
      reason: "fiyat çıkarılmadı",
    });
  });

  it("rejects a negative price as invalid", () => {
    expect(validateExtractedPrice(-5, "€", "-5 € somehow")).toEqual({
      status: "unknown",
      reason: "negatif fiyat, geçersiz",
    });
  });

  it("accepts a plain, unqualified, textually-supported price as standard", () => {
    expect(validateExtractedPrice(25, "€", "Adults: 25 €. Free for children under 4.")).toEqual({
      status: "valid",
      amount: 25,
      currency: "€",
      priceType: "standard",
    });
  });

  it(
    "real regression: Central-European '169,-' (whole-number) price notation must not be read " +
      "as the currency itself — live-observed: extracting a real Prague restaurant's real menu " +
      'returned currency ",-" for every single item',
    () => {
      const result = validateExtractedPrice(169, ",-", "Minestrone 169,- Kč");
      expect(result.status).toBe("valid");
      expect((result as { currency: string | null }).currency).toBeNull();
    }
  );

  it("accepts a real ISO 4217 currency code", () => {
    const result = validateExtractedPrice(169, "CZK", "Price: 169 CZK");
    expect((result as { currency: string | null }).currency).toBe("CZK");
  });
});

describe("normalizeCurrency", () => {
  it("returns null for punctuation mistaken for a currency (the real ',-' regression)", () => {
    expect(normalizeCurrency(",-")).toBeNull();
    expect(normalizeCurrency("-")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency("")).toBeNull();
  });

  it("uppercases a real 3-letter ISO 4217 code", () => {
    expect(normalizeCurrency("czk")).toBe("CZK");
    expect(normalizeCurrency("EUR")).toBe("EUR");
  });

  it("accepts a known real currency symbol as-is", () => {
    expect(normalizeCurrency("€")).toBe("€");
    expect(normalizeCurrency("zł")).toBe("zł");
    expect(normalizeCurrency("Kč")).toBe("Kč");
  });
});
