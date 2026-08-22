/**
 * ResearchProvider — web search for facts a geodata source doesn't carry
 * (current opening hours, prices, events).
 *
 * Deliberately provider-agnostic and optional. The reference implementation
 * targets SearXNG — a self-hostable, keyless meta-search engine — rather than
 * a paid search API, because requiring a paid key would be a hard external
 * dependency the project has avoided everywhere else (OSRM, Nominatim,
 * Overpass, Wikipedia are all free/self-hostable for the same reason).
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** SearXNG's own relevance score for this result, when the provider exposes one. Higher is more relevant. */
  score?: number;
  /** How many distinct upstream engines independently returned this same URL — real agreement, not a guess. */
  engineAgreement?: number;
}

export interface ResearchProvider {
  readonly id: string;
  searchWeb(query: string, limit?: number): Promise<WebSearchResult[]>;
}
