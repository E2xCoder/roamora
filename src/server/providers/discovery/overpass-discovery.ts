import "server-only";
import { config } from "@/server/config";
import type { DiscoveredPlace, DiscoveryProvider } from "./types";

/**
 * Overpass-backed discovery.
 *
 * Queries `nwr` (the combined node+way+relation selector) instead of writing
 * out `node`, `way` and `relation` as three separate clauses — the existing
 * `src/lib/overpass.ts` (used by the manual "Explore" screen) queries `node`
 * only, which misses most real POIs, since a museum building or a park
 * boundary is almost always mapped as a way or relation, not a point. That
 * gap is D7 in the project's own architecture audit; `nwr` closes it while
 * keeping the query a third of the size three separate clauses would need.
 *
 * One request, not several: an earlier version of this provider split
 * categories into multiple sequential batches to keep each request small.
 * In testing that made things worse, not better — Overpass's public
 * instance grants a client only two concurrent "slots"
 * (https://overpass-api.de/api/status confirms this per-client limit), and a
 * batch whose response arrived after this process's own timeout had already
 * given up left that slot occupied server-side, starving the next batch and
 * cascading into timeouts and eventually a 429. A single query with a
 * patient, generous timeout uses one slot for the whole discovery and avoids
 * that pile-up entirely.
 */

const CATEGORY_FILTERS: Record<string, string> = {
  attraction: `["tourism"~"^(attraction|museum|viewpoint|gallery|artwork|zoo|theme_park)$"]`,
  // Unrestricted `historic=*` matches every plaque and marked building in an
  // old town — in testing this alone was expensive enough to push the whole
  // combined query past what the public Overpass instance would complete in
  // under a minute. Restricted to the values actually worth visiting.
  historic: `["historic"~"^(castle|monument|memorial|church|building|archaeological_site|fort|city_gate|manor)$"]`,
  worship: `["amenity"="place_of_worship"]`,
  food: `["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]`,
  bakery: `["shop"="bakery"]`,
  nature: `["leisure"~"^(park|garden|nature_reserve)$"]`,
  natural: `["natural"~"^(water|beach|peak|waterfall)$"]`,
  market: `["amenity"="marketplace"]`,
  monument: `["historic"~"^(monument|memorial)$"],["man_made"="obelisk"]`,
  accommodation: `["tourism"~"^(hotel|hostel|guest_house)$"]`,
};

// Measured against the live public instance: the full category set at a
// 1500m radius completes in single-digit seconds under normal load. This
// budget leaves headroom for a slower moment without holding the endpoint's
// other steps (routing, enrichment) hostage to it.
const OVERPASS_INTERNAL_TIMEOUT_S = 30;
const CLIENT_TIMEOUT_MS = 35_000;

function buildQuery(center: { lat: number; lng: number }, radiusMeters: number): string {
  const around = `(around:${radiusMeters},${center.lat},${center.lng})`;
  const clauses = Object.values(CATEGORY_FILTERS)
    .flatMap((filter) =>
      // A filter may carry multiple comma-separated tag clauses (e.g.
      // "monument"), each becoming its own query line.
      filter.split("],[").map((f, i, arr) => {
        const clause = arr.length > 1 ? (i === 0 ? `${f}]` : `[${f}`) : f;
        return `  nwr${clause}["name"]${around};`;
      })
    )
    .join("\n");

  return `[out:json][timeout:${OVERPASS_INTERNAL_TIMEOUT_S}];\n(\n${clauses}\n);\nout center tags;`;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function primaryTag(tags: Record<string, string>): { key: string; value: string } {
  for (const key of ["tourism", "historic", "amenity", "shop", "leisure", "natural", "man_made"]) {
    if (tags[key]) return { key, value: tags[key] };
  }
  return { key: "unknown", value: "unknown" };
}

export interface DiscoverResult {
  places: DiscoveredPlace[];
  complete: boolean;
  failedCategories: string[];
}

export const overpassDiscovery: DiscoveryProvider & {
  discoverDetailed(
    center: { lat: number; lng: number },
    radiusMeters: number
  ): Promise<DiscoverResult>;
} = {
  id: "overpass",

  async discover(center, radiusMeters): Promise<DiscoveredPlace[]> {
    const result = await this.discoverDetailed(center, radiusMeters);
    return result.places;
  },

  async discoverDetailed(center, radiusMeters): Promise<DiscoverResult> {
    const overpassQL = buildQuery(center, radiusMeters);

    let res: Response;
    try {
      res = await fetch(config.OVERPASS_URL, {
        method: "POST",
        body: `data=${encodeURIComponent(overpassQL)}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Roamora/1.0 (autonomous discovery; contact via github.com/E2xCoder/roamora)",
        },
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
    } catch (err) {
      console.error("[overpass-discovery] request failed:", err);
      return {
        places: [],
        complete: false,
        failedCategories: Object.keys(CATEGORY_FILTERS),
      };
    }

    if (!res.ok) {
      console.error(`[overpass-discovery] HTTP ${res.status}`);
      return {
        places: [],
        complete: false,
        failedCategories: Object.keys(CATEGORY_FILTERS),
      };
    }

    const data = (await res.json()) as { elements: OverpassElement[]; remark?: string };
    if (data.remark) {
      // Overpass can return HTTP 200 with an embedded error (its own runtime
      // timeout, most commonly) — that is a failure, not "nothing found here."
      console.error(`[overpass-discovery] remark: ${data.remark}`);
      return {
        places: [],
        complete: false,
        failedCategories: Object.keys(CATEGORY_FILTERS),
      };
    }

    const seen = new Set<string>();
    const places: DiscoveredPlace[] = [];

    for (const el of data.elements) {
      const tags = el.tags ?? {};
      const name = tags.name;
      if (!name) continue;

      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;

      const id = `osm:${el.type}:${el.id}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const { key, value } = primaryTag(tags);
      places.push({ id, name, lat, lng, osmTag: key, osmValue: value, tags, source: "osm" });
    }

    return { places, complete: true, failedCategories: [] };
  },
};
