import "server-only";
import { searchDestination, getDestinationContent, getDestinationSection, parseListings } from "@/lib/wikivoyage";
import { getCached } from "@/server/services/research-cache";

/**
 * Real, curated local-food source — Wikivoyage's own "Eat" section for a
 * destination, tried before the generic SearXNG search
 * `researchLocalFood` previously relied on exclusively. Priority-4's
 * "Secondary Source Strategy" asks for an official tourism authority or
 * trusted local directory before falling back to general search results;
 * this codebase has no free API for a city's actual tourism board, but
 * Wikivoyage IS exactly that kind of thing for travel content — a
 * community-curated guide with a standard `==Eat==` section naming real
 * local dishes and listing real, named places via structured
 * `{{eat|name=...|content=...}}` templates, not a ranked web-search hit
 * that might land anywhere.
 *
 * `src/lib/wikivoyage.ts` already exists (used by the manual "Explore"
 * screen) and is reused here unchanged — this module only adds the
 * section-selection and wikitext-to-plain-text conversion a fully
 * automated caller needs that a human browsing the raw article does not.
 */

const NAMESPACE = "wikivoyage-eat";
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — a destination's Eat section changes rarely

export interface WikivoyageEatSection {
  articleTitle: string;
  articleUrl: string;
  /** Plain-text version of the Eat section's prose + listing content, for LLM extraction and textual-support checks. */
  text: string;
  /** Structured {{eat|...}} listings found in the section, independent of the LLM extraction below. */
  listings: Array<{ name: string; description?: string }>;
}

/**
 * Reduces a caller's full "City, Country" destination string down to just
 * the city — real, live-observed bug: searching Wikivoyage for the full
 * string (e.g. "Prague, Czech Republic") returned the COUNTRY-level
 * article ("Czech Republic") ranked above the actual city article
 * ("Prague"), so a real Prague trip's local-food facts came back
 * nationwide rather than city-specific. Only this module's own search
 * needs the workaround — the SearXNG fallback tier elsewhere benefits from
 * keeping the country for disambiguation, which Wikivoyage's own search
 * evidently does not need or want.
 */
export function cityNameForWikivoyageSearch(destination: string): string {
  const city = destination.split(",")[0].trim();
  return city || destination;
}

/** Wikivoyage's standard section is literally titled "Eat" (or "Eat and drink" in smaller articles); matched case-insensitively against the article's own section list rather than assumed to always be present or in a fixed position. */
export function findEatSectionIndex(
  sections: Array<{ line: string; index: string }>
): string | null {
  const match = sections.find((s) => /^eat\b/i.test(s.line.trim()));
  return match?.index ?? null;
}

/**
 * Converts MediaWiki wikitext to plain-ish text for extraction — a
 * different markup dialect from the HTML this pipeline's other converter
 * (fact-extraction.ts's htmlToPlainText) handles, so a separate, minimal
 * converter is needed rather than reusing that one. `{{listing|...}}`
 * templates are common in an Eat section and carry real, useful
 * human-readable content in their `name=`/`content=`/`alt=` parameters —
 * dropped entirely, those listings' descriptions (which often explicitly
 * name a dish, e.g. "known for its pierogi") would be lost, so this keeps
 * each parameter's *value* and discards only the wiki markup around it.
 */
export function wikitextToPlainText(wikitext: string): string {
  return wikitext
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
      const parts = inner.split("|").slice(1); // drop the template name itself (e.g. "eat", "see")
      const values = parts.map((p) => (p.includes("=") ? p.slice(p.indexOf("=") + 1) : p));
      return ` ${values.join(" ")} `;
    })
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1") // [[link|Display]] or [[Display]] -> Display
    .replace(/'''([^']+)'''/g, "$1")
    .replace(/''([^']+)''/g, "$1")
    .replace(/==+\s*([^=]+?)\s*==+/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the destination's Wikivoyage article and returns its Eat section's
 * plain text plus any structured listings, or null when no article or no
 * Eat section exists for it — a real, honest "nothing here", not an error.
 * Cached 30 days, keyed by destination name.
 */
export async function fetchWikivoyageEatSection(destination: string): Promise<WikivoyageEatSection | null> {
  const key = destination.toLowerCase().trim();
  return getCached(NAMESPACE, key, TTL_MS, async () => {
    let results;
    try {
      results = await searchDestination(destination);
    } catch {
      return null;
    }
    if (!results || results.length === 0) return null;

    const title = results[0].title;
    let content;
    try {
      content = await getDestinationContent(title);
    } catch {
      return null;
    }

    const eatIndex = findEatSectionIndex(content.sections);
    if (!eatIndex) return null;

    let eatWikitext: string;
    try {
      eatWikitext = await getDestinationSection(title, eatIndex);
    } catch {
      return null;
    }
    if (!eatWikitext.trim()) return null;

    const listings = parseListings(eatWikitext)
      .filter((l) => l.type.toLowerCase() === "eat")
      .map((l) => ({ name: l.name, description: l.description }));

    return {
      articleTitle: content.title,
      articleUrl: `https://en.wikivoyage.org/wiki/${encodeURIComponent(content.title.replace(/ /g, "_"))}`,
      text: wikitextToPlainText(eatWikitext),
      listings,
    };
  });
}
