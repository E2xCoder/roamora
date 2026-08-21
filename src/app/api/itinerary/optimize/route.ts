import { NextResponse } from "next/server";
import { fetchMatrix } from "@/server/services/osrm-matrix";
import { optimizeItinerary } from "@/server/services/itinerary-optimizer";
import { optimizeRequestSchema } from "@/server/schemas";
import { parseBody, serverError } from "@/server/api-utils";

export const maxDuration = 30;

/**
 * POST /api/itinerary/optimize
 *
 * Sequences a set of places into a real, timed route: a real distance matrix
 * from OSRM, then a deterministic constrained-insertion + 2-opt solver — no
 * LLM in the ordering path. Given the same input this always returns the same
 * output, and every conflict (a fixed-time stop that cannot be reached, a day
 * that runs over) is reported by name rather than silently absorbed.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, optimizeRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { stops, dayStart, dayEnd, start, profile, realismFactor } = parsed.data;

  try {
    // Node 0 is the virtual start; stops occupy 1..n, matching the optimizer's
    // indexing convention.
    const points = [start, ...stops];
    const matrix = await fetchMatrix(points, profile);

    const result = optimizeItinerary(
      { stops, dayStart, dayEnd, start, realismFactor },
      matrix
    );

    return NextResponse.json({ ...result, matrixSource: matrix.source });
  } catch (err) {
    return serverError(err, "OPTIMIZE_FAILED");
  }
}
