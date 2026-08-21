import { NextResponse } from "next/server";
import { autoplan, AutoplanError } from "@/server/services/autoplan";
import { autoplanRequestSchema } from "@/server/schemas";
import { parseBody, apiError, serverError } from "@/server/api-utils";

// Discovery alone can patiently wait up to 45s for a loaded public Overpass
// instance; enrichment (Wikipedia, optional web research) and routing run
// after it, so the endpoint needs real headroom beyond that.
export const maxDuration = 90;

/**
 * POST /api/itinerary/autoplan
 *
 * The autonomous path: destination, date, arrival/departure time, and
 * optional budget/interests are the only required input. Everything else —
 * which places exist, whether they are open that day, what they cost, why
 * each one is worth including — is discovered and verified by the server,
 * never typed in by the caller. Sequencing still goes through the existing
 * deterministic optimizer unchanged; this endpoint's only job is to produce
 * real, sourced candidates for it to schedule.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, autoplanRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await autoplan(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AutoplanError) {
      return apiError(err.message, err.code, 422, { stage: err.code.toLowerCase() });
    }
    return serverError(err, "AUTOPLAN_FAILED");
  }
}
