import "server-only";
import { autoplan, type AutoplanRequest, type AutoplanResult } from "@/server/services/autoplan";

/**
 * Multi-option planning (spec §Priority 9): three real, independently
 * computed itineraries for the same trip — not one plan with a cosmetic
 * "pace" label. Each option is a genuine call to the EXISTING, unchanged
 * autoplan() with different real inputs it already knows how to use:
 * `maxStops` (how much gets attempted at all), `realismFactor` (how
 * generously travel time is estimated — itinerary-optimizer.ts already
 * accepted this; autoplan.ts never threaded it through until this pass),
 * `departureBufferMinutes` (how much slack the day's end keeps), and
 * `includeHiddenGems` (whether the Priority-5 corridor scan runs at all).
 * No new optimizer logic, no new discovery logic — three different real
 * dials on the same machine.
 *
 * Three real pipelines (Overpass, OSRM, SearXNG, Ollama) run sequentially,
 * not in parallel — this session repeatedly found the free public
 * Overpass instance to be rate-limit-sensitive under concurrent load,
 * and three full autoplan() calls at once would triple that burst for a
 * single request.
 */

export type TripPace = "max_experience" | "balanced" | "relaxed";

interface PacePreset {
  label: string;
  /** Applied to the caller's own requested maxStops, then rounded and clamped to [3, 16]. */
  maxStopsMultiplier: number;
  maxStopsDelta: number;
  /** Passed straight through to the existing optimizer (1.0-2.0 valid range, enforced by the schema). */
  realismFactor: number;
  /** Added to the caller's own requested departure buffer. */
  departureBufferDeltaMinutes: number;
  includeHiddenGems: boolean;
}

const PACE_PRESETS: Record<TripPace, PacePreset> = {
  // Brisker assumed pace (lower realismFactor), more stops attempted, no
  // extra safety margin, hidden gems included — the day is packed.
  max_experience: {
    label: "A — Maksimum Deneyim",
    maxStopsMultiplier: 1.3,
    maxStopsDelta: 1,
    realismFactor: 1.05,
    departureBufferDeltaMinutes: 0,
    includeHiddenGems: true,
  },
  // Unchanged from what a plain autoplan() call already does — this
  // option exists so all three are directly comparable side by side,
  // not because it applies any adjustment of its own.
  balanced: {
    label: "B — Dengeli",
    maxStopsMultiplier: 1.0,
    maxStopsDelta: 0,
    realismFactor: 1.2,
    departureBufferDeltaMinutes: 0,
    includeHiddenGems: true,
  },
  // Fewer stops attempted (more real time per stop within the same day),
  // a more generous realismFactor (assumes a slower, less rushed pace),
  // extra departure buffer, and the hidden-gem scan skipped entirely so
  // the day isn't stretched by two more real stops.
  relaxed: {
    label: "C — Rahat",
    maxStopsMultiplier: 0.7,
    maxStopsDelta: -1,
    realismFactor: 1.4,
    departureBufferDeltaMinutes: 15,
    includeHiddenGems: false,
  },
};

export function deriveMaxStopsForPace(baseMaxStops: number, pace: TripPace): number {
  const preset = PACE_PRESETS[pace];
  const scaled = Math.round(baseMaxStops * preset.maxStopsMultiplier) + preset.maxStopsDelta;
  return Math.min(16, Math.max(3, scaled));
}

export interface TripOptionParametersUsed {
  maxStops: number;
  realismFactor: number;
  departureBufferMinutes: number;
  includeHiddenGems: boolean;
}

export interface TripOption {
  pace: TripPace;
  label: string;
  parametersUsed: TripOptionParametersUsed;
  result: AutoplanResult;
}

export interface TripOptionsComparisonRow {
  pace: TripPace;
  label: string;
  stopCount: number;
  totalDistanceKm: number;
  totalCost: number | null;
  costKnown: boolean;
  feasible: boolean;
  departureSafe: boolean;
}

export interface TripOptionsResult {
  options: TripOption[]; // always exactly [max_experience, balanced, relaxed], in that order
  comparison: TripOptionsComparisonRow[];
}

export async function planTripOptions(baseRequest: AutoplanRequest): Promise<TripOptionsResult> {
  const baseMaxStops = Math.min(Math.max(baseRequest.maxStops ?? 8, 1), 16);
  const baseDepartureBuffer = Math.max(0, baseRequest.departureBufferMinutes ?? 0);

  const options: TripOption[] = [];
  for (const pace of ["max_experience", "balanced", "relaxed"] as const) {
    const preset = PACE_PRESETS[pace];
    const parametersUsed: TripOptionParametersUsed = {
      maxStops: deriveMaxStopsForPace(baseMaxStops, pace),
      realismFactor: preset.realismFactor,
      departureBufferMinutes: baseDepartureBuffer + preset.departureBufferDeltaMinutes,
      includeHiddenGems: preset.includeHiddenGems,
    };

    const result = await autoplan({
      ...baseRequest,
      maxStops: parametersUsed.maxStops,
      realismFactor: parametersUsed.realismFactor,
      departureBufferMinutes: parametersUsed.departureBufferMinutes,
      includeHiddenGems: parametersUsed.includeHiddenGems,
    });

    options.push({ pace, label: preset.label, parametersUsed, result });
  }

  const comparison: TripOptionsComparisonRow[] = options.map((o) => ({
    pace: o.pace,
    label: o.label,
    stopCount: o.result.itinerary.stops.length,
    totalDistanceKm: Math.round((o.result.itinerary.totalDistanceMeters / 1000) * 10) / 10,
    totalCost: o.result.itinerary.costKnown ? o.result.itinerary.totalCost : null,
    costKnown: o.result.itinerary.costKnown,
    feasible: o.result.itinerary.feasible,
    departureSafe: o.result.departureSafety.safe,
  }));

  return { options, comparison };
}
