import "server-only";
import { fetchTextCapped, fetchTextOrPdfCapped } from "@/server/services/url-safety";
import { getCached } from "@/server/services/research-cache";
import { htmlToPlainText } from "@/server/services/fact-extraction";

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

/**
 * Keyword vocabulary, checked (diacritic-insensitive, see normalizeForMatch)
 * against BOTH a candidate link's URL path AND its real anchor text — a
 * plain keyword substring match, never fuzzy. Grouped by fact type, then by
 * language within each, each language block added only where a real Prague
 * site this session actually used it justified it (never a speculative
 * "might as well cover every language" addition):
 *
 * Czech — this project's primary real-data testbed (Prague). Real,
 * live-observed terms: nm.cz's own nav is literally
 * "/navstivte-nas/oteviraci-doba" (Otevírací doba = opening hours),
 * "/navstivte-nas/vstupenky" (tickets), "/navstivte-nas/program/akce"
 * (events); muzeumkarlazemana.cz's hours link text is "Otevírací doba" with
 * no matching URL slug at all — text-matching, not just the URL, is what
 * finds it. "Otevírací doba"'s ACCENTED form is what real anchor text
 * looks like; normalizeForMatch strips the accents before comparing, so the
 * keyword list only needs the one plain-ASCII spelling.
 *
 * German/Polish — already-evidenced from this project's prior Berlin/
 * Poznań real-data sessions (see git history); extended for `hours`
 * specifically, since that category previously had zero non-English
 * coverage at all while price/menu/event already had some.
 */
const FACT_PATH_KEYWORDS: Record<FactPageType, string[]> = {
  hours: [
    "opening-hours", "openinghours", "hours", "visit", "visiting", "plan-your-visit", "planyourvisit",
    "oteviraci doba", "oteviraci-doba", "oteviraci hodiny", "navstevni doba", "navstivte-nas", "navstivte nas",
    "offnungszeiten", "oeffnungszeiten", "besuch",
    "godziny otwarcia", "godziny-otwarcia",
  ],
  price: [
    "tickets", "admission", "prices", "cennik", "bilety", "entrance", "pricing",
    "vstupne", "vstupenka", "vstupenky", "vstupenku",
  ],
  menu: ["menu", "menus", "speisekarte", "karta", "food"],
  event: [
    "events", "calendar", "program", "agenda", "whats-on", "wydarzenia",
    "akce",
  ],
};

/**
 * Diacritic-insensitive lowercase, same normalization discipline this
 * codebase already applies elsewhere (confidence.ts, wikipedia-client.ts).
 * A URL path is conventionally plain ASCII ("oteviraci-doba") while real
 * anchor text keeps its native accents ("Otevírací doba") — normalizing
 * both sides to the same accent-free form lets one plain-ASCII keyword
 * list match either spelling, instead of listing every accented variant.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

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

export interface SameDomainLink {
  url: string;
  /** The anchor's own visible text, collapsed to plain whitespace-separated text — real, live-observed need: several real sites (e.g. ngprague.cz's "/o-nas/budovy" linking text "Budovy a otevírací doba") carry their only hours/price/event signal in the link's TEXT, not its URL slug at all. */
  text: string;
}

/**
 * Extracts absolute, same-domain, deduplicated links (URL + visible text)
 * from a page's raw HTML. Deliberately a lightweight regex scan rather than
 * a full DOM parser — this project has no HTML-parsing dependency, and a
 * fact-specific link's href/text is plain markup, not something that needs
 * real DOM semantics to find.
 */
export function extractSameDomainLinks(html: string, baseUrl: string): SameDomainLink[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const hrefRe = /<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const out: SameDomainLink[] = [];

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
    const text = decodeHrefEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ url: normalized, text });
  }

  return out;
}

/** How strongly a link's URL path AND visible text match the given fact type's keyword vocabulary — 0 means no match at all. Diacritic-insensitive (see normalizeForMatch); a plain substring match, never fuzzy. */
export function scoreLinkForFactType(url: string, linkText: string, factType: FactPageType): number {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 0;
  }
  const haystack = normalizeForMatch(`${path} ${linkText}`);
  const keywords = FACT_PATH_KEYWORDS[factType];
  return keywords.reduce((score, kw) => (haystack.includes(kw) ? score + 1 : score), 0);
}

// A real, content-bearing fact page has meaningfully more extractable text
// than a boilerplate nav/footer shell. Checked against REAL plain text, not
// raw HTML byte length — the bug this replaces (`fetched.text.trim().length
// > 200`, checking raw markup) always passed for a JS-rendered page, since
// its raw HTML is typically large even when almost none of it is real
// content (live-confirmed: fulumandarijn.com/menu — 199KB of HTML, 764
// characters of real text after stripping tags). A large HTML payload
// carrying very little real text is exactly what a client-side-rendered
// page looks like before its JavaScript has run — this pipeline only ever
// sees the initial server response, so such a page's real menu is not
// retrievable this way at all; reporting that honestly (see restaurant.ts)
// is the correct behavior, not pretending extraction ran on real content.
const MIN_REAL_TEXT_CHARS = 250;
const SHELL_SUSPECT_HTML_BYTES = 5000;
const SHELL_SUSPECT_MAX_REAL_TEXT_CHARS = 800;

export interface PageContentCheck {
  /** True when this page is unlikely to contain retrievable static content — either too little text outright, or a large HTML payload carrying almost none (a JS-rendered shell's real-world shape). */
  looksEmpty: boolean;
  realTextChars: number;
}

/**
 * `plainText` should already be real extractable text — `htmlToPlainText(html)`
 * for an HTML page, or the PDF's own extracted text as-is (never re-run
 * through htmlToPlainText, which is an HTML-specific transform). `rawLength`
 * is the original fetched payload's length (HTML bytes, or PDF byte count) —
 * only used for the shell-suspect ratio check, since a real PDF's byte
 * count reflects embedded fonts/images, not "boilerplate", so this check is
 * naturally forgiving for PDFs (a genuine PDF menu with real text rarely
 * trips it — confirmed live against Berlin's Jolly-Speisekarte.pdf: 767KB
 * raw, 11,918 real characters, comfortably over SHELL_SUSPECT_MAX_REAL_TEXT_CHARS).
 */
export function checkPageContent(rawLength: number, plainText: string): PageContentCheck {
  const realTextChars = plainText.length;
  if (realTextChars < MIN_REAL_TEXT_CHARS) return { looksEmpty: true, realTextChars };
  if (rawLength > SHELL_SUSPECT_HTML_BYTES && realTextChars < SHELL_SUSPECT_MAX_REAL_TEXT_CHARS) {
    return { looksEmpty: true, realTextChars };
  }
  return { looksEmpty: false, realTextChars };
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
          return isPathAllowed(new URL(link.url).pathname, robotsDisallow);
        } catch {
          return false;
        }
      })
      .map((link) => ({ link: link.url, score: scoreLinkForFactType(link.url, link.text, factType) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PAGE_LIMIT);

    for (const { link } of candidates) {
      try {
        // fetchTextOrPdfCapped, not fetchTextCapped: a "menu" keyword match
        // is very often literally a PDF link (real case: this exact
        // FACT_PATH_KEYWORDS.menu vocabulary includes "speisekarte", which
        // is how Berlin's Jolly-Speisekarte.pdf gets found at all) — real
        // extracted PDF text, not raw-decoded binary, is what checkPageContent
        // and the caller's extractor need to see.
        const fetched = await fetchTextOrPdfCapped(link);
        if (!fetched.ok) continue;
        // PDFs are already real extracted text (not markup), so the
        // HTML-shell ratio check doesn't apply to them — passing rawLength
        // 0 skips it, leaving only the MIN_REAL_TEXT_CHARS floor.
        const plainText = fetched.wasPdf ? fetched.text : htmlToPlainText(fetched.text);
        const rawLength = fetched.wasPdf ? 0 : fetched.text.length;
        if (!checkPageContent(rawLength, plainText).looksEmpty) {
          return link; // stop once a real, content-bearing page is found
        }
        // Otherwise: too little real text (or a JS-rendered shell) — try the next real candidate rather than accepting it.
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
  /** Real extractable text — already-extracted PDF text when wasPdf is true, raw HTML otherwise (existing extractors already run htmlToPlainText on it themselves). */
  text: string;
  wasPdf: boolean;
}

/** Resolves (cached) then fetches (always live — a fact page's content changes far more often than its URL). */
export async function fetchFactPage(officialUrl: string, factType: FactPageType): Promise<FetchedFactPage | null> {
  const pageUrl = await resolveFactPageUrl(officialUrl, factType);
  if (!pageUrl) return null;
  const fetched = await fetchTextOrPdfCapped(pageUrl);
  if (!fetched.ok) return null;
  return { url: pageUrl, text: fetched.text, wasPdf: fetched.wasPdf };
}
