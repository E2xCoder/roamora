import { describe, expect, it } from "vitest";
import {
  placeQuerySchema,
  createPlaceSchema,
  updatePlaceSchema,
  routeRequestSchema,
  importUrlSchema,
} from "@/server/schemas";

describe("placeQuerySchema", () => {
  it("defaults to the personal pool so the reference corpus is opt-in", () => {
    const r = placeQuerySchema.parse({});
    expect(r.pool).toBe("personal");
  });

  it("coerces numeric strings from the query string", () => {
    const r = placeQuerySchema.parse({ limit: "250" });
    expect(r.limit).toBe(250);
  });

  it("caps the page size", () => {
    expect(placeQuerySchema.safeParse({ limit: "99999" }).success).toBe(false);
  });

  it("rejects out-of-range bounding boxes", () => {
    expect(placeQuerySchema.safeParse({ north: 91 }).success).toBe(false);
    expect(placeQuerySchema.safeParse({ west: -181 }).success).toBe(false);
  });

  it("coerces bounding-box edges arriving as query strings", () => {
    // Search params are always strings; without coercion every bbox map
    // request failed validation.
    const r = placeQuerySchema.parse({
      south: "49.9",
      north: "50.2",
      west: "14.2",
      east: "14.6",
    });
    expect(r.south).toBe(49.9);
    expect(r.north).toBe(50.2);
    expect(r.west).toBe(14.2);
    expect(r.east).toBe(14.6);
  });

  it("still range-checks coerced strings", () => {
    expect(placeQuerySchema.safeParse({ north: "91" }).success).toBe(false);
  });

  it("rejects an unknown pool", () => {
    expect(placeQuerySchema.safeParse({ pool: "everything" }).success).toBe(false);
  });
});

describe("createPlaceSchema", () => {
  const valid = { name: "Letná Park", lat: 50.0955, lng: 14.4166 };

  it("accepts a minimal place and applies defaults", () => {
    const r = createPlaceSchema.parse(valid);
    expect(r.category).toBe("other");
    expect(r.sourceType).toBe("MANUAL");
    expect(r.tags).toEqual([]);
    expect(r.isHiddenGem).toBe(false);
  });

  it("rejects impossible coordinates", () => {
    expect(createPlaceSchema.safeParse({ ...valid, lat: 91 }).success).toBe(false);
    expect(createPlaceSchema.safeParse({ ...valid, lng: 181 }).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(createPlaceSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects an unknown sourceType so provenance stays meaningful", () => {
    expect(
      createPlaceSchema.safeParse({ ...valid, sourceType: "INVENTED" }).success
    ).toBe(false);
  });

  it("bounds confidence to 0..1", () => {
    expect(
      createPlaceSchema.safeParse({ ...valid, locationConfidence: 1.5 }).success
    ).toBe(false);
    expect(
      createPlaceSchema.safeParse({ ...valid, locationConfidence: 0.9 }).success
    ).toBe(true);
  });
});

describe("updatePlaceSchema", () => {
  it("does not materialise fields the caller omitted", () => {
    // Regression: this was built with createPlaceSchema.partial(), which keeps
    // the defaults. Patching only `notes` silently rewrote category, tags,
    // source and sourceType — moving REFERENCE rows into the personal pool.
    const r = updatePlaceSchema.parse({ notes: "sunset spot" });
    expect(Object.keys(r)).toEqual(["notes"]);
    expect(r).not.toHaveProperty("category");
    expect(r).not.toHaveProperty("categoryId");
    expect(r).not.toHaveProperty("sourceType");
    expect(r).not.toHaveProperty("source");
    expect(r).not.toHaveProperty("tags");
    expect(r).not.toHaveProperty("isHiddenGem");
  });

  it("accepts an empty patch without inventing anything", () => {
    expect(Object.keys(updatePlaceSchema.parse({}))).toEqual([]);
  });

  it("still validates the fields that are supplied", () => {
    expect(updatePlaceSchema.safeParse({ lat: 999 }).success).toBe(false);
    expect(updatePlaceSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(updatePlaceSchema.safeParse({ sourceType: "NOPE" }).success).toBe(false);
    expect(updatePlaceSchema.safeParse({ locationConfidence: 2 }).success).toBe(false);
  });

  it("passes through an explicit value unchanged", () => {
    const r = updatePlaceSchema.parse({ sourceType: "PERSONAL" });
    expect(r.sourceType).toBe("PERSONAL");
  });
});

describe("routeRequestSchema", () => {
  const wp = [
    { lat: 50.087, lng: 14.4207 },
    { lat: 50.0865, lng: 14.4114 },
  ];

  it("defaults to walking", () => {
    expect(routeRequestSchema.parse({ waypoints: wp }).profile).toBe("foot");
  });

  it("requires at least two waypoints", () => {
    expect(routeRequestSchema.safeParse({ waypoints: [wp[0]] }).success).toBe(false);
  });

  it("caps the waypoint count", () => {
    const many = Array.from({ length: 26 }, () => wp[0]);
    expect(routeRequestSchema.safeParse({ waypoints: many }).success).toBe(false);
  });

  it("rejects an unsupported profile", () => {
    expect(
      routeRequestSchema.safeParse({ waypoints: wp, profile: "teleport" }).success
    ).toBe(false);
  });
});

describe("importUrlSchema", () => {
  it("accepts a real URL", () => {
    expect(
      importUrlSchema.safeParse({ url: "https://www.tiktok.com/@a/video/123" })
        .success
    ).toBe(true);
  });

  it("rejects a non-URL string", () => {
    expect(importUrlSchema.safeParse({ url: "prague castle" }).success).toBe(false);
  });
});
