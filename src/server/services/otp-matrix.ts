import "server-only";
import { planTransitTripsBatch, OtpUnavailableError, type BatchTripRequest, type OtpTripResult } from "@/server/providers/transit/otp";
import { fetchMatrix, type Matrix, type MatrixPoint } from "@/server/services/osrm-matrix";

/**
 * Stop-to-stop duration/distance matrix via real OpenTripPlanner trip
 * planning. Unlike OSRM's `/table/`, OTP has no batch matrix endpoint — but
 * its GraphQL API does support aliasing multiple `plan` fields into one HTTP
 * request, confirmed live: 20 aliased pairs answered correctly in one
 * ~3.9s request. This batches pairs (BATCH_SIZE per request) and runs
 * several batches concurrently (bounded by CONCURRENT_BATCHES) instead of
 * one HTTP round trip per pair — the same total pair budget (MAX_OTP_CALLS)
 * completes in a fraction of the wall-clock time and HTTP overhead.
 *
 * Any pair beyond the budget, or that OTP fails to answer, falls back to
 * the real OSRM walking time for that pair rather than being left blank or
 * guessed — `source` reports honestly which happened, and the caller
 * receives per-category counts (attempted/succeeded/skipped) rather than a
 * single aggregate that hides which case occurred.
 */

export const MAX_OTP_CALLS = 60;
const BATCH_SIZE = 15;
const CONCURRENT_BATCHES = 3;

export interface TransitMatrixStats {
  /** Total stop-pairs this matrix covers (n*(n-1)). */
  totalPairs: number;
  /** Real OTP calls actually made this invocation (capped by MAX_OTP_CALLS, excludes cache hits). */
  otpCalls: number;
  /** Of those calls, how many returned a real transit itinerary. */
  otpSucceeded: number;
  /** Of those calls, how many errored (network/GraphQL failure) rather than returning a real "no route" result. */
  otpFailures: number;
  /** Pairs never attempted because MAX_OTP_CALLS was already reached (counting only pairs not already resolved by `cache`). */
  skippedDueToCap: number;
  /** Whether any pair in this matrix used the OSRM walking fallback instead of a real OTP time. */
  fallbackUsed: boolean;
  /** Pairs answered from `cache` instead of a real network call this invocation. */
  cacheHits: number;
}

interface PairRef {
  i: number;
  j: number;
}

/**
 * Real, in-process pair→result cache, keyed by exact coordinates + date +
 * time. Scoped by the caller to a single autoplan() request (see
 * autoplan.ts) — its whole purpose is that a single trip's `routeAndOptimize`
 * re-runs the matrix up to 4 times (initial routing, hidden-gem-reroute,
 * budget-reroute, departure-safety-reroute) against a stop set that is
 * usually only one stop different each time. Without this, every re-run
 * re-spent its full MAX_OTP_CALLS budget on pairs it had already resolved
 * moments earlier — live-measured as the dominant cause of a 4.7-minute
 * transit-profile request (see ROAMORA_ROADMAP.md's production-hardening
 * notes). `null` (OTP genuinely found no route) is cached same as a real
 * itinerary, since it is itself a real, stable answer; a pair whose OTP call
 * errored is deliberately left uncached so the next reroute stage gets a
 * fresh chance at it rather than a permanently "stuck" failure.
 */
export type TransitPairCache = Map<string, OtpTripResult | null>;

export function pairCacheKey(a: MatrixPoint, b: MatrixPoint, date: string, time: string): string {
  return `${a.lat},${a.lng}|${b.lat},${b.lng}|${date}|${time}`;
}

export async function fetchTransitMatrix(
  points: MatrixPoint[],
  otpUrl: string,
  date: string,
  time: string,
  cache?: TransitPairCache
): Promise<Matrix & TransitMatrixStats> {
  const n = points.length;
  const fallback = await fetchMatrix(points, "foot");

  const durations = fallback.durations.map((row) => [...row]);
  const distances = fallback.distances.map((row) => [...row]);

  const allPairs: PairRef[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) allPairs.push({ i, j });
    }
  }
  const totalPairs = allPairs.length;

  let cacheHits = 0;
  let cacheHitsWithRoute = 0;
  const uncachedPairs: PairRef[] = [];
  for (const p of allPairs) {
    const key = cache ? pairCacheKey(points[p.i], points[p.j], date, time) : null;
    const cached = key ? cache!.get(key) : undefined;
    if (cached !== undefined) {
      cacheHits++;
      if (cached) {
        durations[p.i][p.j] = cached.durationSeconds;
        distances[p.i][p.j] = cached.distanceMeters;
        cacheHitsWithRoute++;
      }
      // cached === null: a real, previously-confirmed "no route" — walking fallback stands.
    } else {
      uncachedPairs.push(p);
    }
  }

  const pairsToAttempt = uncachedPairs.slice(0, MAX_OTP_CALLS);
  const skippedDueToCap = uncachedPairs.length - pairsToAttempt.length;

  const batches: PairRef[][] = [];
  for (let i = 0; i < pairsToAttempt.length; i += BATCH_SIZE) {
    batches.push(pairsToAttempt.slice(i, i + BATCH_SIZE));
  }

  let otpSucceeded = 0;
  let otpFailures = 0;
  let loggedFailure = false;

  async function runBatch(batch: PairRef[]) {
    const requests: BatchTripRequest[] = batch.map((p, idx) => ({
      key: String(idx),
      from: points[p.i],
      to: points[p.j],
    }));
    try {
      const results = await planTransitTripsBatch(otpUrl, requests, date, time);
      batch.forEach((p, idx) => {
        const key = String(idx);
        const known = results.has(key);
        const trip = results.get(key) ?? null;
        if (trip) {
          durations[p.i][p.j] = trip.durationSeconds;
          distances[p.i][p.j] = trip.distanceMeters;
          otpSucceeded++;
        }
        // trip === null (known): OTP genuinely found no route for this pair —
        // the walking fallback stands, correctly, not a failure.
        // !known: that specific alias errored within an otherwise-successful
        // batch — also falls back, silently for this one pair, same as a
        // genuine "no route" (see planTransitTripsBatch), but deliberately
        // not cached so the next reroute stage gets a fresh chance at it.
        if (cache && known) {
          cache.set(pairCacheKey(points[p.i], points[p.j], date, time), trip);
        }
      });
    } catch (err) {
      otpFailures += batch.length; // the whole batch's HTTP/GraphQL request itself failed
      if (err instanceof OtpUnavailableError && !loggedFailure) {
        loggedFailure = true;
        console.error("[otp-matrix] OTP unreachable, falling back to walking:", err.message);
      }
    }
  }

  // Bounded concurrency: run up to CONCURRENT_BATCHES requests at once
  // rather than either fully sequential (slow) or fully parallel
  // (could overwhelm a single self-hosted JVM instance holding a whole
  // city's graph in memory).
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      await runBatch(batch);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_BATCHES, batches.length) }, worker));

  const otpCalls = pairsToAttempt.length;
  const totalResolvedByTransit = otpSucceeded + cacheHitsWithRoute;
  const fallbackUsed = totalResolvedByTransit < totalPairs;
  const source: Matrix["source"] = totalResolvedByTransit === 0
    ? fallback.source // OTP/cache never answered a single pair — purely the OSRM/haversine fallback
    : !fallbackUsed
      ? "otp"
      : "otp+osrm"; // some pairs are real OTP transit times (this call or cached from an earlier one), the rest fell back to walking

  return {
    durations,
    distances,
    source,
    totalPairs,
    otpCalls,
    otpSucceeded,
    otpFailures,
    skippedDueToCap,
    fallbackUsed,
    cacheHits,
  };
}
