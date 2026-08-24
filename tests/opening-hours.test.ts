import { describe, expect, it } from "vitest";
import { resolveOpeningHoursForDate, widestWindow } from "@/lib/opening-hours";

// Thursday, 2026-08-27 — matches the destination-date example used throughout
// the planning spec, and lets every "which weekday is this" assertion be
// checked against a real calendar date rather than an assumption.
const THURSDAY = new Date("2026-08-27T12:00:00");
const SATURDAY = new Date("2026-08-29T12:00:00");
const SUNDAY = new Date("2026-08-30T12:00:00");

describe("resolveOpeningHoursForDate — common real-world patterns", () => {
  it("parses a simple weekday range", () => {
    const r = resolveOpeningHoursForDate("Mo-Fr 09:00-17:00", THURSDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "17:00" }] });
  });

  it("reports closed on a day outside the range", () => {
    const r = resolveOpeningHoursForDate("Mo-Fr 09:00-17:00", SATURDAY);
    expect(r.status).toBe("closed");
  });

  it("handles a range that wraps past Sunday", () => {
    // Fr-Su covers Friday, Saturday, Sunday.
    const r = resolveOpeningHoursForDate("Fr-Su 10:00-14:00", SATURDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "10:00", close: "14:00" }] });
  });

  it("handles 24/7", () => {
    expect(resolveOpeningHoursForDate("24/7", SUNDAY)).toEqual({ status: "always" });
  });

  it("handles multiple time windows in one day (lunch break)", () => {
    const r = resolveOpeningHoursForDate("Mo-Fr 09:00-12:00,13:00-17:00", THURSDAY);
    expect(r).toEqual({
      status: "open",
      windows: [
        { open: "09:00", close: "12:00" },
        { open: "13:00", close: "17:00" },
      ],
    });
  });

  it("applies a later exception rule over an earlier blanket rule", () => {
    // Open every day, but Thursday specifically is closed — this is exactly
    // the case a naive "first match wins" parser gets wrong, and getting it
    // wrong here means telling the optimizer a closed museum is open.
    const r = resolveOpeningHoursForDate("Mo-Su 09:00-18:00; Th off", THURSDAY);
    expect(r.status).toBe("closed");
  });

  it("does not let an exception for a different day leak through", () => {
    const r = resolveOpeningHoursForDate("Mo-Su 09:00-18:00; Th off", SATURDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "18:00" }] });
  });

  it("respects a leading month range", () => {
    // A summer-only place, checked against a date inside and outside season.
    const inSeason = resolveOpeningHoursForDate("Apr-Oct Mo-Su 08:00-20:00", THURSDAY); // August
    const winter = new Date("2026-12-27T12:00:00"); // same weekday, different month
    const outOfSeason = resolveOpeningHoursForDate("Apr-Oct Mo-Su 08:00-20:00", winter);

    expect(inSeason.status).toBe("open");
    expect(outOfSeason.status).toBe("closed");
  });

  it("ignores public/school holiday tokens rather than claiming to know the calendar", () => {
    // PH is a real OSM token this parser explicitly does not resolve (no
    // holiday calendar available) — it must not crash or silently treat the
    // whole string as unparseable just because PH appears.
    const r = resolveOpeningHoursForDate("Mo-Fr 09:00-17:00; PH off", THURSDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "17:00" }] });
  });

  it("treats an unmentioned day as closed rather than guessing it stays open", () => {
    const r = resolveOpeningHoursForDate("Sa-Su 10:00-16:00", THURSDAY);
    expect(r.status).toBe("closed");
  });
});

describe("resolveOpeningHoursForDate — refuses to guess on unsupported syntax", () => {
  it("refuses sunrise/sunset (astronomical times this parser cannot compute)", () => {
    const r = resolveOpeningHoursForDate("Mo-Su sunrise-sunset", THURSDAY);
    expect(r.status).toBe("unparseable");
  });

  it("refuses week-number selectors", () => {
    const r = resolveOpeningHoursForDate("week 1-10 Mo-Fr 09:00-17:00", THURSDAY);
    expect(r.status).toBe("unparseable");
  });

  it("refuses an empty string rather than defaulting to open or closed", () => {
    expect(resolveOpeningHoursForDate("", THURSDAY).status).toBe("unparseable");
  });

  it("refuses malformed time ranges instead of parsing them loosely", () => {
    const r = resolveOpeningHoursForDate("Mo-Fr 9-5", THURSDAY);
    expect(r.status).toBe("unparseable");
  });

  it("refuses an unrecognised day token rather than skipping it silently", () => {
    const r = resolveOpeningHoursForDate("Xx-Fr 09:00-17:00", THURSDAY);
    expect(r.status).toBe("unparseable");
  });
});

describe("widestWindow — overnight-spanning windows", () => {
  it("excludes a window that spans midnight rather than treating the close time as same-day", () => {
    // Regression: a bar open "12:00-02:00" (until 2 AM) had its 02:00 read as
    // a same-day cutoff, so the optimizer reported a 10:27 arrival as having
    // missed closing time by eight hours — for a venue that was actually
    // still hours from closing.
    const r = resolveOpeningHoursForDate("Mo-Su 12:00-02:00", THURSDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "12:00", close: "02:00" }] });
    expect(widestWindow(r)).toBeNull();
  });

  it("still returns a same-day window when one exists alongside an overnight one", () => {
    const r = resolveOpeningHoursForDate("Mo-Su 09:00-11:00,20:00-02:00", THURSDAY);
    expect(widestWindow(r)).toEqual({ open: "09:00", close: "11:00" });
  });
});

describe("widestWindow", () => {
  it("returns the window with the latest closing time", () => {
    const r = resolveOpeningHoursForDate("Mo-Fr 09:00-12:00,13:00-20:00", THURSDAY);
    expect(widestWindow(r)).toEqual({ open: "13:00", close: "20:00" });
  });

  it("returns a full-day window for 24/7", () => {
    expect(widestWindow({ status: "always" })).toEqual({ open: "00:00", close: "23:59" });
  });

  it("returns null when closed or unparseable", () => {
    expect(widestWindow({ status: "closed" })).toBeNull();
    expect(widestWindow({ status: "unparseable", reason: "x" })).toBeNull();
  });
});

describe("resolveOpeningHoursForDate — day-of-month date clauses", () => {
  // Tuesday, 2026-09-29 — a real trip date used live this session.
  const TUESDAY = new Date("2026-09-29T12:00:00");

  it(
    "real regression: Prague's Old-New Synagogue's real OSM opening_hours string used to fail " +
      'entirely (status "unparseable") because of its FIRST rule alone, a single unrelated New ' +
      "Year's Day exception (\"Jan 01 11:00-17:00\") — even though a later, perfectly parseable " +
      'rule ("Sep 01-Oct 18 09:00-18:00") was the one that actually governed the requested date',
    () => {
      const real =
        'Jan 01 11:00-17:00; Jan 02-Mar 31,Oct 19-Dec 31 09:00-17:00; ' +
        "Apr 01-31,Sep 01-Oct 18 09:00-18:00; May 01-Aug 31 09:00-19:00; " +
        'Aug 03 11:00-19:00; Dec 24 09:00-14:00; Sa off; "Jewish holidays" off';
      const r = resolveOpeningHoursForDate(real, TUESDAY);
      expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "18:00" }] });
    }
  );

  it("resolves a single specific date that matches the target date", () => {
    const r = resolveOpeningHoursForDate("Jan 01 11:00-17:00", new Date("2026-01-01T12:00:00"));
    expect(r).toEqual({ status: "open", windows: [{ open: "11:00", close: "17:00" }] });
  });

  it("skips a single specific date that does not match, falling through to closed", () => {
    const r = resolveOpeningHoursForDate("Jan 01 11:00-17:00", TUESDAY);
    expect(r.status).toBe("closed");
  });

  it("resolves a same-month day range (e.g. 'Apr 01-31')", () => {
    const r = resolveOpeningHoursForDate("Apr 01-31 10:00-16:00", new Date("2026-04-15T12:00:00"));
    expect(r).toEqual({ status: "open", windows: [{ open: "10:00", close: "16:00" }] });
  });

  it("resolves a cross-month day range (e.g. 'Sep 01-Oct 18')", () => {
    const r = resolveOpeningHoursForDate("Sep 01-Oct 18 09:00-18:00", TUESDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "18:00" }] });
    // Just past the range end (Oct 19) should not match the same rule.
    const past = resolveOpeningHoursForDate("Sep 01-Oct 18 09:00-18:00", new Date("2026-10-19T12:00:00"));
    expect(past.status).toBe("closed");
  });

  it("respects a day-of-week selector that follows a date clause (not treated as bare 'every day')", () => {
    const r = resolveOpeningHoursForDate("Sep 01-Oct 18 Sa,Su 10:00-16:00", TUESDAY);
    expect(r.status).toBe("closed"); // Tuesday, not a weekend, even though the date range matches
    const weekend = resolveOpeningHoursForDate("Sep 01-Oct 18 Sa,Su 10:00-16:00", new Date("2026-10-03T12:00:00")); // a Saturday within range
    expect(weekend).toEqual({ status: "open", windows: [{ open: "10:00", close: "16:00" }] });
  });

  it(
    "skips a quoted holiday-calendar rule with no calendar available, same treatment as PH/SH " +
      '(real case: \'"Jewish holidays" off\')',
    () => {
      const r = resolveOpeningHoursForDate('Mo-Fr 09:00-17:00; "Jewish holidays" off', THURSDAY);
      expect(r).toEqual({ status: "open", windows: [{ open: "09:00", close: "17:00" }] });
    }
  );

  it("a later date-clause rule for the same day still overrides an earlier one", () => {
    const r = resolveOpeningHoursForDate("Sep 01-Oct 18 09:00-18:00; Sep 29 12:00-15:00", TUESDAY);
    expect(r).toEqual({ status: "open", windows: [{ open: "12:00", close: "15:00" }] });
  });

  it("still refuses a genuinely unparseable date-clause-shaped rule rather than guessing", () => {
    const r = resolveOpeningHoursForDate("Sep 32-Oct 18 09:00-18:00", TUESDAY); // invalid day-of-month
    expect(r.status).toBe("unparseable");
  });
});
