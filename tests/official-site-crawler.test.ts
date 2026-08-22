import { describe, expect, it } from "vitest";
import {
  extractSameDomainLinks,
  scoreLinkForFactType,
  parseRobotsDisallow,
  isPathAllowed,
} from "@/server/services/official-site-crawler";

describe("extractSameDomainLinks", () => {
  it("resolves relative links against the base URL", () => {
    const html = `<a href="/visit/opening-hours">Hours</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([
      "https://example.com/visit/opening-hours",
    ]);
  });

  it("keeps only links on the same hostname", () => {
    const html = `<a href="https://example.com/hours">Hours</a><a href="https://other.com/hours">Other</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual(["https://example.com/hours"]);
  });

  it("deduplicates identical resolved URLs", () => {
    const html = `<a href="/menu">Menu</a><a href="/menu">Menu again</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual(["https://example.com/menu"]);
  });

  it("strips the fragment when deduplicating (same page, different anchor)", () => {
    const html = `<a href="/menu#top">Menu</a><a href="/menu#bottom">Menu again</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual(["https://example.com/menu"]);
  });

  it("ignores mailto:, tel:, and javascript: links", () => {
    const html = `<a href="mailto:info@example.com">Email</a><a href="tel:+123">Call</a><a href="javascript:void(0)">JS</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([]);
  });

  it("returns nothing for an invalid base URL", () => {
    expect(extractSameDomainLinks(`<a href="/x">x</a>`, "not a url")).toEqual([]);
  });

  it("does not throw on a genuinely unparseable href, and still returns the valid links around it", () => {
    const html = `<a href="/ok">ok</a><a href="http://[not-a-valid-host">bad</a><a href="/also-ok">also ok</a>`;
    expect(() => extractSameDomainLinks(html, "https://example.com/")).not.toThrow();
    const result = extractSameDomainLinks(html, "https://example.com/");
    expect(result).toContain("https://example.com/ok");
    expect(result).toContain("https://example.com/also-ok");
  });
});

describe("scoreLinkForFactType", () => {
  it("scores a hours-path URL for the 'hours' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/plan-your-visit", "hours")).toBeGreaterThan(0);
  });

  it("scores a Polish ticket-price path for the 'price' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/cennik", "price")).toBeGreaterThan(0);
  });

  it("scores a German menu path for the 'menu' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/speisekarte", "menu")).toBeGreaterThan(0);
  });

  it("scores an events/calendar path for the 'event' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/whats-on", "event")).toBeGreaterThan(0);
  });

  it("returns 0 for a path with no relevant keyword", () => {
    expect(scoreLinkForFactType("https://example.com/about-us", "hours")).toBe(0);
  });

  it("does not cross-match an unrelated fact type's keywords", () => {
    expect(scoreLinkForFactType("https://example.com/tickets", "menu")).toBe(0);
  });

  it("returns 0 for a malformed URL rather than throwing", () => {
    expect(scoreLinkForFactType("not a url", "hours")).toBe(0);
  });
});

describe("parseRobotsDisallow", () => {
  it("extracts Disallow rules from the wildcard user-agent block", () => {
    const robots = "User-agent: *\nDisallow: /admin\nDisallow: /private\n";
    expect(parseRobotsDisallow(robots)).toEqual(["/admin", "/private"]);
  });

  it("ignores rules under a non-wildcard user-agent block", () => {
    const robots = "User-agent: Googlebot\nDisallow: /google-only\nUser-agent: *\nDisallow: /all\n";
    expect(parseRobotsDisallow(robots)).toEqual(["/all"]);
  });

  it("returns an empty array for a robots.txt with no wildcard block", () => {
    const robots = "User-agent: Googlebot\nDisallow: /x\n";
    expect(parseRobotsDisallow(robots)).toEqual([]);
  });

  it("ignores an empty Disallow value (means 'allow everything')", () => {
    const robots = "User-agent: *\nDisallow:\n";
    expect(parseRobotsDisallow(robots)).toEqual([]);
  });
});

describe("isPathAllowed", () => {
  it("allows a path with no matching disallow rule", () => {
    expect(isPathAllowed("/visit/hours", ["/admin"])).toBe(true);
  });

  it("rejects a path matching a disallow prefix", () => {
    expect(isPathAllowed("/admin/settings", ["/admin"])).toBe(false);
  });

  it("allows everything when there are no rules at all", () => {
    expect(isPathAllowed("/anything", [])).toBe(true);
  });
});
