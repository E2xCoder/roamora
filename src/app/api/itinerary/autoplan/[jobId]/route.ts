import { NextResponse } from "next/server";
import { apiError, serverError } from "@/server/api-utils";
import { getJob } from "@/server/services/job-runner";

export const maxDuration = 15;

/**
 * GET /api/itinerary/autoplan/{jobId}
 *
 * Polls the real progress/result of a job created by POST
 * /api/itinerary/autoplan — see job-runner.ts for why autoplan runs
 * detached from that request instead of blocking it. `status` is one of
 * pending | running | done | failed; `result` is only populated once
 * status is "done" (the real AutoplanResult, unchanged shape from before
 * this became async).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const job = await getJob(jobId);
    if (!job || job.kind !== "autoplan") {
      return apiError("İş bulunamadı", "JOB_NOT_FOUND", 404);
    }
    return NextResponse.json(job);
  } catch (err) {
    return serverError(err, "JOB_FETCH_FAILED");
  }
}
