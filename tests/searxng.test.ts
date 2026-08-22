import { describe, expect, it } from "vitest";
import { normalizeUrl, toResults } from "@/server/providers/research/searxng";

describe("normalizeUrl", () => {
  it("treats a trailing slash as equivalent to no trailing slash", () => {
    expect(normalizeUrl("https://example.com/page/")).toBe(normalizeUrl("https://example.com/page"));
  });

  it("treats http and https as the same normalized identity", () => {
    expect(normalizeUrl("http://example.com/page")).toBe(normalizeUrl("https://example.com/page"));
  });

  it("is case-insensitive on the hostname", () => {
    expect(normalizeUrl("https://Example.COM/page")).toBe(normalizeUrl("https://example.com/page"));
  });

  it("preserves query strings, which represent genuinely distinct pages", () => {
    expect(normalizeUrl("https://example.com/search?q=a")).not.toBe(normalizeUrl("https://example.com/search?q=b"));
  });
});

describe("toResults", () => {
  it(
    "parses the real SearXNG response shape observed live (top-level query/results/unresponsive_engines, " +
      "per-result engine/engines/score fields)",
    () => {
      const real = {
        query: "test",
        results: [
          {
            url: "https://www.speedtest.net/",
            title: "Speedtest by Ookla",
            content: "Test your internet speed...",
            engine: "bing",
            engines: ["brave", "qwant", "bing"],
            score: 9,
          },
        ],
        unresponsive_engines: [
          ["duckduckgo", "CAPTCHA"],
          ["google cse", "too many requests"],
        ] as Array<[string, string]>,
      };
      const results = toResults(real, 6);
      expect(results).toEqual([
        { title: "Speedtest by Ookla", url: "https://www.speedtest.net/", snippet: "Test your internet speed...", score: 9, engineAgreement: 3 },
      ]);
    }
  );

  it("skips a result missing a title or url rather than producing a broken entry", () => {
    const data = { results: [{ url: "https://a.example/" }, { title: "No URL" }, { title: "Good", url: "https://b.example/", content: "" }] };
    expect(toResults(data, 6)).toEqual([{ title: "Good", url: "https://b.example/", snippet: "", score: undefined, engineAgreement: undefined }]);
  });

  it("de-duplicates results that normalize to the same URL", () => {
    const data = {
      results: [
        { title: "First", url: "https://example.com/page", content: "" },
        { title: "Duplicate (trailing slash + http)", url: "http://example.com/page/", content: "" },
      ],
    };
    expect(toResults(data, 6)).toHaveLength(1);
  });

  it("respects the limit", () => {
    const data = {
      results: Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`, url: `https://example.com/${i}`, content: "" })),
    };
    expect(toResults(data, 3)).toHaveLength(3);
  });

  it("returns an empty array for no results", () => {
    expect(toResults({}, 6)).toEqual([]);
  });
});
