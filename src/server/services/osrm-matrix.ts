import "server-only";
import { osrmHostFor } from "@/server/config";

/**
 * Full pairwise distance/duration matrix via OSRM's table service.
 *
 * The itinerary optimizer needs every stop's travel time to every other stop,
 * not just consecutive legs. Calling /route/ for each pair is O(n²) requests;
 * OSRM's /table/ endpoint returns the whole matrix in one call.
 */

export interface MatrixPoint {
  lat: number;
  lng: number;
}

export interface Matrix {
  /** durations[i][j] = seconds from point i to point j. */
  durations: number[][];
  /** distances[i][j] = metres from point i to point j. */
  distances: number[][];
  source: "osrm" | "otp" | "otp+osrm" | "fallback";
}

function haversineMeters(a: MatrixPoint, b: MatrixPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line matrix, used only when the routing provider is unreachable. */
function fallbackMatrix(points: MatrixPoint[], speedMs: number): Matrix {
  const n = points.length;
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  const durations = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = haversineMeters(points[i], points[j]);
      distances[i][j] = d;
      durations[i][j] = d / speedMs;
    }
  }

  return { durations, distances, source: "fallback" };
}

export async function fetchMatrix(
  points: MatrixPoint[],
  profile: "foot" | "bike" | "car"
): Promise<Matrix> {
  const speedMs = profile === "bike" ? 4.2 : profile === "car" ? 13.9 : 1.4;

  if (points.length < 2) {
    return { durations: [[0]], distances: [[0]], source: "osrm" };
  }

  try {
    const host = osrmHostFor(profile);
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `${host}/table/v1/driving/${coords}?annotations=duration,distance`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Roamora/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`OSRM table ${res.status}`);

    const data = await res.json();
    if (data.code !== "Ok" || !data.durations) {
      throw new Error(data.code || "no matrix");
    }

    return {
      durations: data.durations,
      distances: data.distances ?? fallbackDistancesFromDurations(data.durations, speedMs),
      source: "osrm",
    };
  } catch (err) {
    console.error("[osrm-matrix] table service unavailable, using straight-line:", err);
    return fallbackMatrix(points, speedMs);
  }
}

/** Some OSRM builds omit `distances` unless explicitly requested; derive a rough figure rather than leaving it undefined. */
function fallbackDistancesFromDurations(durations: number[][], speedMs: number): number[][] {
  return durations.map((row) => row.map((d) => d * speedMs));
}
