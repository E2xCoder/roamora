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

export interface BatchTripRequest {
  /** Caller-supplied key so results can be matched back to their pair — kept opaque here. */
  key: string;
  from: OtpPoint;
  to: OtpPoint;
}

/**
 * Plans multiple trips in a single HTTP request using GraphQL query
 * aliasing — `query { p0: plan(...) { ... } p1: plan(...) { ... } }` — real
 * OTP 2.9 syntax, confirmed live: 20 aliased `plan` fields in one POST
 * returned all 20 results correctly in ~3.9s, against ~0.7s for 3 and
 * roughly 15–20s for 20 done one request at a time. GraphQL variables
 * can't vary per alias, so each pair's coordinates are inlined as literals
 * (never through unescaped string interpolation of anything except plain
 * numbers, which coordinates always are).
 *
 * Returns a Map from each request's `key` to its result — `null` for a pair
 * OTP genuinely found no route for (a real result), and simply absent from
 * the map for a pair whose GraphQL field itself errored (so the caller can
 * tell "no route" apart from "this one specifically failed" without the
 * whole batch throwing over one bad pair).
 */
export async function planTransitTripsBatch(
  otpUrl: string,
  requests: BatchTripRequest[],
  date: string,
  time: string
): Promise<Map<string, OtpTripResult | null>> {
  if (requests.length === 0) return new Map();

  const aliasFor = (i: number) => `p${i}`;
  const fields = requests
    .map(
      (r, i) => `${aliasFor(i)}: plan(
        from: {lat: ${r.from.lat}, lon: ${r.from.lng}},
        to: {lat: ${r.to.lat}, lon: ${r.to.lng}},
        date: "${date}", time: "${time}",
        transportModes: [{mode: WALK}, {mode: TRANSIT}]
      ) {
        itineraries { duration legs { mode distance route { shortName longName } } }
      }`
    )
    .join("\n");
  const query = `query { ${fields} }`;

  let res: Response;
  try {
    res = await fetch(`${otpUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OtpUnavailableError(err instanceof Error ? err.message : "network hatası");
  }

  if (!res.ok) throw new OtpUnavailableError(`HTTP ${res.status}`);

  const body = await res.json();
  // A batch can be a MIX of successful aliases and per-alias errors (e.g.
  // one pair outside the graph's coverage) — GraphQL reports that as a
  // top-level `errors` array alongside a partially-populated `data`, not as
  // an all-or-nothing failure, so `errors` alone must not short-circuit the
  // whole batch the way it does for the single-pair `planTransitTrip`.
  if (!body.data && body.errors) {
    throw new OtpUnavailableError(body.errors[0]?.message ?? "GraphQL hatası");
  }

  const results = new Map<string, OtpTripResult | null>();
  requests.forEach((r, i) => {
    const planResult = body.data?.[aliasFor(i)] as
      | { itineraries: Array<{ duration: number; legs: Array<{ mode: string; distance: number; route: { shortName: string; longName: string } | null }> }> }
      | null
      | undefined;
    if (planResult === undefined) return; // this specific alias errored — absent, not null
    if (planResult === null || planResult.itineraries.length === 0) {
      results.set(r.key, null);
      return;
    }
    const best = planResult.itineraries.reduce((a, b) => (a.duration <= b.duration ? a : b));
    results.set(r.key, {
      durationSeconds: best.duration,
      distanceMeters: best.legs.reduce((sum, l) => sum + l.distance, 0),
      hasTransit: best.legs.some((l) => l.mode !== "WALK"),
      legs: best.legs.map((l) => ({
        mode: l.mode,
        routeName: l.route ? (l.route.shortName || l.route.longName || undefined) : undefined,
      })),
    });
  });

  return results;
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
