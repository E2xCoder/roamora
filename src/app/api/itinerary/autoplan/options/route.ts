import { NextResponse, after } from "next/server";
import { planTripOptions } from "@/server/services/trip-options";
import { AutoplanError, type ResearchTraceEntry } from "@/server/services/autoplan";
import { autoplanRequestSchema } from "@/server/schemas";
import { parseBody, serverError } from "@/server/api-utils";
import { createJob, markJobRunning, reportJobProgress, completeJob, failJob } from "@/server/services/job-runner";

// Three full autoplan() pipelines run sequentially (see trip-options.ts for
// why not in parallel) — up to 3x a single plan's real duration. Same
// production-hardening reasoning as /api/itinerary/autoplan (see
// job-runner.ts): this route only validates and creates a job now, so it
// needs no more headroom than that one does.
export const maxDuration = 15;

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
 *
 * Returns 202 with a job id immediately; poll
 * GET /api/itinerary/autoplan/options/{jobId} for progress and the final
 * result — same async contract as /api/itinerary/autoplan, for the same
 * request-lifecycle-safety reason, only more pressing here since this
 * route's real duration is up to 3x a single plan's.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, autoplanRequestSchema);
  if (!parsed.ok) return parsed.response;

  let jobId: string;
  try {
    jobId = await createJob("autoplan-options", parsed.data);
  } catch (err) {
    return serverError(err, "JOB_CREATE_FAILED");
  }

  after(async () => {
    await markJobRunning(jobId);
    let step = 0;
    try {
      const result = await planTripOptions(parsed.data, {
        onProgress: (pace, entry: ResearchTraceEntry) => {
          step += 1;
          reportJobProgress(jobId, step, 0, `[${pace}] ${entry.stage}: ${entry.detail}`).catch(() => {});
        },
      });
      await completeJob(jobId, result);
    } catch (err) {
      if (err instanceof AutoplanError) {
        await failJob(jobId, `${err.code}: ${err.message}`);
      } else {
        await failJob(jobId, err);
      }
    }
  });

  return NextResponse.json({ jobId, statusUrl: `/api/itinerary/autoplan/options/${jobId}` }, { status: 202 });
}
