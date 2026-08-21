import "server-only";
import { config } from "@/server/config";
import type { ResearchProvider, WebSearchResult } from "./types";

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
 */

export class SearchUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchUnavailableError";
    this.code = code;
  }
}

interface SearxngResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
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

    const url = new URL("/search", config.SEARXNG_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "Roamora/1.0 (autonomous research)" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new SearchUnavailableError(
        "SEARXNG_UNREACHABLE",
        `SearXNG'e ulaşılamadı (${config.SEARXNG_URL}): ${
          err instanceof Error ? err.message : "bilinmeyen hata"
        }`
      );
    }

    if (!res.ok) {
      throw new SearchUnavailableError("SEARXNG_HTTP_ERROR", `SearXNG ${res.status} döndürdü.`);
    }

    const data = (await res.json()) as SearxngResponse;
    return (data.results ?? [])
      .filter((r) => r.title && r.url)
      .slice(0, limit)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: r.content ?? "",
      }));
  },
};
