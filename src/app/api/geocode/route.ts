import { NextResponse } from "next/server";
import { geocodeOnce } from "@/server/services/geocode";
import { apiError, serverError } from "@/server/api-utils";

export const maxDuration = 15;

/**
 * GET /api/geocode?q=... — thin wrapper around the existing, already-tested
 * geocodeOnce() (used internally by /api/trips, /api/extract, etc.) so the
 * redesigned Plan UI can resolve a real address into real coordinates
 * client-side — e.g. "resolve accommodation address automatically" (spec).
 * No new geocoding logic — same real Nominatim-backed, cached lookup every
 * other part of this pipeline already uses.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (!q) return apiError("q parametresi gerekli", "MISSING_QUERY", 400);

  try {
    const result = await geocodeOnce(q);
    if (!result) return apiError(`"${q}" için konum bulunamadı`, "NOT_FOUND", 404);
    return NextResponse.json(result);
  } catch (err) {
    return serverError(err, "GEOCODE_FAILED");
  }
}
