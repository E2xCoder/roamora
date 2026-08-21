/**
 * PlaceDiscoveryProvider — autonomous POI discovery for a destination.
 *
 * Given a centre point and radius, returns real candidate places with real
 * coordinates and whatever structured facts the source itself carries (OSM
 * tags: opening_hours, fee, website, cuisine, wikidata). No web scraping, no
 * LLM guessing — this is data the source already publishes.
 */

export interface DiscoveredPlace {
  /** Stable id derived from the source (e.g. "osm:way:12345"). */
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** OSM primary tag, e.g. "tourism=museum" — kept raw for the classifier. */
  osmTag: string;
  osmValue: string;
  /** All source tags, for enrichment fields the classifier doesn't use directly. */
  tags: Record<string, string>;
  source: "osm";
}

export interface DiscoveryProvider {
  readonly id: string;
  discover(
    center: { lat: number; lng: number },
    radiusMeters: number
  ): Promise<DiscoveredPlace[]>;
}
