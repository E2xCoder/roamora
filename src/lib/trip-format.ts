/**
 * Pure, presentation-only helpers for the trip detail page — kept separate
 * from the page component so the real logic (duration math, day-summary
 * derivation) is unit-testable without rendering React.
 */

import type { DayResearchSummary } from "@/lib/autoplan-client";

/** Real, already-scheduled arrival/departure minus each other — never a mental-math burden left to the traveller. */
export function visitDurationMinutes(arrivalTime?: string | null, departureTime?: string | null): number | null {
  if (!arrivalTime || !departureTime) return null;
  const [ah, am] = arrivalTime.split(":").map(Number);
  const [dh, dm] = departureTime.split(":").map(Number);
  if ([ah, am, dh, dm].some((n) => Number.isNaN(n))) return null;
  const minutes = dh * 60 + dm - (ah * 60 + am);
  return minutes > 0 ? minutes : null;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}s ${m}dk` : `${h}s`) : `${m}dk`;
}

/**
 * A 5-minute statue and a 75-minute museum shouldn't read as the same kind
 * of stop — this gives the timeline visual rhythm (spec: "a 5-minute statue
 * should look different from a 75-minute museum") without inventing a new
 * backend category. Purely a presentation tier over the real, already-
 * scheduled visit length.
 */
export function stopWeight(minutes: number | null): "quick" | "standard" | "major" {
  if (minutes == null) return "standard";
  if (minutes <= 20) return "quick";
  if (minutes >= 45) return "major";
  return "standard";
}

/**
 * A short "what this day is" line, e.g. "Old Town Square + Kampa Museum" —
 * built only from the day's own real stop names and durations, never a
 * generated sentence (spec: "do NOT generate fake narratives, base them
 * only on actual itinerary stops"). Picks the two longest, non-restaurant
 * stops (the real anchors of the day) and orders them chronologically.
 */
export function deriveDaySummary(
  activities: Array<{ placeName: string; arrivalTime?: string | null; departureTime?: string | null }>,
  research: DayResearchSummary | null
): string | null {
  const restaurantName = research?.restaurant?.selected?.name;
  const ranked = activities
    .map((a, order) => ({ name: a.placeName, order, minutes: visitDurationMinutes(a.arrivalTime, a.departureTime) ?? 0 }))
    .filter((a) => a.name !== restaurantName)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 2)
    .sort((a, b) => a.order - b.order);
  return ranked.length > 0 ? ranked.map((a) => a.name).join(" + ") : null;
}
