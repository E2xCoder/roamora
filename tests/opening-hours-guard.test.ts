import { describe, expect, it } from "vitest";
import { validateExtractedOpeningHours, isSupportedBySource } from "@/server/services/opening-hours-guard";

describe("validateExtractedOpeningHours — real extraction cases", () => {
  it(
    "Rijksmuseum (German, daily) — real extraction, hoursScope correctly classified as daily",
    () => {
      const source = "Sie sind täglich von 9 bis 17 Uhr willkommen. PREISE Erwachsene: € 25";
      const result = validateExtractedOpeningHours("9 bis 17 Uhr", "daily", source);
      expect(result).toEqual({ status: "specific-hours", osmSyntax: "Mo-Su 09:00-17:00" });
    }
  );

  it(
    "Rijksmuseum (English AM/PM, daily) — the same real page, re-extracted on a later live " +
      "run, in English this time: \"Daily, 365 days a year from 9 a.m. to 5 p.m.\"",
    () => {
      const text = "Daily, 365 days a year from 9 a.m. to 5 p.m.";
      const source = `Opening hours: ${text} Adults: €25`;
      const result = validateExtractedOpeningHours(text, "daily", source);
      expect(result).toEqual({ status: "specific-hours", osmSyntax: "Mo-Su 09:00-17:00" });
    }
  );

  it(
    "Eiffel Tower (French, today-only) — real page said 'Ouvert aujourd'hui', not 'daily'; " +
      "must NOT become a hard Mo-Su constraint just because no day name is present",
    () => {
      const source = "Ouvert aujourd'hui 09:00 - 00:00. Tarif Adulte 23,50€";
      const result = validateExtractedOpeningHours("09:00 - 00:00", "today", source);
      expect(result).toEqual({ status: "today-only", rawText: "09:00 - 00:00" });
    }
  );

  it("Brama Poznania (Polish, two day-ranges) — real extraction, exact match", () => {
    const source = "Informacja: Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00 Normalny 35 zł";
    const result = validateExtractedOpeningHours(
      "Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00",
      "specific-days",
      source
    );
    expect(result).toEqual({
      status: "specific-hours",
      osmSyntax: "Tu-Fr 09:00-18:00; Sa-Su 10:00-19:00",
    });
  });

  it(
    "Hagia Sophia hallucination — real, live-observed case: the extracted text IS present " +
      "verbatim in the source (so a naive source-support check alone would pass it), but it's " +
      "a crowd-calendar widget's day-abbreviation-plus-legend text, not real hours",
    () => {
      const extracted = "Pzt Sal Çar Per Cum Cmt Paz Hoş Kalabalık Çok Kalabalık Kapalı";
      const source = `Bugün Açık 8:00–19:30. Hafta içi ve hafta sonu kalabalık takvimi: ${extracted}`;
      expect(isSupportedBySource(extracted, source)).toBe(true); // confirms this isn't a source-support rejection
      const result = validateExtractedOpeningHours(extracted, null, source);
      expect(result.status).toBe("unknown");
    }
  );

  it(
    "Hagia Sophia, correct extraction — a later live run against the same real page did not " +
      'reproduce the hallucination and instead correctly extracted "8:00–19:30" with ' +
      'hoursScope "daily" (LLM output is non-deterministic run to run); the guard must accept ' +
      "a genuinely correct extraction, not reject on principle",
    () => {
      const source = "Bugün Açık 8:00–19:30. Ayasofya yıl boyunca her gün açıktır.";
      const result = validateExtractedOpeningHours("8:00–19:30", "daily", source);
      expect(result).toEqual({ status: "specific-hours", osmSyntax: "Mo-Su 08:00-19:30" });
    }
  );

  it(
    'Ratusz – Muzeum Poznania, real "closed" classification — a later live run against the ' +
      "same real page (closed for renovation until 2027/2028) returned hoursScope \"closed\" " +
      "with openingHoursText null; this must exclude the stop, not leave it unconstrained",
    () => {
      const result = validateExtractedOpeningHours(null, "closed", "Ratusz jest niedostępne do zwiedzania w związku z pracami konserwatorskimi.");
      expect(result).toEqual({ status: "closed" });
    }
  );
});

describe("validateExtractedOpeningHours — model-reported status", () => {
  it("passes through 'closed' regardless of any text", () => {
    expect(validateExtractedOpeningHours("some garbage text", "closed", "anything")).toEqual({
      status: "closed",
    });
    expect(validateExtractedOpeningHours(null, "closed", "anything")).toEqual({ status: "closed" });
  });

  it("passes through 'by-appointment'", () => {
    expect(validateExtractedOpeningHours(null, "by-appointment", "anything")).toEqual({
      status: "by-appointment",
    });
  });

  it("detects 'closed' stated directly in the text even without the hoursScope field", () => {
    const result = validateExtractedOpeningHours("Currently closed for renovation", null, "Currently closed for renovation until 2028");
    expect(result).toEqual({ status: "closed" });
  });

  it("detects 'by appointment' stated directly in the text", () => {
    const result = validateExtractedOpeningHours("Visits by appointment only", null, "Visits by appointment only, call ahead");
    expect(result).toEqual({ status: "by-appointment" });
  });

  it("'today' never becomes a hard constraint, regardless of how clean the time text is", () => {
    const result = validateExtractedOpeningHours("09:00-18:00", "today", "Open today 09:00-18:00");
    expect(result).toEqual({ status: "today-only", rawText: "09:00-18:00" });
  });
});

describe("validateExtractedOpeningHours — synthetic edge cases", () => {
  it("rejects a stale date stamp mistaken for hours (the original regression, now via a named check)", () => {
    const result = validateExtractedOpeningHours("Dzisiaj Poniedziałek 24.10.2022", null, "Dzisiaj Poniedziałek 24.10.2022 — museum info");
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.reason).toMatch(/tarih damgası/);
  });

  it("rejects random numeric text with no time shape", () => {
    const result = validateExtractedOpeningHours("Page 42 of 128", null, "See Page 42 of 128 for details");
    expect(result.status).toBe("unknown");
  });

  it("rejects a zero-duration (malformed) time range", () => {
    const result = validateExtractedOpeningHours("09:00-09:00", "specific-days", "Hours: 09:00-09:00");
    expect(result.status).toBe("unknown");
  });

  it("rejects contradictory ranges for the same day", () => {
    const text = "Mo-Fr 09:00-17:00, Mo 10:00-14:00";
    const result = validateExtractedOpeningHours(text, "specific-days", `Schedule: ${text}`);
    expect(result.status).toBe("unknown");
  });

  it("rejects text whose substance is not actually present in the source (fabrication)", () => {
    const result = validateExtractedOpeningHours(
      "Mo-Fr 09:00-17:00",
      "specific-days",
      "This page discusses only the menu and prices, nothing about hours."
    );
    expect(result).toEqual({ status: "unknown", reason: "çıkarılan metin kaynak sayfada bulunamadı" });
  });

  it("handles a real overnight schedule correctly — preserved as-is, not rejected for being overnight", () => {
    const text = "Fr 20:00-02:00";
    const result = validateExtractedOpeningHours(text, "specific-days", `Bar hours: ${text}`);
    expect(result).toEqual({ status: "specific-hours", osmSyntax: "Fr 20:00-02:00" });
  });

  it("handles a 00:00 close correctly — becomes the existing 23:59 end-of-day sentinel", () => {
    const text = "Mo-Fr 09:00-00:00";
    const result = validateExtractedOpeningHours(text, "specific-days", `Daily: ${text}`);
    expect(result).toEqual({ status: "specific-hours", osmSyntax: "Mo-Fr 09:00-23:59" });
  });

  it("rejects a day-less range with no explicit 'daily' classification, rather than guessing", () => {
    // Same shape as the Rijksmuseum case, but hoursScope left unclear this
    // time — must NOT silently default to "every day" without that signal.
    const result = validateExtractedOpeningHours("9 bis 17 Uhr", "unclear", "geöffnet 9 bis 17 Uhr");
    expect(result.status).toBe("unknown");
  });

  it("rejects an empty extraction", () => {
    expect(validateExtractedOpeningHours(null, null, "anything").status).toBe("unknown");
    expect(validateExtractedOpeningHours("", null, "anything").status).toBe("unknown");
  });
});

describe("isSupportedBySource", () => {
  it("matches an exact substring", () => {
    expect(isSupportedBySource("Mo-Fr 09:00-17:00", "Hours: Mo-Fr 09:00-17:00 daily")).toBe(true);
  });

  it("matches through minor punctuation drift via the digit-sequence fallback", () => {
    expect(isSupportedBySource("9:00-17:00", "open from 9.00 to 17.00 every day")).toBe(true);
  });

  it("rejects text with no real relationship to the source", () => {
    expect(isSupportedBySource("Mo-Fr 09:00-17:00", "This page is about a restaurant menu.")).toBe(false);
  });
});
