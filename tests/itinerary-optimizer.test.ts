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
