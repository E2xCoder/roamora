import "server-only";
import { isSupportedBySource } from "@/server/services/opening-hours-guard";
import type { ExtractedEventFacts } from "@/server/services/event-extraction";

/**
 * Deterministic verification for extracted event facts — the event
 * counterpart to opening-hours-guard.ts and price-guard.ts. Checks the
 * model's ISO date/time output is structurally real (a real calendar date,
 * an end not before the start), textually supported by the source, and not
 * an event that has already ended — a stale festival listing left over from
 * a page that hasn't been updated should not become a same-day hard
 * constraint on a completely different, later trip.
 */

export type EventGuardResult =
  | {
      status: "valid";
      startDate: string;
      endDate: string;
      startTime: string | null;
      endTime: string | null;
      /** Whether the trip date given falls within [startDate, endDate]. */
      matchesTripDate: boolean;
    }
  | { status: "unknown"; reason: string };

function isRealCalendarDate(iso: string): boolean {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number) as unknown as [number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date normalizes an invalid day (e.g. 2026-02-30) by rolling over into the
  // next month — comparing the parts back out catches that rather than
  // silently accepting a date that doesn't really exist.
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function validateExtractedEvent(
  facts: ExtractedEventFacts,
  tripDate: string, // YYYY-MM-DD
  sourceText: string,
  now: Date = new Date()
): EventGuardResult {
  if (!facts.startDate) return { status: "unknown", reason: "başlangıç tarihi çıkarılmadı" };
  if (!isRealCalendarDate(facts.startDate)) {
    return { status: "unknown", reason: "başlangıç tarihi geçerli bir takvim tarihi değil" };
  }

  const endDate = facts.endDate ?? facts.startDate;
  if (!isRealCalendarDate(endDate)) {
    return { status: "unknown", reason: "bitiş tarihi geçerli bir takvim tarihi değil" };
  }
  if (endDate < facts.startDate) {
    return { status: "unknown", reason: "bitiş tarihi başlangıçtan önce — çelişkili" };
  }

  if (!isSupportedBySource(facts.startDate, sourceText) && !isSupportedBySource(endDate, sourceText)) {
    // The model renders ISO dates, but a real multi-day event's own page
    // routinely states them as a range shorthand — "21-28.06.2026" — where
    // the start day and month are NOT adjacent digits (the end day sits
    // between them). Requiring day+month as one contiguous run would reject
    // this real, correct extraction. Instead: the month+year pair (which IS
    // adjacent in a range shorthand) must appear together, AND at least one
    // of the two day numbers must appear somewhere in the source — real
    // signal without demanding a specific formatting convention.
    const [year, mo, startDay] = facts.startDate.split("-");
    const [, , endDay] = endDate.split("-");
    const sourceDigits = sourceText.replace(/\D+/g, "");
    const monthYearAdjacent = sourceDigits.includes(`${mo}${year}`) || sourceDigits.includes(`${year}${mo}`);
    const someDayPresent = sourceDigits.includes(startDay) || sourceDigits.includes(endDay);
    if (!monthYearAdjacent || !someDayPresent) {
      return { status: "unknown", reason: "çıkarılan tarih kaynak sayfada bulunamadı" };
    }
  }

  const nowIso = now.toISOString().slice(0, 10);
  const STALE_GRACE_DAYS = 30;
  const graceDate = new Date(now);
  graceDate.setUTCDate(graceDate.getUTCDate() - STALE_GRACE_DAYS);
  const graceIso = graceDate.toISOString().slice(0, 10);
  if (endDate < graceIso) {
    return { status: "unknown", reason: `etkinlik zaten sona ermiş görünüyor (bitiş: ${endDate}, bugün: ${nowIso})` };
  }

  if (facts.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(facts.startTime)) {
    return { status: "unknown", reason: "başlangıç saati geçersiz biçimde" };
  }

  return {
    status: "valid",
    startDate: facts.startDate,
    endDate,
    startTime: facts.startTime,
    endTime: facts.endTime,
    matchesTripDate: tripDate >= facts.startDate && tripDate <= endDate,
  };
}
