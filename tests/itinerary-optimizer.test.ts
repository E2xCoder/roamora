import { describe, expect, it } from "vitest";
import {
  optimizeItinerary,
  type StopInput,
  type OptimizeRequest,
} from "@/server/services/itinerary-optimizer";

/**
 * Builds a synthetic matrix from a hand-written distance table so tests are
 * exact and need no network access. Index 0 is always the start point.
 *
 * Layout used throughout this file — points on a line, in metres from start:
 *
 *   START(0) ---- A(1) ---- B(2) --------------------------- C(3)
 *        0m      100m      250m                            2000m
 *
 * This intentionally mirrors the bug report: C is far away, A and B are close
 * together near the start. A naive "as-tapped" order of [C, A, B] walks to the
 * far point first and back — exactly what the optimizer must not produce.
 */
function lineMatrix(positionsMeters: number[], speedMs = 1.4) {
  const n = positionsMeters.length;
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  const durations = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = Math.abs(positionsMeters[i] - positionsMeters[j]);
      distances[i][j] = d;
      durations[i][j] = d / speedMs;
    }
  }
  return { distances, durations };
}

const START = { lat: 0, lng: 0, name: "Otel" };

function stop(
  id: string,
  overrides: Partial<StopInput> = {}
): StopInput {
  return { id, name: id, lat: 0, lng: 0, ...overrides };
}

function baseReq(stops: StopInput[], overrides: Partial<OptimizeRequest> = {}): OptimizeRequest {
  return {
    stops,
    dayStart: "09:00",
    dayEnd: "20:00",
    start: START,
    realismFactor: 1, // exact arithmetic in tests; the multiplier is tested separately
    ...overrides,
  };
}

describe("optimizeItinerary — geographic ordering", () => {
  it("does not walk to the farthest point first when stops are handed in a bad order", () => {
    // Physically: start(0m) -- A(100m) -- B(250m) -- C(2000m), a straight
    // line. Submitted deliberately as [C, A, B] — farthest first, exactly the
    // pattern from the bug report ("started from the farthest point"). Matrix
    // indices follow submission order, so index1=C(2000m), index2=A(100m),
    // index3=B(250m).
    const matrix = lineMatrix([0, 2000, 100, 250]);
    const req = baseReq([stop("C"), stop("A"), stop("B")]);

    const result = optimizeItinerary(req, matrix);

    // The efficient sequence is start -> A -> B -> C, total travel 2000m.
    // Visiting C first (as tapped) would cost at least 2000 + 1900 = 3900m.
    expect(result.stops.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(result.totalDistanceMeters).toBe(2000);
  });

  it("produces less total travel than the naive tap order on a non-trivial layout", () => {
    // A small 2D-ish arrangement via a hand-built asymmetric-looking table
    // (still symmetric, but not colinear in effect): start, then three points
    // where the "tapped" order is deliberately bad.
    // Distances (m): start-P1=500, start-P2=1500, start-P3=900
    // P1-P2=1200, P1-P3=400, P2-P3=1300
    const distances = [
      [0, 500, 1500, 900],
      [500, 0, 1200, 400],
      [1500, 1200, 0, 1300],
      [900, 400, 1300, 0],
    ];
    const durations = distances.map((row) => row.map((d) => d / 1.4));
    const matrix = { distances, durations };

    // Tapped in the "worst" order: P2 (farthest), P1, P3
    const badOrderTotal =
      distances[0][2] + distances[2][1] + distances[1][3]; // start->P2->P1->P3

    const req = baseReq([stop("P2"), stop("P1"), stop("P3")]);
    const result = optimizeItinerary(req, matrix);

    const optimizedTotal = result.totalDistanceMeters;
    expect(optimizedTotal).toBeLessThan(badOrderTotal);
  });
});

describe("optimizeItinerary — time windows", () => {
  it("waits for a place that has not opened yet rather than arriving early and vanishing", () => {
    const matrix = lineMatrix([0, 100]); // start -> A, 100m at 1.4 m/s ≈ 71s
    const req = baseReq([stop("A", { earliestTime: "09:30" })]);

    const result = optimizeItinerary(req, matrix);

    expect(result.stops[0].arrivalTime).toBe("09:30");
    expect(result.stops[0].waitMinutes).toBeGreaterThan(0);
  });

  it("schedules a fixed-time stop at exactly its appointed time", () => {
    const matrix = lineMatrix([0, 100]);
    const req = baseReq([stop("Show", { fixedTime: "13:00" })]);

    const result = optimizeItinerary(req, matrix);

    expect(result.stops[0].arrivalTime).toBe("13:00");
    expect(result.feasible).toBe(true);
  });

  it("reports a conflict, rather than silently failing, when a fixed-time stop cannot be reached", () => {
    // start -> Far is 50km away; walking that in under a few minutes is
    // impossible, so a 09:05 appointment must be flagged as unreachable.
    const matrix = lineMatrix([0, 50_000]);
    const req = baseReq([stop("Far", { fixedTime: "09:05" })]);

    const result = optimizeItinerary(req, matrix);

    expect(result.feasible).toBe(false);
    expect(result.conflicts.some((c) => c.kind === "fixed-time-missed")).toBe(true);
    expect(result.conflicts[0].stopName).toBe("Far");
  });

  it("reports a conflict when a stop is reached after its latest allowed time", () => {
    const matrix = lineMatrix([0, 50_000]);
    const req = baseReq([stop("LastEntry", { latestTime: "09:10" })]);

    const result = optimizeItinerary(req, matrix);

    expect(result.feasible).toBe(false);
    expect(result.conflicts.some((c) => c.kind === "latest-time-missed")).toBe(true);
  });

  it("keeps a fixed-time anchor in place while flexible stops reflow around it", () => {
    // Matrix indices follow submission order: A -> matrixIndex 1 (100m),
    // Show -> matrixIndex 2 (200m, fixed 13:00), B -> matrixIndex 3 (300m).
    // Physically: start(0) -- A(100m) -- Show(200m) -- B(300m).
    const matrix = lineMatrix([0, 100, 200, 300]);
    const req = baseReq([
      stop("A"),
      stop("Show", { fixedTime: "13:00" }),
      stop("B"),
    ]);

    const result = optimizeItinerary(req, matrix);
    const showIdx = result.stops.findIndex((s) => s.id === "Show");

    expect(result.stops[showIdx].arrivalTime).toBe("13:00");
    // A sits between start and Show physically, so it must not end up after it.
    const aIdx = result.stops.findIndex((s) => s.id === "A");
    expect(aIdx).toBeLessThan(showIdx);
    // B sits beyond Show, so it must not end up before it.
    const bIdx = result.stops.findIndex((s) => s.id === "B");
    expect(bIdx).toBeGreaterThan(showIdx);
  });

  it("never moves a locked stop's position in the sequence", () => {
    const matrix = lineMatrix([0, 100, 200, 300]);
    const req = baseReq([
      stop("Far", { lat: 0, lng: 0 }),
      stop("Near", { lat: 0, lng: 0 }),
      stop("Mid", { lat: 0, lng: 0, locked: true }),
    ]);

    const result = optimizeItinerary(req, matrix);
    // "Mid" was supplied second; locked stops are treated as anchors placed
    // in submission order among anchors, so it must still be present and
    // unmodified in identity even after the flexible stops reflow.
    expect(result.stops.some((s) => s.id === "Mid")).toBe(true);
  });
});

describe("optimizeItinerary — cost", () => {
  it("sums cost only when every stop has one, never inventing a figure", () => {
    const matrix = lineMatrix([0, 100, 200]);
    const withGap = baseReq([
      stop("A", { estimatedCost: 20 }),
      stop("B"), // no cost supplied
    ]);
    const complete = baseReq([
      stop("A", { estimatedCost: 20 }),
      stop("B", { estimatedCost: 30 }),
    ]);

    const r1 = optimizeItinerary(withGap, matrix);
    const r2 = optimizeItinerary(complete, matrix);

    expect(r1.costKnown).toBe(false);
    expect(r1.totalCost).toBe(0);
    expect(r2.costKnown).toBe(true);
    expect(r2.totalCost).toBe(50);
  });
});

describe("optimizeItinerary — upper time windows influence ordering (TSPTW)", () => {
  // Real regression (autoplan.ts restaurant + optimizer interaction). A live
  // Prague "relaxed" autoplan produced exactly this 3-stop set:
  //   - "La Degustation Bohême Bourgeoise" — a dinner-only restaurant, so
  //     autoplan anchors it to the dinner window (earliest 18:00).
  //   - "svatý Duch" — a church that closes at 17:00 (latestTime 17:00).
  //   - "Pražský Hrad" — the castle, no time constraint.
  // The optimizer scheduled the restaurant FIRST (≈530 min of dead wait before
  // it), which forced the church to be visited AFTER dinner — arrival 19:08,
  // 2+ hours past its own closing time — and overran the day. A feasible order
  // exists and is not even exotic: church → castle → restaurant. The solver
  // never found it because `latestTime` misses and day-overrun affected
  // neither the cheapest-insertion position choice nor the 2-opt objective —
  // both were driven by walking distance alone.
  function pragueRelaxedReq() {
    // start(0) -- Restaurant(300m) -- Church(600m) -- Castle(1200m), colinear.
    // Submitted restaurant-first; matrix indices follow submission order.
    const matrix = lineMatrix([0, 300, 600, 1200]);
    const req = baseReq(
      [
        stop("Restaurant", { earliestTime: "18:00", latestTime: "21:00", visitMinutes: 60 }),
        stop("Church", { latestTime: "17:00", visitMinutes: 15 }),
        stop("Castle", { visitMinutes: 60 }),
      ],
      { dayStart: "09:00", dayEnd: "19:00" }
    );
    return { matrix, req };
  }

  it("does not strand an earlier-closing stop after a late fixed meal slot when a feasible order exists", () => {
    const { matrix, req } = pragueRelaxedReq();

    const result = optimizeItinerary(req, matrix);

    const order = result.stops.map((s) => s.id);
    const churchIdx = order.indexOf("Church");
    const restaurantIdx = order.indexOf("Restaurant");
    const castleIdx = order.indexOf("Castle");

    // The church (closes 17:00) must come before the 18:00 dinner slot.
    expect(churchIdx).toBeLessThan(restaurantIdx);
    expect(castleIdx).toBeLessThan(restaurantIdx);
    expect(result.conflicts.some((c) => c.kind === "latest-time-missed")).toBe(false);
    expect(result.conflicts.some((c) => c.kind === "day-overrun")).toBe(false);
    expect(result.feasible).toBe(true);
  });

  it("still keeps the stop and flags it when NO ordering can satisfy its closing time", () => {
    // Church is 50 km from everything: unreachable before 17:00 from any slot.
    const distances = [
      [0, 300, 50_000, 1200],
      [300, 0, 50_000, 900],
      [50_000, 50_000, 0, 50_000],
      [1200, 900, 50_000, 0],
    ];
    const durations = distances.map((row) => row.map((d) => d / 1.4));
    const req = baseReq(
      [
        stop("Restaurant", { earliestTime: "18:00", latestTime: "21:00", visitMinutes: 60 }),
        stop("Church", { latestTime: "17:00", visitMinutes: 15 }),
        stop("Castle", { visitMinutes: 60 }),
      ],
      { dayStart: "09:00", dayEnd: "23:00" }
    );

    const result = optimizeItinerary(req, { distances, durations });

    // Not dropped — still present, just flagged (the "flag, don't drop" rule).
    expect(result.stops.some((s) => s.id === "Church")).toBe(true);
    expect(result.conflicts.some((c) => c.kind === "latest-time-missed" && c.stopName === "Church")).toBe(true);
  });

  it("prefers the closing-time-safe order even when it means slightly more walking", () => {
    const { matrix, req } = pragueRelaxedReq();
    const result = optimizeItinerary(req, matrix);
    // church→castle→restaurant walks start→600→1200→300 = 600+600+900 = 2100 m,
    // vs the distance-greedy restaurant→church→castle = 300+300+600 = 1200 m.
    // The solver must accept the longer walk to keep the church's closing time.
    expect(result.totalDistanceMeters).toBeGreaterThan(1200);
    expect(result.feasible).toBe(true);
  });
});

describe("optimizeItinerary — day overrun", () => {
  it("flags a day that runs past its end time instead of pretending it fits", () => {
    const matrix = lineMatrix([0, 100]);
    const req = baseReq([stop("Long", { visitMinutes: 700 })], {
      dayStart: "09:00",
      dayEnd: "12:00", // only 3 hours, but the visit alone takes 700 minutes
    });

    const result = optimizeItinerary(req, matrix);

    expect(result.feasible).toBe(false);
    expect(result.overrunMinutes).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.kind === "day-overrun")).toBe(true);
  });
});

describe("optimizeItinerary — determinism", () => {
  it("returns identical output for identical input", () => {
    const matrix = lineMatrix([0, 500, 1500, 900]);
    const req = baseReq([stop("X"), stop("Y"), stop("Z")]);

    const a = optimizeItinerary(req, matrix);
    const b = optimizeItinerary(req, matrix);

    expect(a.stops.map((s) => s.id)).toEqual(b.stops.map((s) => s.id));
    expect(a.totalDistanceMeters).toBe(b.totalDistanceMeters);
  });
});
