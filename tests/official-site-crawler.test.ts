import { describe, expect, it } from "vitest";
import {
  extractSameDomainLinks,
  scoreLinkForFactType,
  parseRobotsDisallow,
  isPathAllowed,
  checkPageContent,
  pageRelatesToPlace,
} from "@/server/services/official-site-crawler";

function link(url: string, text = "") {
  return { url, text };
}

describe("extractSameDomainLinks", () => {
  it("resolves relative links against the base URL", () => {
    const html = `<a href="/visit/opening-hours">Hours</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([
      link("https://example.com/visit/opening-hours", "Hours"),
    ]);
  });

  it("keeps only links on the same hostname", () => {
    const html = `<a href="https://example.com/hours">Hours</a><a href="https://other.com/hours">Other</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([link("https://example.com/hours", "Hours")]);
  });

  it("deduplicates identical resolved URLs to one entry, merging their distinct anchor text", () => {
    const html = `<a href="/menu">Menu</a><a href="/menu">Menu again</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([
      link("https://example.com/menu", "Menu Menu again"),
    ]);
  });

  it("strips the fragment when deduplicating (same page, different anchor), merging distinct anchor text", () => {
    const html = `<a href="/menu#top">Menu</a><a href="/menu#bottom">Menu again</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([
      link("https://example.com/menu", "Menu Menu again"),
    ]);
  });

  it("ignores mailto:, tel:, and javascript: links", () => {
    const html = `<a href="mailto:info@example.com">Email</a><a href="tel:+123">Call</a><a href="javascript:void(0)">JS</a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([]);
  });

  it("returns nothing for an invalid base URL", () => {
    expect(extractSameDomainLinks(`<a href="/x">x</a>`, "not a url")).toEqual([]);
  });

  it(
    "real case: decodes HTML-entity-encoded hrefs (wirtshaus-enzian.de's real theme emits " +
      "href=\"http&#x3A;&#x2F;&#x2F;...&#x2F;speisekarte\") — new URL() cannot parse the raw " +
      "encoded form at all, so this link was silently dropped before the fix",
    () => {
      const html = `<a href="http&#x3A;&#x2F;&#x2F;www.example.de&#x2F;speisekarte">Speisekarte</a>`;
      expect(extractSameDomainLinks(html, "http://www.example.de/")).toEqual([
        link("http://www.example.de/speisekarte", "Speisekarte"),
      ]);
    }
  );

  it("decodes decimal numeric character references too", () => {
    const html = `<a href="&#104;&#116;&#116;&#112;&#58;&#47;&#47;example.com&#47;menu">Menu</a>`;
    expect(extractSameDomainLinks(html, "http://example.com/")).toEqual([link("http://example.com/menu", "Menu")]);
  });

  it("does not throw on a genuinely unparseable href, and still returns the valid links around it", () => {
    const html = `<a href="/ok">ok</a><a href="http://[not-a-valid-host">bad</a><a href="/also-ok">also ok</a>`;
    expect(() => extractSameDomainLinks(html, "https://example.com/")).not.toThrow();
    const result = extractSameDomainLinks(html, "https://example.com/");
    expect(result.map((l) => l.url)).toContain("https://example.com/ok");
    expect(result.map((l) => l.url)).toContain("https://example.com/also-ok");
  });

  it(
    "real case: captures the anchor's own visible text alongside its URL (ngprague.cz's real " +
      'nav has a link to "/o-nas/budovy" with visible text "Budovy a otevírací doba" — the URL ' +
      "slug alone carries no hours signal at all)",
    () => {
      const html = `<a href="/o-nas/budovy">Budovy a otevírací doba</a>`;
      expect(extractSameDomainLinks(html, "https://www.ngprague.cz/")).toEqual([
        link("https://www.ngprague.cz/o-nas/budovy", "Budovy a otevírací doba"),
      ]);
    }
  );

  it("strips nested markup from the anchor text and collapses whitespace", () => {
    const html = `<a href="/hours">  Opening\n<span>Hours</span>  </a>`;
    expect(extractSameDomainLinks(html, "https://example.com/")).toEqual([
      link("https://example.com/hours", "Opening Hours"),
    ]);
  });

  it(
    "real regression: merges anchor text from multiple links that share the same base URL but " +
      "different #fragments, instead of discarding all but the first — real case: " +
      'museumkampa.cz has FOUR real links all resolving to "/navsteva/" once the fragment is ' +
      'stripped for fetching ("#oteviraci-doba", "#vstupne", "#adresa", "#kontakty"), each with ' +
      "genuinely different anchor text; keeping only the first discarded the word (\"vstupné\") " +
      "this page's real admission price is actually found by",
    () => {
      const html =
        `<a href="/navsteva/#oteviraci-doba">otevírací doba</a>` +
        `<a href="/navsteva/#vstupne">vstupné</a>` +
        `<a href="/navsteva/#adresa">adresa</a>`;
      const result = extractSameDomainLinks(html, "https://www.museumkampa.cz/");
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe("https://www.museumkampa.cz/navsteva/");
      expect(result[0].text).toBe("otevírací doba vstupné adresa");
    }
  );

  it("does not duplicate identical text when merging (e.g. the same link repeated verbatim)", () => {
    const html = `<a href="/menu#top">Menu</a><a href="/menu#bottom">Menu</a>`;
    const result = extractSameDomainLinks(html, "https://example.com/");
    expect(result).toEqual([link("https://example.com/menu", "Menu")]);
  });

  it("preserves the FIRST-seen URL's position in the output order, even after later merges", () => {
    const html = `<a href="/a#1">first</a><a href="/b">second</a><a href="/a#2">merged</a>`;
    const result = extractSameDomainLinks(html, "https://example.com/");
    expect(result.map((l) => l.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result[0].text).toBe("first merged");
  });
});

describe("scoreLinkForFactType", () => {
  it("scores a hours-path URL for the 'hours' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/plan-your-visit", "", "hours")).toBeGreaterThan(0);
  });

  it("scores a Polish ticket-price path for the 'price' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/cennik", "", "price")).toBeGreaterThan(0);
  });

  it("scores a German menu path for the 'menu' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/speisekarte", "", "menu")).toBeGreaterThan(0);
  });

  it("scores an events/calendar path for the 'event' fact type", () => {
    expect(scoreLinkForFactType("https://example.com/whats-on", "", "event")).toBeGreaterThan(0);
  });

  it("returns 0 for a path with no relevant keyword", () => {
    expect(scoreLinkForFactType("https://example.com/about-us", "", "hours")).toBe(0);
  });

  it("does not cross-match an unrelated fact type's keywords", () => {
    expect(scoreLinkForFactType("https://example.com/tickets", "", "menu")).toBe(0);
  });

  it("returns 0 for a malformed URL rather than throwing", () => {
    expect(scoreLinkForFactType("not a url", "", "hours")).toBe(0);
  });

  it(
    "real case: scores a link by its VISIBLE TEXT when the URL slug itself carries no signal " +
      '(ngprague.cz: URL "/o-nas/budovy" has no hours keyword at all; its real link text ' +
      '"Budovy a otevírací doba" does)',
    () => {
      expect(scoreLinkForFactType("https://www.ngprague.cz/o-nas/budovy", "Budovy a otevírací doba", "hours")).toBeGreaterThan(0);
      expect(scoreLinkForFactType("https://www.ngprague.cz/o-nas/budovy", "", "hours")).toBe(0);
    }
  );

  it(
    "real case: matches a Czech URL slug for 'hours' (nm.cz's real nav: " +
      '"/navstivte-nas/oteviraci-doba")',
    () => {
      expect(scoreLinkForFactType("https://www.nm.cz/navstivte-nas/oteviraci-doba", "", "hours")).toBeGreaterThan(0);
    }
  );

  it(
    "real case: matches accented Czech link text for 'hours', diacritic-insensitively " +
      '(muzeumkarlazemana.cz\'s real hours link text is "Otevírací doba" on a URL with no ' +
      "matching slug at all)",
    () => {
      expect(
        scoreLinkForFactType("https://muzeumkarlazemana.cz/kontakt-vstupne", "Otevírací doba", "hours")
      ).toBeGreaterThan(0);
    }
  );

  it(
    "real case: matches a Czech ticket-price term (muzeumprahy.cz's real link text is " +
      '"Koupit vstupenku"; nm.cz\'s real URL slug is "/navstivte-nas/vstupenky")',
    () => {
      expect(scoreLinkForFactType("https://eshop.example.cz/koupit", "Koupit vstupenku", "price")).toBeGreaterThan(0);
      expect(scoreLinkForFactType("https://www.nm.cz/navstivte-nas/vstupenky", "", "price")).toBeGreaterThan(0);
    }
  );

  it('real case: matches a Czech events term ("akce" — nm.cz\'s real URL "/navstivte-nas/program/akce")', () => {
    expect(scoreLinkForFactType("https://www.nm.cz/navstivte-nas/program/akce", "", "event")).toBeGreaterThan(0);
  });

  it("matches German 'Öffnungszeiten' for hours, diacritic-insensitively", () => {
    expect(scoreLinkForFactType("https://example.de/kontakt", "Öffnungszeiten", "hours")).toBeGreaterThan(0);
  });

  it("matches Polish 'godziny otwarcia' for hours", () => {
    expect(scoreLinkForFactType("https://example.pl/kontakt", "Godziny otwarcia", "hours")).toBeGreaterThan(0);
  });

  it("does not let a Czech hours term leak into an unrelated fact type", () => {
    expect(scoreLinkForFactType("https://www.nm.cz/navstivte-nas/oteviraci-doba", "Otevírací doba", "menu")).toBe(0);
  });

  it(
    'real case: matches the Czech admission-price term "ceník" (jewishmuseum.cz\'s real URL ' +
      '"/cenik-sluzeb/") — genuinely distinct from the Polish "cennik" already covered above',
    () => {
      expect(scoreLinkForFactType("https://www.jewishmuseum.cz/cenik-sluzeb", "", "price")).toBeGreaterThan(0);
    }
  );

  it(
    'real case: matches "ceny" in merged anchor text (museumkampa.cz\'s real merged nav text ' +
      'includes "ceny vstupného")',
    () => {
      expect(
        scoreLinkForFactType("https://www.museumkampa.cz/navsteva/", "otevírací doba vstupné ceny vstupného", "price")
      ).toBeGreaterThan(0);
    }
  );

  it(
    "real regression: excludes an e-shop/checkout page from 'price' scoring entirely, even " +
      'when its own text/URL also matches a real price keyword — real case: jewishmuseum.cz\'s ' +
      '"/e-shop/" page is labelled "VSTUPENKY" (tickets are bought there) but is a purchase ' +
      "flow, not the real admission-price information page, which lives at a completely " +
      'different URL ("/informace/.../vstupne/")',
    () => {
      expect(scoreLinkForFactType("https://www.jewishmuseum.cz/e-shop", "VSTUPENKY", "price")).toBe(0);
      expect(
        scoreLinkForFactType(
          "https://www.jewishmuseum.cz/informace/navstivte-nas-rozcestnik/vstupne/",
          "Vstupné",
          "price"
        )
      ).toBeGreaterThan(0);
    }
  );

  it("excludes other real shop/checkout URL shapes from 'price' scoring (English, generic)", () => {
    expect(scoreLinkForFactType("https://example.com/webshop/tickets", "Tickets", "price")).toBe(0);
    expect(scoreLinkForFactType("https://example.com/checkout", "Buy tickets", "price")).toBe(0);
  });

  it("does not exclude a shop-marked URL from an UNRELATED fact type (the exclusion is price-only)", () => {
    expect(scoreLinkForFactType("https://example.com/e-shop/opening-hours", "Hours", "hours")).toBeGreaterThan(0);
  });

  it("does not falsely treat an unrelated subdomain/hostname mention of 'shop' as a shop page (path-only check)", () => {
    // Real, already-existing test above: "eshop.example.cz" in the HOSTNAME must not affect
    // path-based price scoring — the exclusion only inspects the URL's pathname, not its host.
    expect(scoreLinkForFactType("https://eshop.example.cz/vstupenky", "", "price")).toBeGreaterThan(0);
  });
});

describe("pageRelatesToPlace", () => {
  it(
    "real regression: rejects a real, live-observed hijacked domain — a real Prague landmark's " +
      "OSM `website` tag resolved to a completely unrelated forex/SEO blog with zero mention of " +
      "the landmark anywhere on the page",
    () => {
      const html = `<html><head><title>My Blog - My WordPress Blog</title></head>
        <body>Best Forex SEO Agencies for Multilingual and International Markets...</body></html>`;
      expect(pageRelatesToPlace(html, "Klementinum")).toBe(false);
    }
  );

  it("accepts a real page that genuinely mentions the place", () => {
    const html = `<html><body><h1>Klementinum - Prague</h1><p>Visit the historic Klementinum complex.</p></body></html>`;
    expect(pageRelatesToPlace(html, "Klementinum")).toBe(true);
  });

  it("is diacritic-insensitive, same discipline as the rest of this module", () => {
    const html = `<html><body>Vítejte v Národním muzeu</body></html>`;
    expect(pageRelatesToPlace(html, "Národní muzeum")).toBe(true);
  });

  it("does not get fooled by the domain name alone appearing only inside stripped markup (meta/canonical tags)", () => {
    const html =
      `<html><head>` +
      `<link rel="canonical" href="https://klementinum.com/">` +
      `<meta property="og:url" content="https://klementinum.com/">` +
      `</head><body>My Blog - My WordPress Blog. Unrelated content about forex SEO agencies.</body></html>`;
    expect(pageRelatesToPlace(html, "Klementinum")).toBe(false);
  });

  it("skips the check (returns true) for a name with no token 3+ characters long", () => {
    expect(pageRelatesToPlace("<html><body>Anything</body></html>", "A B")).toBe(true);
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

describe("checkPageContent", () => {
  it(
    "flags a real, live-observed JS-rendered shell (fulumandarijn.com/menu: ~199KB of HTML, " +
      "764 real characters after stripping tags)",
    () => {
      const html = "<div>" + "x".repeat(199_000) + "</div>";
      const plainText = "a".repeat(764); // simulates htmlToPlainText's real output size for that page
      expect(checkPageContent(html.length, plainText).looksEmpty).toBe(true);
    }
  );

  it("does not flag a real, content-bearing menu page of ordinary size", () => {
    const html = "<html>" + "<p>Pierogi 25 PLN</p>".repeat(100) + "</html>";
    const plainText = "Pierogi 25 PLN ".repeat(100).trim();
    expect(checkPageContent(html.length, plainText).looksEmpty).toBe(false);
  });

  it("flags a page with too little real text even when the HTML itself is small (not just the JS-shell ratio case)", () => {
    expect(checkPageContent(300, "Page not found").looksEmpty).toBe(true);
  });

  it(
    "does not flag a real, large PDF-extracted menu (live-confirmed: Berlin's Jolly-" +
      "Speisekarte.pdf — 767KB raw, 11,918 real characters — rawLength 0 is passed for PDFs " +
      "since the HTML-shell ratio check does not apply to already-extracted text)",
    () => {
      expect(checkPageContent(0, "x".repeat(11_918)).looksEmpty).toBe(false);
    }
  );
});
