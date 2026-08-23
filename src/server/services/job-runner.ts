import "server-only";
import { prisma } from "@/lib/db";

/**
 * Async job execution over the existing `AiJob` table (prisma/schema.prisma
 * — real infrastructure that was already modeled for "long-running work",
 * just never wired to anything until now).
 *
 * Why this exists (production-hardening, spec §1): a real, live-measured
 * transit-profile autoplan request took 4.7 minutes server-side. Next.js's
 * own docs (node_modules/next/dist/docs/.../maxDuration.md,
 * .../self-hosting.md) confirm `maxDuration` is a hint platforms like Vercel
 * read from the build output to enforce their own serverless function
 * timeout — this project has no Vercel config, no serverless deploy target,
 * and ships `"start": "next start"` (package.json) behind the self-hosted
 * Docker Compose stack documented in infra/README.md. A self-hosted
 * `next start` process does not itself kill a slow request. But shipping a
 * route that blocks the HTTP response for 4.7 minutes is still fragile in
 * production for reasons that have nothing to do with maxDuration:
 *   - Reverse proxies (nginx, the exact tool infra's own self-hosting.md
 *     recommends putting in front of Next.js) commonly default
 *     proxy_read_timeout to 60s and would 504 a request this long unless an
 *     operator remembers to raise it specifically for this route.
 *   - Mobile networks and some corporate NATs silently drop TCP connections
 *     that look idle for a minute-plus, even mid-response.
 *   - A near-5-minute blocking call with zero progress feedback is bad UX
 *     regardless of platform, and is not resilient to a page reload or a
 *     server restart mid-request — the caller simply loses the itinerary.
 *
 * The fix: the route that creates a plan returns almost immediately with a
 * job id; the real autoplan() / planTripOptions() run detached from that
 * HTTP request via Next's `after()` (node_modules/next/dist/docs/.../
 * after.md — explicitly supported for both "Node.js server" and "Docker
 * container" self-hosting, exactly this project's real deployment shape);
 * progress and the final result are polled from the AiJob row.
 *
 * Honest limitation, not solved here: if the Node process itself restarts
 * mid-run (a deploy, a crash), the in-memory execution is gone and the job
 * would otherwise show "running" forever. `getJob` below detects this (a
 * job "running" past STALE_AFTER_MS) and reports it as failed rather than
 * hanging silently. A fully crash-proof resumable job would need a durable
 * external worker/queue (e.g. a separate process consuming a real queue) —
 * out of scope for a single self-hosted Node process and not something this
 * project's free/self-hostable stack currently has; noted as a real
 * remaining limitation rather than silently pretended away.
 */

const STALE_AFTER_MS = 15 * 60 * 1000; // longer than any real observed run (4.7 min) with real headroom

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  step: number;
  totalSteps: number;
  stepLabel: string | null;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createJob(kind: string, input: unknown): Promise<string> {
  const job = await prisma.aiJob.create({
    data: {
      kind,
      status: "pending",
      input: JSON.stringify(input),
    },
  });
  return job.id;
}

export async function markJobRunning(jobId: string): Promise<void> {
  await prisma.aiJob.update({
    where: { id: jobId },
    data: { status: "running", stepLabel: "başlatılıyor" },
  });
}

export async function reportJobProgress(jobId: string, step: number, totalSteps: number, stepLabel: string): Promise<void> {
  try {
    await prisma.aiJob.update({
      where: { id: jobId },
      data: { step, totalSteps, stepLabel },
    });
  } catch (err) {
    // Progress reporting is best-effort — must never take down the real work it's reporting on.
    console.error(`[job-runner] progress update failed for ${jobId}:`, err instanceof Error ? err.message : err);
  }
}

export async function completeJob(jobId: string, result: unknown): Promise<void> {
  await prisma.aiJob.update({
    where: { id: jobId },
    data: { status: "done", result: JSON.stringify(result), stepLabel: "tamamlandı" },
  });
}

export async function failJob(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.aiJob.update({
    where: { id: jobId },
    data: { status: "failed", error: message, stepLabel: "başarısız" },
  });
}

export async function getJob(jobId: string): Promise<JobView | null> {
  const job = await prisma.aiJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  const isStale = job.status === "running" && Date.now() - job.updatedAt.getTime() > STALE_AFTER_MS;
  const status = isStale ? "failed" : (job.status as JobStatus);
  const error = isStale
    ? "İş çok uzun süredir yanıt vermiyor — sunucu yeniden başlamış olabilir. Lütfen isteği yeniden gönderin."
    : job.error;

  if (isStale) {
    // Best-effort: persist the stale verdict so future polls don't re-derive it, but never let this fail the read.
    prisma.aiJob.update({ where: { id: jobId }, data: { status: "failed", error } }).catch(() => {});
  }

  return {
    id: job.id,
    kind: job.kind,
    status,
    step: job.step,
    totalSteps: job.totalSteps,
    stepLabel: job.stepLabel,
    result: status === "done" && job.result ? JSON.parse(job.result) : null,
    error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
