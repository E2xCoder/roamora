/**
 * Deterministic itinerary sequencing.
 *
 * This is the part a chat-based assistant cannot do reliably: an LLM has no
 * real notion of geographic distance, so asked to sequence a list of places it
 * guesses — which is why a naive prompt produces a route that starts at the
 * farthest point and works inward. This module never asks a model to order
 * anything. It takes a real distance/duration matrix (from OSRM) and a set of
 * time constraints supplied by the user, and solves the ordering with a
 * cheapest-insertion construction plus a constrained 2-opt improvement pass —
 * the same family of heuristic used for the travelling salesman problem with
 * time windows (TSPTW).
 *
 * No network access, no LLM call, no randomness: given the same input this
 * always returns the same output, so it is fully unit-testable.
 */

export interface StopInput {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Minutes to spend at this stop. Falls back to a category-based default. */
  visitMinutes?: number;
  category?: string;
  /** Cannot arrive before this clock time ("HH:MM") — e.g. opening time. */
  earliestTime?: string;
  /** Must arrive by this clock time — e.g. last entry. */
  latestTime?: string;
  /** Must arrive at (approximately) this exact time — e.g. a timed show. */
  fixedTime?: string;
  /** Keep this stop at its given position; the solver may not move it. */
  locked?: boolean;
  estimatedCost?: number;
}

export interface OptimizeRequest {
  stops: StopInput[];
  /** Day start, "HH:MM". The clock the schedule is simulated from. */
  dayStart: string;
  /** Day end, "HH:MM". Stops finishing after this are flagged, not dropped. */
  dayEnd: string;
  start: { lat: number; lng: number; name?: string };
  end?: { lat: number; lng: number; name?: string };
  /**
   * Multiplies raw routing time to account for crossings, photos, crowds,
   * wrong turns — the gap between navigation-app time and how long a person
   * actually takes (this is an explicit, documented estimate, not a
   * measurement — the UI must not present it as more precise than it is).
   */
  realismFactor?: number;
}

export interface ScheduledStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  order: number;
  arrivalTime: string;
  departureTime: string;
  waitMinutes: number;
  visitMinutes: number;
  travelFromPrevMeters: number;
  travelFromPrevSeconds: number;
  /** Passthrough of the matching StopInput's own fields — display-only, never used by the solver itself (which already consumed them as constraints upstream of this output). */
  estimatedCost?: number;
  earliestTime?: string;
  latestTime?: string;
}

export interface Conflict {
  stopId: string;
  stopName: string;
  kind: "fixed-time-missed" | "latest-time-missed" | "unplaceable" | "day-overrun";
  detail: string;
}

export interface OptimizeResult {
  feasible: boolean;
  stops: ScheduledStop[];
  conflicts: Conflict[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalCost: number;
  costKnown: boolean;
  dayEndTime: string;
  overrunMinutes: number;
}

const DEFAULT_REALISM_FACTOR = 1.2;

/** Fallback visit duration by category (spec §17), used only when unset. */
const DEFAULT_VISIT_MINUTES: Record<string, number> = {
  museum: 75,
  castle: 60,
  church: 15,
  historic: 20,
  landmark: 10,
  monument: 5,
  viewpoint: 12,
  park: 30,
  nature: 30,
  beach: 60,
  restaurant: 60,
  cafe: 30,
  bar: 45,
  bakery: 10,
  market: 25,
  shopping: 30,
  hike: 90,
  accommodation: 10,
  attraction: 25,
};
const FALLBACK_VISIT_MINUTES = 20;

function visitMinutesFor(stop: StopInput): number {
  if (stop.visitMinutes != null) return stop.visitMinutes;
  if (stop.category && DEFAULT_VISIT_MINUTES[stop.category] != null) {
    return DEFAULT_VISIT_MINUTES[stop.category];
  }
  return FALLBACK_VISIT_MINUTES;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const m = Math.round(minutes) % (24 * 60);
  const wrapped = m < 0 ? m + 24 * 60 : m;
  const h = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Inserts each flexible stop at whichever position in the current route adds
 * the least travel distance, among positions where every time constraint in
 * the resulting route is still satisfiable. This is the "cheapest insertion"
 * TSP heuristic, extended with a feasibility check per candidate position.
 */
export function optimizeItinerary(
  req: OptimizeRequest,
  matrix: { durations: number[][]; distances: number[][] }
): OptimizeResult {
  const realism = req.realismFactor ?? DEFAULT_REALISM_FACTOR;
  const dayStartMin = toMinutes(req.dayStart);
  const dayEndMin = toMinutes(req.dayEnd);

  // --- 1. split into anchors (fixed-time or locked) and flexible stops ----
  const indexed = req.stops.map((s, i) => ({ stop: s, matrixIndex: i + 1 }));

  const anchors = indexed
    .filter((x) => x.stop.fixedTime || x.stop.locked)
    .sort((a, b) => {
      const at = a.stop.fixedTime ? toMinutes(a.stop.fixedTime) : -Infinity;
      const bt = b.stop.fixedTime ? toMinutes(b.stop.fixedTime) : -Infinity;
      return at - bt;
    });

  const flexible = indexed
    .filter((x) => !x.stop.fixedTime && !x.stop.locked)
    // Tightest-window stops get inserted first, so they get first pick of a
    // good slot; free-floating stops fill in around them.
    .sort((a, b) => windowWidth(a.stop) - windowWidth(b.stop));

  // route: sequence of matrix indices, starting from the virtual start (0).
  let route: number[] = [0, ...anchors.map((a) => a.matrixIndex)];
  const placed = new Map<number, StopInput>();
  for (const a of anchors) placed.set(a.matrixIndex, a.stop);

  const unplaceable: Conflict[] = [];

  // --- 2. cheapest feasible insertion for every flexible stop --------------
  for (const { stop, matrixIndex } of flexible) {
    let best: { position: number; extraCost: number } | null = null;

    // Try every gap in the current route (after index 0, i.e. never before
    // the start point).
    for (let pos = 1; pos <= route.length; pos++) {
      const candidate = [...route.slice(0, pos), matrixIndex, ...route.slice(pos)];
      const sim = simulate(candidate, placed, matrixIndex, stop, matrix, dayStartMin, realism);
      if (!sim.feasible) continue;

      const prev = route[pos - 1];
      const next = route[pos] ?? null;
      const extra =
        matrix.distances[prev][matrixIndex] +
        (next != null ? matrix.distances[matrixIndex][next] - matrix.distances[prev][next] : 0);

      if (!best || extra < best.extraCost) best = { position: pos, extraCost: extra };
    }

    if (best) {
      route = [...route.slice(0, best.position), matrixIndex, ...route.slice(best.position)];
      placed.set(matrixIndex, stop);
    } else {
      unplaceable.push({
        stopId: stop.id,
        stopName: stop.name,
        kind: "unplaceable",
        detail:
          "Bu durak hangi konuma eklenirse eklensin sabit saatli bir durağı kaçırtıyor. Sabit saati gevşet ya da bu durağı çıkar.",
      });
    }
  }

  // --- 3. bounded 2-opt over non-anchored, adjacent-swappable pairs -------
  route = twoOptImprove(route, placed, matrix, dayStartMin, realism);

  // --- 4. final schedule simulation, keeping every conflict, not just the
  //        first one — the user needs to see the whole picture at once ----
  const schedule = buildSchedule(route, placed, matrix, dayStartMin, realism);

  const conflicts: Conflict[] = [...unplaceable];
  let cursorMin = dayStartMin;

  for (const s of schedule) {
    const stop = placed.get(s.matrixIndex);
    if (!stop) continue;

    if (stop.fixedTime) {
      // buildSchedule always forces `arrivalTime` to the appointed clock time
      // for a fixed-time stop, so comparing it against itself can never
      // detect a miss. The real arrival — before that forcing — is
      // `rawArrivalMin`, which is what must be checked here.
      const target = toMinutes(stop.fixedTime);
      if (s.rawArrivalMin > target + 1) {
        conflicts.push({
          stopId: stop.id,
          stopName: stop.name,
          kind: "fixed-time-missed",
          detail: `Saat ${stop.fixedTime}'e yetişilemiyor — oraya en erken ${toHHMM(s.rawArrivalMin)}'de varılıyor.`,
        });
      }
    }
    if (stop.latestTime) {
      const limit = toMinutes(stop.latestTime);
      if (s.rawArrivalMin > limit) {
        conflicts.push({
          stopId: stop.id,
          stopName: stop.name,
          kind: "latest-time-missed",
          detail: `En geç ${stop.latestTime}'e kadar varılmalıydı, hesaplanan varış ${toHHMM(s.rawArrivalMin)}.`,
        });
      }
    }
    cursorMin = toMinutes(s.departureTime);
  }

  const overrunMinutes = Math.max(0, cursorMin - dayEndMin);
  if (overrunMinutes > 0) {
    conflicts.push({
      stopId: "__day__",
      stopName: "Gün sonu",
      kind: "day-overrun",
      detail: `Plan, gün bitişinden ${overrunMinutes} dakika sonra tamamlanıyor. Bir durağı çıkarmayı ya da başlangıç saatini erkene almayı düşün.`,
    });
  }

  const totalDistanceMeters = schedule.reduce((s, x) => s + x.travelFromPrevMeters, 0);
  const totalDurationSeconds = schedule.reduce((s, x) => s + x.travelFromPrevSeconds, 0);

  const costs = schedule.map((s) => placed.get(s.matrixIndex)?.estimatedCost);
  const costKnown = costs.every((c) => c != null);
  const totalCost = costKnown ? costs.reduce((s, c) => s + (c ?? 0), 0) : 0;

  return {
    feasible: conflicts.length === 0,
    stops: schedule.map((s) => ({
      id: placed.get(s.matrixIndex)!.id,
      name: placed.get(s.matrixIndex)!.name,
      lat: placed.get(s.matrixIndex)!.lat,
      lng: placed.get(s.matrixIndex)!.lng,
      order: s.order,
      arrivalTime: s.arrivalTime,
      departureTime: s.departureTime,
      waitMinutes: s.waitMinutes,
      visitMinutes: s.visitMinutes,
      travelFromPrevMeters: s.travelFromPrevMeters,
      travelFromPrevSeconds: s.travelFromPrevSeconds,
      estimatedCost: placed.get(s.matrixIndex)!.estimatedCost,
      earliestTime: placed.get(s.matrixIndex)!.earliestTime,
      latestTime: placed.get(s.matrixIndex)!.latestTime,
    })),
    conflicts,
    totalDistanceMeters,
    totalDurationSeconds,
    totalCost,
    costKnown,
    dayEndTime: req.dayEnd,
    overrunMinutes,
  };
}

function windowWidth(stop: StopInput): number {
  const e = stop.earliestTime ? toMinutes(stop.earliestTime) : 0;
  const l = stop.latestTime ? toMinutes(stop.latestTime) : 24 * 60;
  return l - e;
}

interface SimStep {
  matrixIndex: number;
  order: number;
  rawArrivalMin: number;
  arrivalTime: string;
  departureTime: string;
  waitMinutes: number;
  visitMinutes: number;
  travelFromPrevMeters: number;
  travelFromPrevSeconds: number;
}

/**
 * Simulates a full route's schedule and reports whether every HARD
 * constraint holds — meaning `fixedTime` only.
 *
 * `latestTime` is deliberately not a gate here. Treating it as one meant a
 * stop that could not make its own cutoff from any position was excluded
 * from the plan entirely (kind "unplaceable") instead of being placed at its
 * best slot and flagged with the specific, more informative
 * "latest-time-missed" conflict the final pass reports. `earliestTime` is
 * likewise never a gate — it only pushes the arrival forward to a wait.
 */
function simulate(
  route: number[],
  placed: Map<number, StopInput>,
  probeIndex: number | null,
  probeStop: StopInput | null,
  matrix: { durations: number[][]; distances: number[][] },
  dayStartMin: number,
  realism: number
): { feasible: boolean } {
  let cursor = dayStartMin;
  let prev = route[0];

  for (let i = 1; i < route.length; i++) {
    const idx = route[i];
    const stop = idx === probeIndex ? probeStop! : placed.get(idx)!;
    const travelSec = matrix.durations[prev][idx] * realism;
    let arrival = cursor + travelSec / 60;

    if (stop.earliestTime) arrival = Math.max(arrival, toMinutes(stop.earliestTime));
    if (stop.fixedTime) {
      const target = toMinutes(stop.fixedTime);
      if (arrival > target + 1) return { feasible: false }; // arrives too late for the appointment
      arrival = target;
    }

    cursor = arrival + visitMinutesFor(stop);
    prev = idx;
  }

  return { feasible: true };
}

function buildSchedule(
  route: number[],
  placed: Map<number, StopInput>,
  matrix: { durations: number[][]; distances: number[][] },
  dayStartMin: number,
  realism: number
): (SimStep & { matrixIndex: number })[] {
  const out: (SimStep & { matrixIndex: number })[] = [];
  let cursor = dayStartMin;
  let prev = route[0];
  let order = 1;

  for (let i = 1; i < route.length; i++) {
    const idx = route[i];
    const stop = placed.get(idx)!;
    const travelSec = matrix.durations[prev][idx] * realism;
    const rawArrival = cursor + travelSec / 60;
    let arrival = rawArrival;

    if (stop.earliestTime) arrival = Math.max(arrival, toMinutes(stop.earliestTime));
    if (stop.fixedTime) arrival = toMinutes(stop.fixedTime);

    const wait = Math.max(0, arrival - rawArrival);
    const visit = visitMinutesFor(stop);
    const departure = arrival + visit;

    out.push({
      matrixIndex: idx,
      order: order++,
      rawArrivalMin: rawArrival,
      arrivalTime: toHHMM(arrival),
      departureTime: toHHMM(departure),
      waitMinutes: Math.round(wait),
      visitMinutes: visit,
      travelFromPrevMeters: Math.round(matrix.distances[prev][idx]),
      travelFromPrevSeconds: Math.round(travelSec),
    });

    cursor = departure;
    prev = idx;
  }

  return out;
}

/**
 * Swaps adjacent, unlocked, non-fixed-time stops when doing so shortens total
 * travel distance and every window still holds. Anchors (fixed-time/locked)
 * never move — this is what lets a hard 13:00 appointment stay put while
 * everything flexible reflows around it.
 */
function twoOptImprove(
  route: number[],
  placed: Map<number, StopInput>,
  matrix: { durations: number[][]; distances: number[][] },
  dayStartMin: number,
  realism: number
): number[] {
  const isMovable = (idx: number) => {
    const stop = placed.get(idx);
    return stop && !stop.fixedTime && !stop.locked;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard++;

    for (let i = 1; i < route.length - 1; i++) {
      if (!isMovable(route[i]) || !isMovable(route[i + 1])) continue;

      const swapped = [...route];
      [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];

      const before = routeDistance(route, matrix);
      const after = routeDistance(swapped, matrix);
      if (after >= before) continue;

      if (simulate(swapped, placed, null, null, matrix, dayStartMin, realism).feasible) {
        route = swapped;
        improved = true;
      }
    }
  }

  return route;
}

function routeDistance(route: number[], matrix: { distances: number[][] }): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) total += matrix.distances[route[i]][route[i + 1]];
  return total;
}
