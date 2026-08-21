import "server-only";

/**
 * Real-time transit trip planning against a self-hosted OpenTripPlanner 2.9
 * instance (OSM street network + GTFS feed for one destination).
 *
 * OTP 2.x's routable API is GraphQL at `/otp/gtfs/v1` — the older
 * `/otp/routers/default/plan` REST endpoint used by OTP1 no longer exists.
 * There is no batch "table" endpoint like OSRM's, so a full stop-to-stop
 * matrix means one request per pair; callers are expected to cap how many
 * pairs they ask for (see `otp-matrix.ts`).
 */

export interface OtpPoint {
  lat: number;
  lng: number;
}

export interface OtpTripResult {
  durationSeconds: number;
  distanceMeters: number;
  hasTransit: boolean;
  legs: Array<{ mode: string; routeName?: string }>;
}

export class OtpUnavailableError extends Error {
  constructor(detail: string) {
    super(`OpenTripPlanner'a ulaşılamadı: ${detail}`);
    this.name = "OtpUnavailableError";
  }
}

const PLAN_QUERY = `
  query Plan($from: InputCoordinates, $to: InputCoordinates, $date: String, $time: String) {
    plan(from: $from, to: $to, date: $date, time: $time, transportModes: [{mode: WALK}, {mode: TRANSIT}]) {
      itineraries {
        duration
        legs {
          mode
          distance
          route { shortName longName }
        }
      }
    }
  }
`;

/**
 * Plans one real trip between two points for a given date/time. Returns the
 * shortest-duration itinerary OTP finds (walk-only if no transit connects
 * them), or `null` if OTP genuinely found no route — that is a real result,
 * not a failure, so it is not thrown.
 */
export async function planTransitTrip(
  otpUrl: string,
  from: OtpPoint,
  to: OtpPoint,
  date: string, // YYYY-MM-DD
  time: string // HH:MM
): Promise<OtpTripResult | null> {
  let res: Response;
  try {
    res = await fetch(`${otpUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PLAN_QUERY,
        variables: {
          from: { lat: from.lat, lon: from.lng },
          to: { lat: to.lat, lon: to.lng },
          date,
          time,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OtpUnavailableError(err instanceof Error ? err.message : "network hatası");
  }

  if (!res.ok) throw new OtpUnavailableError(`HTTP ${res.status}`);

  const body = await res.json();
  if (body.errors) {
    throw new OtpUnavailableError(body.errors[0]?.message ?? "GraphQL hatası");
  }

  const itineraries = body.data?.plan?.itineraries as
    | Array<{ duration: number; legs: Array<{ mode: string; distance: number; route: { shortName: string; longName: string } | null }> }>
    | undefined;
  if (!itineraries || itineraries.length === 0) return null;

  const best = itineraries.reduce((a, b) => (a.duration <= b.duration ? a : b));
  return {
    durationSeconds: best.duration,
    distanceMeters: best.legs.reduce((sum, l) => sum + l.distance, 0),
    hasTransit: best.legs.some((l) => l.mode !== "WALK"),
    legs: best.legs.map((l) => ({
      mode: l.mode,
      routeName: l.route ? (l.route.shortName || l.route.longName || undefined) : undefined,
    })),
  };
}

/** Cheap liveness check — OTP's build-info endpoint, not the removed `/otp/routers/default`. */
export async function otpIsReachable(otpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${otpUrl}/otp`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
