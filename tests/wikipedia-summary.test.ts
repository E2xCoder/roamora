import { describe, expect, it } from "vitest";
import { selectNamedPage } from "@/server/providers/research/wikipedia-summary";
import type { WikiPage } from "@/server/providers/wikipedia-client";

function page(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    pageid: 1,
    title: "Test Page",
    extract: "A real extracted summary.",
    coordinates: [{ lat: 50.09, lon: 14.42 }],
    ...overrides,
  };
}

describe("selectNamedPage", () => {
  it(
    "real regression: a bar with no Wikipedia page of its own must not receive a nearby " +
      "museum's description just because geosearch returned it as the closest article",
    () => {
      // Kenton's New York Bar has no Wikipedia article; the Jewish Museum
      // does and happened to be the nearest geosearch hit within 300m —
      // the old fallback attached the museum's text to the bar.
      const geosearchResults = [page({ title: "Jewish Museum in Prague", extract: "Established in 1906..." })];
      expect(selectNamedPage(geosearchResults, "Kenton's New York Bar")).toBeNull();
    }
  );

  it("returns null (never a guess) when no candidate page's title relates to the place name at all", () => {
    const geosearchResults = [
      page({ title: "Franciscan Garden" }),
      page({ title: "Reduta Jazz Club" }),
    ];
    expect(selectNamedPage(geosearchResults, "Louvre")).toBeNull();
  });

  it("selects the page whose title actually names the place", () => {
    const geosearchResults = [
      page({ title: "Some Unrelated Cafe" }),
      page({ title: "Prague Castle", extract: "A castle complex..." }),
    ];
    const chosen = selectNamedPage(geosearchResults, "Prague Castle");
    expect(chosen?.title).toBe("Prague Castle");
  });

  it("matches a loosely-qualified title against a bare place name (real, legitimate case)", () => {
    const geosearchResults = [page({ title: "Mürren, Switzerland" })];
    expect(selectNamedPage(geosearchResults, "Mürren")?.title).toBe("Mürren, Switzerland");
  });
});
