import { describe, expect, it } from "vitest";
import { extractNameVariants } from "@/server/services/geocode";

/**
 * Real Nominatim `namedetails` responses (fetched live this session,
 * https://nominatim.openstreetmap.org/search?...&namedetails=1) — the
 * general, non-hardcoded endonym/exonym data source this feature relies on.
 */
describe("extractNameVariants", () => {
  it('real case: "Prague" query resolves to the local "Praha" plus the English "Prague"', () => {
    expect(extractNameVariants({ name: "Praha", "name:en": "Prague", "name:cs": "Praha", "name:de": "Prag" })).toEqual([
      "Praha",
      "Prague",
    ]);
  });

  it('real case: "Vienna" query resolves to the local "Wien" plus the English "Vienna"', () => {
    expect(extractNameVariants({ name: "Wien", "name:en": "Vienna", "name:de": "Wien" })).toEqual(["Wien", "Vienna"]);
  });

  it('real case: "Cologne" query resolves to the local "Köln" plus the English "Cologne"', () => {
    expect(extractNameVariants({ name: "Köln", "name:en": "Cologne", "name:de": "Köln" })).toEqual(["Köln", "Cologne"]);
  });

  it('real case: "Munich" query resolves to the local "München" plus the English "Munich"', () => {
    expect(extractNameVariants({ name: "München", "name:en": "Munich", "name:de": "München" })).toEqual([
      "München",
      "Munich",
    ]);
  });

  it("deduplicates when the local name and the English name are identical (e.g. an English-speaking destination)", () => {
    expect(extractNameVariants({ name: "London", "name:en": "London" })).toEqual(["London"]);
  });

  it("returns an empty array when namedetails is missing or empty", () => {
    expect(extractNameVariants(undefined)).toEqual([]);
    expect(extractNameVariants({})).toEqual([]);
  });

  it("returns just the local name when Nominatim has no name:en for a place", () => {
    expect(extractNameVariants({ name: "Poznań", "name:pl": "Poznań" })).toEqual(["Poznań"]);
  });
});
