import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CATEGORY_BY_ID,
  categoryOf,
  legacyCategoryToId,
  SOURCE_TYPES,
  LOCATION_SOURCES,
  AUTO_SAVE_CONFIDENCE,
} from "@/lib/taxonomy";

describe("taxonomy", () => {
  it("has unique category ids", () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("always resolves to a category, falling back to 'other'", () => {
    expect(categoryOf("restaurant").id).toBe("restaurant");
    expect(categoryOf("does-not-exist").id).toBe("other");
    expect(categoryOf(null).id).toBe("other");
    expect(categoryOf(undefined).id).toBe("other");
  });

  it("includes an 'other' bucket so the fallback can never be undefined", () => {
    expect(CATEGORY_BY_ID.get("other")).toBeDefined();
  });

  describe("legacyCategoryToId", () => {
    it("maps every legacy value the seeded data uses", () => {
      // These are the exact values present in the migrated database.
      const seeded = [
        "attraction",
        "restaurant",
        "accommodation",
        "other",
        "cafe",
        "shopping",
      ];
      for (const legacy of seeded) {
        const id = legacyCategoryToId(legacy);
        expect(CATEGORY_BY_ID.has(id)).toBe(true);
      }
    });

    it("renames 'hiking' to the taxonomy's 'hike'", () => {
      expect(legacyCategoryToId("hiking")).toBe("hike");
    });

    it("is case-insensitive", () => {
      expect(legacyCategoryToId("Restaurant")).toBe("restaurant");
      expect(legacyCategoryToId("CAFE")).toBe("cafe");
    });

    it("falls back to 'other' for unknown or empty input", () => {
      expect(legacyCategoryToId("nonsense")).toBe("other");
      expect(legacyCategoryToId("")).toBe("other");
      expect(legacyCategoryToId(null)).toBe("other");
    });

    it("only ever returns ids that exist in the taxonomy", () => {
      const samples = ["restaurant", "hiking", "hidden-gem", "???", ""];
      for (const s of samples) {
        expect(CATEGORY_BY_ID.has(legacyCategoryToId(s))).toBe(true);
      }
    });
  });

  describe("provenance vocabularies", () => {
    it("separates personal knowledge from the reference corpus", () => {
      expect(SOURCE_TYPES).toContain("PERSONAL");
      expect(SOURCE_TYPES).toContain("REFERENCE");
    });

    it("can express that a coordinate came from the geocoder rather than AI", () => {
      expect(LOCATION_SOURCES).toContain("GEOCODER");
      expect(LOCATION_SOURCES).toContain("AI");
      expect(LOCATION_SOURCES).toContain("MANUAL");
    });
  });

  it("sets an auto-save threshold below 1 so confirmation is possible", () => {
    expect(AUTO_SAVE_CONFIDENCE).toBeGreaterThan(0);
    expect(AUTO_SAVE_CONFIDENCE).toBeLessThan(1);
  });
});
