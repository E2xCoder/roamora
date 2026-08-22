import { NextResponse } from "next/server";
import { planTripOptions } from "@/server/services/trip-options";
import { AutoplanError } from "@/server/services/autoplan";
import { autoplanRequestSchema } from "@/server/schemas";
import { parseBody, apiError, serverError } from "@/server/api-utils";

// Three full autoplan() pipelines run sequentially (see trip-options.ts for
// why not in parallel), so this endpoint needs roughly three times the
// single-plan endpoint's own budget.
export const maxDuration = 270;

/**
 * POST /api/itinerary/autoplan/options
 *
 * Multi-option planning (spec §Priority 9): the same request shape as
 * /api/itinerary/autoplan, but returns three real, independently computed
 * itineraries — A (Max Experience), B (Balanced), C (Relaxed) — plus a
 * side-by-side comparison. Each option is a genuine autoplan() run with
 * different real inputs (maxStops, realismFactor, departure buffer,
 * whether the hidden-gem stage runs), not the same plan relabeled three
 * ways.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, autoplanRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await planTripOptions(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AutoplanError) {
      return apiError(err.message, err.code, 422, { stage: err.code.toLowerCase() });
    }
    return serverError(err, "AUTOPLAN_OPTIONS_FAILED");
  }
}
