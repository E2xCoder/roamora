import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { pointInRing, pointInPolygon, pointInMultiPolygon, pointInGeometry } from "../scripts/geo-utils";

const SQUARE: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

describe("pointInRing", () => {
  it("finds a point inside a simple square", () => {
    expect(pointInRing([5, 5], SQUARE)).toBe(true);
  });

  it("finds a point outside a simple square", () => {
    expect(pointInRing([50, 50], SQUARE)).toBe(false);
  });

  it("finds a point just outside an edge", () => {
    expect(pointInRing([-1, 5], SQUARE)).toBe(false);
  });
});

describe("pointInPolygon", () => {
  const HOLE: [number, number][] = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];

  it("is inside the outer ring when there is no hole", () => {
    expect(pointInPolygon([5, 5], [SQUARE])).toBe(true);
  });

  it("is NOT inside when the point falls within a hole", () => {
    expect(pointInPolygon([5, 5], [SQUARE, HOLE])).toBe(false);
  });

  it("is still inside when the point is in the outer ring but outside the hole", () => {
    expect(pointInPolygon([1, 1], [SQUARE, HOLE])).toBe(true);
  });

  it("is outside when entirely outside the outer ring", () => {
    expect(pointInPolygon([50, 50], [SQUARE, HOLE])).toBe(false);
  });
});

describe("pointInMultiPolygon", () => {
  const SQUARE_B: [number, number][] = [
    [20, 20],
    [30, 20],
    [30, 30],
    [20, 30],
    [20, 20],
  ];

  it("is inside when the point falls in any one of the constituent polygons", () => {
    expect(pointInMultiPolygon([5, 5], [[SQUARE], [SQUARE_B]])).toBe(true);
    expect(pointInMultiPolygon([25, 25], [[SQUARE], [SQUARE_B]])).toBe(true);
  });

  it("is outside when it falls in neither polygon, including the gap between them", () => {
    expect(pointInMultiPolygon([15, 15], [[SQUARE], [SQUARE_B]])).toBe(false);
  });
});

describe("pointInGeometry — real Geofabrik data", () => {
  const wielkopolskie = JSON.parse(
    readFileSync(join(__dirname, "fixtures/wielkopolskie-geometry.json"), "utf8")
  );

  it("real case: Poznań's real coordinates fall inside the real wielkopolskie (Greater Poland) region boundary fetched live from Geofabrik's index-v1.json", () => {
    // GeoJSON coordinate order is [lng, lat].
    const poznan: [number, number] = [16.9252, 52.4064];
    expect(pointInGeometry(poznan, wielkopolskie)).toBe(true);
  });

  it("real case: Berlin's real coordinates fall OUTSIDE wielkopolskie (a different country entirely)", () => {
    const berlin: [number, number] = [13.405, 52.52];
    expect(pointInGeometry(berlin, wielkopolskie)).toBe(false);
  });

  it("real case: Warsaw, a real Polish city outside the Greater Poland voivodeship, is also outside this specific region", () => {
    const warsaw: [number, number] = [21.0122, 52.2297];
    expect(pointInGeometry(warsaw, wielkopolskie)).toBe(false);
  });

  it("returns false for an unrecognised geometry type rather than guessing", () => {
    expect(pointInGeometry([16.9, 52.4], { type: "Point", coordinates: [16.9, 52.4] })).toBe(false);
  });
});
