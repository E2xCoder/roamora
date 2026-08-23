import { NextResponse, after } from "next/server";
import { autoplan, AutoplanError, type ResearchTraceEntry } from "@/server/services/autoplan";
import { autoplanRequestSchema } from "@/server/schemas";
import { parseBody, serverError } from "@/server/api-utils";
import { createJob, markJobRunning, reportJobProgress, completeJob, failJob } from "@/server/services/job-runner";

// This route itself only validates the request, creates a job row, and
// schedules the real work via after() — it returns almost immediately, so it
// no longer needs multi-minute headroom. See job-runner.ts for the full
// reasoning (production-hardening spec §1): a live-measured transit-profile
// request took 4.7 minutes server-side, and blocking the HTTP response for
// that long is fragile in production (reverse-proxy read timeouts, mobile
// NAT drops, no resilience to a reload or restart) independent of whether
// this specific deployment target enforces `maxDuration` at all.
export const maxDuration = 15;

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
 *
 * Returns 202 with a job id immediately; poll
 * GET /api/itinerary/autoplan/{jobId} for progress and the final result.
 * (No UI consumes the old synchronous shape yet — see ROAMORA_ROADMAP.md's
 * production-hardening notes — so this is a clean contract change, not a
 * breaking one.)
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, autoplanRequestSchema);
  if (!parsed.ok) return parsed.response;

  let jobId: string;
  try {
    jobId = await createJob("autoplan", parsed.data);
  } catch (err) {
    return serverError(err, "JOB_CREATE_FAILED");
  }

  after(async () => {
    await markJobRunning(jobId);
    let step = 0;
    try {
      const result = await autoplan(parsed.data, {
        onProgress: (entry: ResearchTraceEntry) => {
          step += 1;
          reportJobProgress(jobId, step, 0, `${entry.stage}: ${entry.detail}`).catch(() => {});
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

  return NextResponse.json({ jobId, statusUrl: `/api/itinerary/autoplan/${jobId}` }, { status: 202 });
}
