import "server-only";
import { planTransitTrip, OtpUnavailableError } from "@/server/providers/transit/otp";
import { fetchMatrix, type Matrix, type MatrixPoint } from "@/server/services/osrm-matrix";

/**
 * Stop-to-stop duration/distance matrix via real OpenTripPlanner trip
 * planning. Unlike OSRM's `/table/`, OTP has no batch matrix endpoint — one
 * GraphQL request plans one pair. A full n×n matrix is therefore capped by
 * `MAX_OTP_CALLS`; any pair beyond the budget, or that OTP fails to answer,
 * falls back to the real OSRM walking time for that pair rather than being
 * left blank or guessed. `source` reports honestly which happened.
 */

const MAX_OTP_CALLS = 60;

export async function fetchTransitMatrix(
  points: MatrixPoint[],
  otpUrl: string,
  date: string,
  time: string
): Promise<Matrix & { otpCalls: number; otpFailures: number }> {
  const n = points.length;
  const fallback = await fetchMatrix(points, "foot");

  const durations = fallback.durations.map((row) => [...row]);
  const distances = fallback.distances.map((row) => [...row]);

  let otpCalls = 0;
  let otpFailures = 0;
  let anyOtpSuccess = false;

  outer: for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (otpCalls >= MAX_OTP_CALLS) break outer;

      otpCalls++;
      try {
        const trip = await planTransitTrip(otpUrl, points[i], points[j], date, time);
        if (trip) {
          durations[i][j] = trip.durationSeconds;
          distances[i][j] = trip.distanceMeters;
          anyOtpSuccess = true;
        }
        // trip === null: OTP genuinely found no route (e.g. unreachable within
        // search window) — the walking fallback for this pair stands as-is.
      } catch (err) {
        otpFailures++;
        if (err instanceof OtpUnavailableError && otpFailures === 1) {
          // First failure logged once; a flaky OTP for the rest of the run
          // just silently falls back per-pair rather than spamming logs.
          console.error("[otp-matrix] OTP unreachable, falling back to walking:", err.message);
        }
      }
    }
  }

  const allPairsAttempted = otpCalls >= n * (n - 1);
  const source: Matrix["source"] = !anyOtpSuccess
    ? fallback.source // OTP never answered a single pair — purely the OSRM/haversine fallback
    : allPairsAttempted && otpFailures === 0
      ? "otp"
      : "otp+osrm"; // some pairs are real OTP transit times, the rest fell back to walking

  return {
    durations,
    distances,
    source,
    otpCalls,
    otpFailures,
  };
}
