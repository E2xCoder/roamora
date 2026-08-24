import { NextResponse } from "next/server";
import { z } from "zod";
import { parseTripDescription } from "@/server/services/trip-nl-parse";
import { ExtractionUnavailableError } from "@/server/services/fact-extraction";
import { apiError, parseBody, serverError } from "@/server/api-utils";

export const maxDuration = 30;

const requestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

/**
 * POST /api/trip-planner/parse — free-text trip description -> structured
 * fields (destination/dates/interests/budget), used to pre-fill the trip-
 * creation form. Never triggers planning itself — the caller still submits
 * the (now pre-filled, user-reviewable) structured form through the normal
 * /api/itinerary/autoplan(/options) job flow.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, requestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await parseTripDescription(parsed.data.text, todayIso);
    if (!result) {
      return apiError("Metinden bir şey çıkarılamadı.", "PARSE_EMPTY", 422);
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExtractionUnavailableError) {
      return apiError(err.message, err.code, 503);
    }
    return serverError(err, "TRIP_PARSE_FAILED");
  }
}
