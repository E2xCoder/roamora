import "server-only";
import { fetchTextCapped } from "@/server/services/url-safety";
import { getCached } from "@/server/services/research-cache";

/**
 * Bounded, safe official-site crawler (spec §Priority-4, "Official Site
 * Crawling"). Given a place's own official homepage, finds the specific
 * page most likely to answer one specific question (hours / tickets / menu
 * / events) — never a whole-site crawl. Same-domain restriction, URL
 * dedup, a hard page limit, a single-hop depth limit (links found ON a
 * fact-candidate page are never themselves followed), a robots.txt check,
 * and a cached result so the same domain's link structure is not
 * rediscovered on every autoplan run.
 *
 * Deliberately separate from fact EXTRACTION: this module only resolves
 * *which URL* is worth fetching. The existing extractors/guards
 * (fact-extraction.ts, restaurant-extraction.ts, opening-hours-guard.ts,
 * price-guard.ts, event-extraction.ts) are unchanged and still do the
 * actual reading — this module just gets them a better page to read.
 */

export type FactPageType = "hours" | "price" | "menu" | "event";

/** Path-keyword vocabulary, exactly as specified — checked against the URL path, not fuzzy-matched. */
const FACT_PATH_KEYWORDS: Record<FactPageType, string[]> = {
  hours: ["opening-hours", "openinghours", "hours", "visit", "visiting", "plan-your-visit", "planyourvisit"],
  price: ["tickets", "admission", "prices", "cennik", "bilety", "entrance", "pricing"],
  menu: ["menu", "menus", "speisekarte", "karta", "food"],
  event: ["events", "calendar", "program", "agenda", "whats-on", "wydarzenia"],
};

const PAGE_LIMIT = 3; // real bound on how many candidate pages are ever fetched per resolution
const NAMESPACE = "official-fact-page";
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — a site's link structure changes far less often than its content
const ROBOTS_NAMESPACE = "robots-txt";
const ROBOTS_TTL_MS = 1000 * 60 * 60 * 24; // 1 day

/**
 * Decodes numeric HTML character references (`&#58;`, `&#x3A;`) and the
 * handful of named entities that show up in an href attribute. Real,
 * live-observed case: some site themes emit `href="http&#x3A;&#x2F;&#x2F;
 * example.com&#x2F;menu"` — a legitimate, if unusual, real-world pattern,
 * not malformed markup — which `new URL()` cannot parse at all until the
 * entities are decoded back to `:` and `/` first.
 */
function decodeHrefEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, "&");
}

/**
 * Extracts absolute, same-domain, deduplicated link URLs from a page's raw
 * HTML. Deliberately a lightweight regex scan rather than a full DOM parser
 * — this project has no HTML-parsing dependency, and a fact-specific link's
 * href is a plain attribute value, not something that needs real DOM
 * semantics to find.
 */
export function extractSameDomainLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const hrefRe = /<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi;
  const seen = new Set<string>();
  const out: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = decodeHrefEntities(match[1].trim());
    if (!raw || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue; // same-domain restriction

    resolved.hash = "";
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

/** How strongly a URL's path matches the given fact type's keyword vocabulary — 0 means no match at all. */
export function scoreLinkForFactType(url: string, factType: FactPageType): number {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 0;
  }
  const keywords = FACT_PATH_KEYWORDS[factType];
  return keywords.reduce((score, kw) => (path.includes(kw) ? score + 1 : score), 0);
}

/** Parses the `User-agent: *` block's `Disallow` rules from a robots.txt body — a minimal, real safety check, not a full robots.txt implementation. */
export function parseRobotsDisallow(robotsTxt: string): string[] {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.trim());
  const rules: string[] = [];
  let inWildcardBlock = false;

  for (const line of lines) {
    if (/^user-agent\s*:/i.test(line)) {
      inWildcardBlock = /^user-agent\s*:\s*\*/i.test(line);
      continue;
    }
    if (!inWildcardBlock) continue;
    const m = line.match(/^disallow\s*:\s*(\S*)/i);
    if (m && m[1]) rules.push(m[1]);
  }
  return rules;
}

/** True when no Disallow rule (from the wildcard User-agent block) is a prefix of the given path. */
export function isPathAllowed(path: string, disallowRules: string[]): boolean {
  return !disallowRules.some((rule) => rule !== "" && path.startsWith(rule));
}

async function robotsDisallowFor(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const result = await getCached(ROBOTS_NAMESPACE, origin, ROBOTS_TTL_MS, async () => {
    try {
      const fetched = await fetchTextCapped(`${origin}/robots.txt`);
      if (!fetched.ok) return [];
      return parseRobotsDisallow(fetched.text);
    } catch {
      return [];
    }
  });
  return result ?? [];
}

/**
 * Resolves the single best URL on `officialUrl`'s own domain for a given
 * fact type — the homepage itself, a fact-specific page found via a link on
 * it, or null if the homepage itself could not be fetched at all. Bounded:
 * fetches the homepage once, then at most `PAGE_LIMIT` candidate links,
 * stopping at the first one that actually resolves; never follows a link
 * found on one of those candidate pages (single-hop depth limit).
 */
export async function resolveFactPageUrl(officialUrl: string, factType: FactPageType): Promise<string | null> {
  const key = `${officialUrl}|${factType}`;
  return getCached(NAMESPACE, key, TTL_MS, async () => {
    const robotsDisallow = await robotsDisallowFor(officialUrl);

    let homepageUrl: URL;
    try {
      homepageUrl = new URL(officialUrl);
    } catch {
      return null;
    }
    if (!isPathAllowed(homepageUrl.pathname, robotsDisallow)) return null;

    let homepage = await fetchTextCapped(officialUrl);
    let effectiveHomepageUrl = officialUrl;
    if (!homepage.ok && homepageUrl.pathname !== "/" && homepageUrl.pathname !== "") {
      // Live-observed real case: Wikidata's stored official-website value can
      // be a specific deep page that has since moved or been removed (a real
      // 404) even though the domain itself is very much alive — falling back
      // to the site's own root before giving up entirely turns a stale
      // Wikidata link into a still-useful starting point for the crawl.
      const root = homepageUrl.origin + "/";
      const rootFetch = await fetchTextCapped(root);
      if (rootFetch.ok) {
        homepage = rootFetch;
        effectiveHomepageUrl = root;
      }
    }
    if (!homepage.ok) return null;

    const candidates = extractSameDomainLinks(homepage.text, effectiveHomepageUrl)
      .filter((link) => {
        try {
          return isPathAllowed(new URL(link).pathname, robotsDisallow);
        } catch {
          return false;
        }
      })
      .map((link) => ({ link, score: scoreLinkForFactType(link, factType) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PAGE_LIMIT);

    for (const { link } of candidates) {
      try {
        const fetched = await fetchTextCapped(link);
        if (fetched.ok && fetched.text.trim().length > 200) return link; // stop once a real page is found
      } catch {
        continue;
      }
    }

    // No dedicated fact page found — the (possibly root-fallback) homepage
    // itself is still a real, same-domain, already-fetched official source,
    // cheaper than falling straight to a search-engine query.
    return effectiveHomepageUrl;
  });
}

export interface FetchedFactPage {
  url: string;
  text: string;
}

/** Resolves (cached) then fetches (always live — a fact page's content changes far more often than its URL). */
export async function fetchFactPage(officialUrl: string, factType: FactPageType): Promise<FetchedFactPage | null> {
  const pageUrl = await resolveFactPageUrl(officialUrl, factType);
  if (!pageUrl) return null;
  const fetched = await fetchTextCapped(pageUrl);
  if (!fetched.ok) return null;
  return { url: pageUrl, text: fetched.text };
}
