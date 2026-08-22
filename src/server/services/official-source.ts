import "server-only";
import { searxngProvider, SearchUnavailableError } from "@/server/providers/research/searxng";
import { isOfficialSource, selectBestResult, type ConfidenceLevel } from "@/server/services/confidence";
import { getCached } from "@/server/services/research-cache";

/**
 * Official-source discovery — the second-stage research layer (spec
 * §Priority-4 "Direct Official Source Resolution"). The problem this
 * addresses is concrete and was measured directly in Priority 3's live
 * tests: a generic SearXNG query per fact, per place, is both the main
 * research cost driver AND the main source of wrong-page selection (a
 * restaurant's name colliding with an unrelated site). Resolving a place's
 * real official domain ONCE, then fetching fact-specific pages directly
 * from that domain, needs far fewer search-engine round trips and starts
 * from a page that is actually about the right place by construction.
 *
 * Deliberately conservative, same discipline as the rest of this pipeline:
 * a domain is never accepted as "official" merely because its name looks
 * similar — every web-search-derived candidate is still gated by the
 * existing, coverage-ratio-protected `isOfficialSource` heuristic
 * (confidence.ts), reused unchanged, not re-implemented here.
 */

export type OfficialSourceMethod = "osm-tag" | "wikidata" | "web-search";

export interface OfficialSourceResult {
  officialUrl: string;
  officialDomain: string;
  confidence: ConfidenceLevel;
  method: OfficialSourceMethod;
}

const NAMESPACE = "official-source";
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — an official domain almost never changes

function normalizeKey(placeName: string, destination: string): string {
  return `${placeName.toLowerCase().trim()}|${destination.toLowerCase().trim()}`;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Rejects a URL that is structurally not a real, fetchable website (mailto:, a bare hostname with no scheme, etc.). */
function isRealHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

let lastWikidataRequestAt = 0;

/** Wikidata's P856 ("official website") claim for a given entity — a single, free, keyless REST call. */
async function wikidataOfficialWebsite(qid: string): Promise<string | null> {
  const since = Date.now() - lastWikidataRequestAt;
  if (since < 1000) await new Promise((r) => setTimeout(r, 1000 - since));
  lastWikidataRequestAt = Date.now();

  try {
    const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, {
      headers: { "User-Agent": "Roamora/1.0 (personal travel planner; https://github.com/E2xCoder/roamora)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      entities?: Record<string, { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: string } } }>> }>;
    };
    const entity = data.entities?.[qid];
    const claim = entity?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
    return isRealHttpUrl(claim) ? claim : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a place's canonical official website, trying the cheapest and
 * most trustworthy sources first (spec order 1-6; steps 3/5/6 — existing
 * place metadata, tourism authority, institution directory — are folded
 * into the web-search tier below rather than implemented as separate real
 * integrations in this pass, since no free/keyless dedicated API exists for
 * them in this stack; see the module-level report on this).
 */
export async function resolveOfficialSource(
  placeName: string,
  destination: string,
  osmTags: Record<string, string>,
  searchAvailable: boolean
): Promise<OfficialSourceResult | null> {
  const key = normalizeKey(placeName, destination);

  return getCached(NAMESPACE, key, TTL_MS, async () => {
    // --- 1. OSM website/contact tags — community-maintained structured data.
    const osmUrl = osmTags.website || osmTags["contact:website"];
    if (isRealHttpUrl(osmUrl)) {
      const domain = domainOf(osmUrl);
      if (domain) return { officialUrl: osmUrl, officialDomain: domain, confidence: "high", method: "osm-tag" };
    }

    // --- 2. Wikidata's official-website property, when OSM links a wikidata id.
    if (osmTags.wikidata) {
      const wdUrl = await wikidataOfficialWebsite(osmTags.wikidata);
      if (wdUrl) {
        const domain = domainOf(wdUrl);
        if (domain) return { officialUrl: wdUrl, officialDomain: domain, confidence: "high", method: "wikidata" };
      }
    }

    // --- 4-6. targeted web search, gated by the existing isOfficialSource
    // coverage-ratio heuristic — never accepted on name-similarity alone.
    if (!searchAvailable) return null;
    try {
      const results = await searxngProvider.searchWeb(`"${placeName}" ${destination} official website`, 5);
      const best = selectBestResult(results, placeName);
      if (!best) return null;
      if (!isOfficialSource(best.url, best.title, placeName)) return null;
      const domain = domainOf(best.url);
      if (!domain) return null;
      return { officialUrl: best.url, officialDomain: domain, confidence: "medium", method: "web-search" };
    } catch (err) {
      if (err instanceof SearchUnavailableError) return null;
      return null;
    }
  });
}
