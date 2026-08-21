import "server-only";
import { planTransitTripsBatch, OtpUnavailableError, type BatchTripRequest } from "@/server/providers/transit/otp";
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
  /** Real OTP calls actually made (capped by MAX_OTP_CALLS). */
  otpCalls: number;
  /** Of those calls, how many returned a real transit itinerary. */
  otpSucceeded: number;
  /** Of those calls, how many errored (network/GraphQL failure) rather than returning a real "no route" result. */
  otpFailures: number;
  /** Pairs never attempted because MAX_OTP_CALLS was already reached. */
  skippedDueToCap: number;
  /** Whether any pair in this matrix used the OSRM walking fallback instead of a real OTP time. */
  fallbackUsed: boolean;
}

interface PairRef {
  i: number;
  j: number;
}

export async function fetchTransitMatrix(
  points: MatrixPoint[],
  otpUrl: string,
  date: string,
  time: string
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
  const pairsToAttempt = allPairs.slice(0, MAX_OTP_CALLS);
  const skippedDueToCap = totalPairs - pairsToAttempt.length;

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
        const trip = results.get(String(idx));
        if (trip) {
          durations[p.i][p.j] = trip.durationSeconds;
          distances[p.i][p.j] = trip.distanceMeters;
          otpSucceeded++;
        }
        // trip === null: OTP genuinely found no route for this pair — the
        // walking fallback stands, correctly, not a failure.
        // trip absent from the map: that specific alias errored within an
        // otherwise-successful batch — also falls back, silently for this
        // one pair, same as a genuine "no route" (see planTransitTripsBatch).
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
  const fallbackUsed = otpSucceeded < totalPairs;
  const source: Matrix["source"] = otpSucceeded === 0
    ? fallback.source // OTP never answered a single pair — purely the OSRM/haversine fallback
    : !fallbackUsed
      ? "otp"
      : "otp+osrm"; // some pairs are real OTP transit times, the rest fell back to walking

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
  };
}
