import "server-only";
import { config } from "@/server/config";
import type { ResearchProvider, WebSearchResult } from "./types";
import { recordSearchOutcome, areAllKnownEnginesDown } from "./engine-health";

/**
 * SearXNG-backed web search.
 *
 * Self-host with: `docker run -d -p 8080:8080 searxng/searxng`, then set
 * SEARXNG_URL=http://localhost:8080. No API key, no per-query billing —
 * SearXNG itself aggregates other search engines' public results.
 *
 * When SEARXNG_URL is unset this provider is simply absent; the autoplan
 * orchestrator checks for that via getCapabilities() and reports web-research
 * steps as skipped rather than silently returning no results dressed up as
 * "nothing was found."
 *
 * Hardening added after a real incident: sustained automated query volume
 * during development got this container's IP CAPTCHA-blocked/rate-limited
 * on nearly every upstream engine at once (see engine-health.ts's comment).
 * Three real mitigations, not blind heuristics:
 *   - a short-TTL in-memory cache, since re-querying the exact same string
 *     within a few minutes (autoplan re-researching a candidate, or a
 *     retried request) wastes a real, rate-limited resource for no new
 *     information;
 *   - per-engine health recorded from SearXNG's own `unresponsive_engines`
 *     field on every response, which is the honest, structured signal
 *     SearXNG already provides — not scraped from logs, not guessed;
 *   - one bounded retry, but only when the response itself carried evidence
 *     the empty/thin result was infrastructure trouble (unresponsive
 *     engines reported) rather than a genuinely empty search — and never
 *     when every known engine is already down, since retrying into a wall
 *     of CAPTCHAs just spends another slot for nothing.
 */

export class SearchUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchUnavailableError";
    this.code = code;
  }
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  engines?: string[];
}

interface SearxngResponse {
  results?: SearxngResult[];
  unresponsive_engines?: Array<[string, string]>;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to absorb repeat/retry traffic, short enough that stale search results are never served for long
interface CacheEntry {
  results: WebSearchResult[];
  cachedAt: number;
}
const searchCache = new Map<string, CacheEntry>();

function cacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}::${limit}`;
}

/** Strips a trailing slash and lowercases the host so http/https or a bare trailing "/" don't count as two different results. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

async function fetchOnce(url: URL): Promise<SearxngResponse> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Roamora/1.0 (autonomous research)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new SearchUnavailableError("SEARXNG_HTTP_ERROR", `SearXNG ${res.status} döndürdü.`);
  return (await res.json()) as SearxngResponse;
}

export const searxngProvider: ResearchProvider = {
  id: "searxng",

  async searchWeb(query: string, limit = 6): Promise<WebSearchResult[]> {
    if (!config.SEARXNG_URL) {
      throw new SearchUnavailableError(
        "SEARXNG_NOT_CONFIGURED",
        "SEARXNG_URL yapılandırılmamış — web araştırması yapılamıyor."
      );
    }

    const key = cacheKey(query, limit);
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.results;
    }

    const url = new URL("/search", config.SEARXNG_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    let data: SearxngResponse;
    try {
      data = await fetchOnce(url);
    } catch (err) {
      throw new SearchUnavailableError(
        "SEARXNG_UNREACHABLE",
        `SearXNG'e ulaşılamadı (${config.SEARXNG_URL}): ${err instanceof Error ? err.message : "bilinmeyen hata"}`
      );
    }

    let results = toResults(data, limit);
    const unresponsive = data.unresponsive_engines ?? [];
    const respondingEngines = [...new Set((data.results ?? []).flatMap((r) => r.engines ?? []))];
    recordSearchOutcome(respondingEngines, unresponsive);

    // Bounded retry: only when the response itself is evidence of
    // infrastructure trouble (engines reported unresponsive) rather than a
    // genuinely empty search, and only when at least one engine isn't
    // already known-down (otherwise this would just spend another request
    // hitting the same wall).
    if (results.length === 0 && unresponsive.length > 0 && !areAllKnownEnginesDown()) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const retryData = await fetchOnce(url);
        results = toResults(retryData, limit);
        recordSearchOutcome(
          [...new Set((retryData.results ?? []).flatMap((r) => r.engines ?? []))],
          retryData.unresponsive_engines ?? []
        );
      } catch {
        // Retry failing is not itself a new failure worth throwing over —
        // the original (empty) result stands.
      }
    }

    searchCache.set(key, { results, cachedAt: Date.now() });
    return results;
  },
};

export function toResults(data: SearxngResponse, limit: number): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const r of data.results ?? []) {
    if (!r.title || !r.url) continue;
    const normalized = normalizeUrl(r.url);
    if (seen.has(normalized)) continue; // defensive de-dup beyond what SearXNG already merges by exact URL
    seen.add(normalized);
    out.push({
      title: r.title,
      url: r.url,
      snippet: r.content ?? "",
      score: r.score,
      engineAgreement: r.engines?.length,
    });
    if (out.length >= limit) break;
  }
  return out;
}
