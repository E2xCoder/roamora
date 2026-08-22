import "server-only";

/**
 * Per-engine health tracking for SearXNG's upstream engines.
 *
 * SearXNG already reports, on every single search response, exactly which
 * of its configured engines failed on that specific query and why —
 * `unresponsive_engines: [["duckduckgo", "CAPTCHA"], ["startpage", "CAPTCHA"]]`.
 * This module accumulates that real, per-request signal into a running
 * picture (in-memory, process-lifetime — same pattern as
 * capabilities.ts's cache) rather than treating each search as if the last
 * one told it nothing.
 *
 * Deliberately does NOT try to disable/re-enable engines in SearXNG's own
 * config — SearXNG already does its own internal per-engine suspension
 * (the `suspended_time` seen in its logs). This module's job is honest
 * observability (so the app can report "search is degraded: 4/9 engines
 * currently unresponsive" instead of silently returning fewer, worse
 * results) and one concrete decision: whether a bounded retry is worth
 * attempting for the *next* query, or the engines are so uniformly down
 * right now that retrying immediately would just hammer them again.
 */

export interface EngineHealth {
  engine: string;
  successCount: number;
  failureCount: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

const health = new Map<string, EngineHealth>();

function getOrCreate(engine: string): EngineHealth {
  let entry = health.get(engine);
  if (!entry) {
    entry = { engine, successCount: 0, failureCount: 0, lastFailureReason: null, lastFailureAt: null, lastSuccessAt: null };
    health.set(engine, entry);
  }
  return entry;
}

export function recordEngineSuccess(engine: string): void {
  const e = getOrCreate(engine);
  e.successCount++;
  e.lastSuccessAt = Date.now();
}

export function recordEngineFailure(engine: string, reason: string): void {
  const e = getOrCreate(engine);
  e.failureCount++;
  e.lastFailureReason = reason;
  e.lastFailureAt = Date.now();
}

/** Ingests one real SearXNG response's outcome for every engine it actually reports on. */
export function recordSearchOutcome(respondingEngines: string[], unresponsive: Array<[string, string]>): void {
  for (const engine of respondingEngines) recordEngineSuccess(engine);
  for (const [engine, reason] of unresponsive) recordEngineFailure(engine, reason);
}

export function getEngineHealthSnapshot(): EngineHealth[] {
  return [...health.values()].sort((a, b) => a.engine.localeCompare(b.engine));
}

/** A recent failure with no success since is the real, observable signature of "currently down", not a guess. */
export function isEngineDown(engine: string): boolean {
  const e = health.get(engine);
  if (!e || !e.lastFailureAt) return false;
  return e.lastSuccessAt == null || e.lastFailureAt > e.lastSuccessAt;
}

/** True only when every engine this session has ever seen is currently down — the real basis for "don't bother retrying yet". */
export function areAllKnownEnginesDown(): boolean {
  const all = [...health.values()];
  if (all.length === 0) return false; // nothing observed yet — no basis to claim total failure
  return all.every((e) => isEngineDown(e.engine));
}

export function resetEngineHealth(): void {
  health.clear();
}

/** How many of the engines this session has actually observed are currently down — real counts for honest degradation reporting, not a boolean. */
export function getDegradationSummary(): { downCount: number; totalKnown: number } {
  const all = [...health.values()];
  return { downCount: all.filter((e) => isEngineDown(e.engine)).length, totalKnown: all.length };
}
