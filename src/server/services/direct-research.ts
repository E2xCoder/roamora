import "server-only";
import { searxngProvider, SearchUnavailableError } from "@/server/providers/research/searxng";
import type { WebSearchResult } from "@/server/providers/research/types";
import { selectBestResult, isOfficialSource } from "@/server/services/confidence";
import { fetchTextOrPdfCapped } from "@/server/services/url-safety";
import { resolveOfficialSource } from "@/server/services/official-source";
import { fetchFactPage, type FactPageType } from "@/server/services/official-site-crawler";

/**
 * Composes official-source.ts + official-site-crawler.ts with the existing
 * SearXNG fallback into the single entry point both research call sites
 * (autoplan.ts's attraction enrichment loop, restaurant.ts's candidate loop)
 * use — the "second-stage research layer" itself. This module does NOT
 * extract or validate any fact; it only decides WHICH page's raw text a
 * caller's existing extractor (extractFactsFromText, extractMenuFromText,
 * ...) and existing guard (opening-hours-guard.ts, price-guard.ts, ...)
 * should run against, and reports which tier supplied it.
 *
 * Tier order, matching the measured problem directly: a generic SearXNG
 * query per fact was both the main cost driver and the main source of
 * wrong-page selection. Resolving the official domain once (cached 30
 * days) and crawling ITS OWN site for the specific fact needed (cached 7
 * days) needs no search-engine round trip at all when it succeeds — the
 * SearXNG fallback below only runs when it doesn't.
 */

export interface ResolvedSource {
  /** Real extractable text — raw HTML (existing extractors run htmlToPlainText themselves), or already-extracted PDF text when wasPdf is true. */
  text: string;
  url: string;
  /** Official-tier sources have no search-result "title"; the place name stands in, since callers only use this for isOfficialSource-style title checks. */
  title: string;
  official: boolean;
  sourceType: "official" | "secondary";
  /** True when `text` came from real PDF extraction (pdf-extraction.ts) rather than HTML — callers should not run htmlToPlainText on it again. */
  wasPdf: boolean;
  /** Other results from the same SearXNG query, when the secondary tier ran — for cross-checking. Empty when the official tier supplied the source. */
  searchResults: WebSearchResult[];
}

export interface DirectResearchMetrics {
  officialDomainAttempted: boolean;
  officialDomainResolved: boolean;
  officialPageAttempted: boolean;
  officialPageResolved: boolean;
  /** True when the generic SearXNG fallback query was never needed. */
  searchQueryAvoided: boolean;
}

function emptyMetrics(): DirectResearchMetrics {
  return {
    officialDomainAttempted: false,
    officialDomainResolved: false,
    officialPageAttempted: false,
    officialPageResolved: false,
    searchQueryAvoided: false,
  };
}

export async function resolveResearchSource(
  placeName: string,
  destination: string,
  osmTags: Record<string, string>,
  factType: FactPageType,
  fallbackQuery: string,
  searchAvailable: boolean
): Promise<{ source: ResolvedSource | null; metrics: DirectResearchMetrics }> {
  const metrics = emptyMetrics();

  // --- tier 1: direct official-source resolution --------------------------
  metrics.officialDomainAttempted = true;
  const official = await resolveOfficialSource(placeName, destination, osmTags, searchAvailable);
  if (official) {
    metrics.officialDomainResolved = true;
    metrics.officialPageAttempted = true;
    const factPage = await fetchFactPage(official.officialUrl, factType, placeName);
    if (factPage) {
      metrics.officialPageResolved = true;
      metrics.searchQueryAvoided = true;
      return {
        source: {
          text: factPage.text,
          url: factPage.url,
          title: placeName,
          official: true,
          sourceType: "official",
          wasPdf: factPage.wasPdf,
          searchResults: [],
        },
        metrics,
      };
    }
  }

  // --- tier 2: existing generic SearXNG fallback, unchanged ---------------
  if (!searchAvailable) return { source: null, metrics };
  try {
    const results = await searxngProvider.searchWeb(fallbackQuery, 5);
    const page = selectBestResult(results, placeName);
    if (!page) return { source: null, metrics };
    const fetched = await fetchTextOrPdfCapped(page.url);
    if (!fetched.ok) return { source: null, metrics };
    return {
      source: {
        text: fetched.text,
        url: page.url,
        title: page.title,
        official: isOfficialSource(page.url, page.title, placeName),
        sourceType: "secondary",
        wasPdf: fetched.wasPdf,
        searchResults: results,
      },
      metrics,
    };
  } catch (err) {
    if (err instanceof SearchUnavailableError) return { source: null, metrics };
    return { source: null, metrics };
  }
}
