import { NextResponse } from "next/server";
import { apiError, serverError } from "@/server/api-utils";
import { getJob } from "@/server/services/job-runner";

export const maxDuration = 15;

/**
 * GET /api/itinerary/autoplan/options/{jobId}
 *
 * Polls a job created by POST /api/itinerary/autoplan/options — see
 * job-runner.ts and the sibling /api/itinerary/autoplan/{jobId} route for
 * the full reasoning. `result` (once status is "done") is the real
 * TripOptionsResult, unchanged shape from before this became async.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const job = await getJob(jobId);
    if (!job || job.kind !== "autoplan-options") {
      return apiError("İş bulunamadı", "JOB_NOT_FOUND", 404);
    }
    return NextResponse.json(job);
  } catch (err) {
    return serverError(err, "JOB_FETCH_FAILED");
  }
}
