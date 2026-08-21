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
