import { describe, expect, it } from "vitest";
import { validateExtractedEvent } from "@/server/services/event-guard";
import type { ExtractedEventFacts } from "@/server/services/event-extraction";

function facts(overrides: Partial<ExtractedEventFacts> = {}): ExtractedEventFacts {
  return {
    eventName: "Test Event",
    startDate: "2026-06-21",
    endDate: "2026-06-28",
    startTime: null,
    endTime: null,
    venueName: null,
    aboutThisEvent: true,
    ...overrides,
  };
}

// Real plain text captured this session from malta-festival.pl, the real
// official Malta Festival Poznań page — states its 2026 dates as a range
// shorthand ("21-28.06.2026"), which is exactly the format that breaks a
// naive "day+month must be adjacent digits" source-support check, since the
// end day (28) sits between the start day (21) and the month (06).
const REAL_MALTA_FESTIVAL_TEXT =
  "Kalendarium - Malta Festival 2026 Festiwal O festiwalu Zespół Mecenat Historia " +
  "21-28.06.2026 Wezmę udział Festiwal Program Aktualności Dostępność";

describe("validateExtractedEvent", () => {
  it("real case: Malta Festival Poznań's range-shorthand date (21-28.06.2026) is recognised as supporting evidence", () => {
    const result = validateExtractedEvent(
      facts({ eventName: "Malta Festival Poznań" }),
      "2026-06-24",
      REAL_MALTA_FESTIVAL_TEXT,
      new Date("2026-05-01")
    );
    expect(result).toEqual({
      status: "valid",
      startDate: "2026-06-21",
      endDate: "2026-06-28",
      startTime: null,
      endTime: null,
      matchesTripDate: true,
    });
  });

  it("real case: a trip date outside the festival's real range correctly does not match", () => {
    const result = validateExtractedEvent(
      facts({ eventName: "Malta Festival Poznań" }),
      "2026-08-25", // this session's actual test trip date, well after the real festival
      REAL_MALTA_FESTIVAL_TEXT,
      new Date("2026-05-01")
    );
    expect(result).toEqual(
      expect.objectContaining({ status: "valid", matchesTripDate: false })
    );
  });

  it("rejects a missing start date", () => {
    expect(validateExtractedEvent(facts({ startDate: null }), "2026-06-24", REAL_MALTA_FESTIVAL_TEXT)).toEqual({
      status: "unknown",
      reason: "başlangıç tarihi çıkarılmadı",
    });
  });

  it("rejects an impossible calendar date (Feb 30)", () => {
    expect(
      validateExtractedEvent(facts({ startDate: "2026-02-30", endDate: "2026-02-30" }), "2026-02-15", "2026-02-30 event")
    ).toEqual({ status: "unknown", reason: "başlangıç tarihi geçerli bir takvim tarihi değil" });
  });

  it("rejects an end date before the start date as contradictory", () => {
    expect(
      validateExtractedEvent(
        facts({ startDate: "2026-06-28", endDate: "2026-06-21" }),
        "2026-06-24",
        "some event 2026-06-28 to 2026-06-21"
      )
    ).toEqual({ status: "unknown", reason: "bitiş tarihi başlangıçtan önce — çelişkili" });
  });

  it("rejects a date not supported by the source at all (hallucination-shaped)", () => {
    expect(
      validateExtractedEvent(facts({ startDate: "2026-12-25", endDate: "2026-12-25" }), "2026-12-25", "This page never mentions any date.")
    ).toEqual({ status: "unknown", reason: "çıkarılan tarih kaynak sayfada bulunamadı" });
  });

  it("rejects an event that has clearly already ended (stale listing)", () => {
    expect(
      validateExtractedEvent(
        facts({ startDate: "2025-01-10", endDate: "2025-01-12" }),
        "2026-08-25",
        "Event on 2025-01-10 to 2025-01-12",
        new Date("2026-08-25")
      )
    ).toEqual({ status: "unknown", reason: expect.stringContaining("etkinlik zaten sona ermiş") });
  });

  it("rejects a malformed start time", () => {
    expect(
      validateExtractedEvent(
        facts({ startTime: "25:99" as never }),
        "2026-06-24",
        REAL_MALTA_FESTIVAL_TEXT,
        new Date("2026-05-01")
      )
    ).toEqual({ status: "unknown", reason: "başlangıç saati geçersiz biçimde" });
  });

  it(
    "validates a multi-event-list item (extractEventListFromText's shape, no aboutThisEvent/eventName " +
      "requirement) exactly like a single named-event extraction — same guard, same rules",
    () => {
      const listItem = { startDate: "2026-08-25", endDate: "2026-08-25", startTime: "20:00", endTime: null };
      const result = validateExtractedEvent(listItem, "2026-08-25", "Concert on 2026-08-25 at 20:00", new Date("2026-08-01"));
      expect(result).toEqual({
        status: "valid",
        startDate: "2026-08-25",
        endDate: "2026-08-25",
        startTime: "20:00",
        endTime: null,
        matchesTripDate: true,
      });
    }
  );

  it("accepts a clean single-day event with a real start time", () => {
    const result = validateExtractedEvent(
      facts({ startDate: "2026-08-25", endDate: "2026-08-25", startTime: "19:00" }),
      "2026-08-25",
      "Concert on 2026-08-25 at 19:00",
      new Date("2026-08-01")
    );
    expect(result).toEqual({
      status: "valid",
      startDate: "2026-08-25",
      endDate: "2026-08-25",
      startTime: "19:00",
      endTime: null,
      matchesTripDate: true,
    });
  });
});
