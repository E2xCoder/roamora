/**
 * Deterministic classification and pruning for autonomously discovered places.
 *
 * No LLM here — an OSM tag is a structured fact ("tourism=museum" really does
 * mean museum), so mapping it to the app's taxonomy is a lookup table, and
 * pruning a candidate list down to a usable size is a scoring function. Both
 * are pure and unit-testable, matching the project's rule that ordering and
 * classification of verifiable facts must be deterministic, not guessed.
 */

import type { DiscoveredPlace } from "@/server/providers/discovery/types";

/** OSM `key=value` → taxonomy category id. Order matters: first match wins. */
const OSM_TAG_MAP: Array<{ key: string; value: RegExp; category: string }> = [
  { key: "tourism", value: /^museum$/, category: "museum" },
  { key: "tourism", value: /^gallery$/, category: "museum" },
  { key: "tourism", value: /^viewpoint$/, category: "viewpoint" },
  { key: "tourism", value: /^attraction$/, category: "attraction" },
  { key: "tourism", value: /^zoo$/, category: "attraction" },
  { key: "tourism", value: /^theme_park$/, category: "attraction" },
  { key: "tourism", value: /^artwork$/, category: "landmark" },
  { key: "tourism", value: /^hotel|hostel|guest_house$/, category: "accommodation" },

  { key: "historic", value: /^castle$/, category: "castle" },
  { key: "historic", value: /^monument|memorial$/, category: "monument" },
  { key: "historic", value: /.*/, category: "historic" },

  { key: "man_made", value: /^obelisk|tower$/, category: "monument" },

  { key: "amenity", value: /^place_of_worship$/, category: "church" },
  { key: "amenity", value: /^restaurant|fast_food$/, category: "restaurant" },
  { key: "amenity", value: /^cafe$/, category: "cafe" },
  { key: "amenity", value: /^bar|pub$/, category: "bar" },
  { key: "amenity", value: /^marketplace$/, category: "market" },

  { key: "shop", value: /^bakery$/, category: "bakery" },

  { key: "leisure", value: /^park|garden$/, category: "park" },
  { key: "leisure", value: /^nature_reserve$/, category: "nature" },

  { key: "natural", value: /^water|beach$/, category: "beach" },
  { key: "natural", value: /^waterfall|peak$/, category: "nature" },
];

export function classifyOsmPlace(osmTag: string, osmValue: string): string {
  const match = OSM_TAG_MAP.find((m) => m.key === osmTag && m.value.test(osmValue));
  return match?.category ?? "attraction";
}

export interface ScoredCandidate {
  place: DiscoveredPlace;
  category: string;
  /** OSM tag completeness — a free, real proxy for "this is a maintained, notable entry". */
  notabilityScore: number;
  distanceFromCenterMeters: number;
}

const NOTABILITY_TAGS = ["wikidata", "wikipedia", "website", "opening_hours", "phone", "image"];

function notabilityOf(tags: Record<string, string>): number {
  return NOTABILITY_TAGS.reduce((score, tag) => score + (tags[tag] ? 1 : 0), 0);
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function scoreCandidates(
  places: DiscoveredPlace[],
  center: { lat: number; lng: number }
): ScoredCandidate[] {
  return places.map((place) => ({
    place,
    category: classifyOsmPlace(place.osmTag, place.osmValue),
    notabilityScore: notabilityOf(place.tags),
    distanceFromCenterMeters: haversineMeters(center, place),
  }));
}

/**
 * Reduces a large candidate set to a usable shortlist without collapsing
 * every category into "whichever had the most raw entries" — a city center
 * typically has far more restaurants mapped than museums, so a plain top-N by
 * score would return an itinerary of only restaurants.
 *
 * Uses smooth weighted round-robin (the algorithm nginx uses to distribute
 * requests across weighted upstreams): each pick goes to whichever category
 * has accumulated the most "credit" so far, then that category's credit is
 * debited by the total weight. With equal weights this simply cycles through
 * every category evenly, which is what gives the default case its diversity
 * guarantee. With a heavily skewed weight (the user said they care a lot
 * about one category) the same mechanism naturally clusters consecutive picks
 * on that category instead of forcing one-of-everything regardless of stated
 * preference.
 */
export function pruneAndDiversify(
  scored: ScoredCandidate[],
  maxCount: number,
  categoryWeights: Record<string, number> = {}
): ScoredCandidate[] {
  const byCategory = new Map<string, ScoredCandidate[]>();
  for (const c of scored) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  for (const list of byCategory.values()) {
    list.sort((a, b) => b.notabilityScore - a.notabilityScore || a.distanceFromCenterMeters - b.distanceFromCenterMeters);
  }

  // Stable order (Map preserves insertion order) so ties resolve consistently.
  const categories = [...byCategory.keys()];
  const weight = (cat: string) => categoryWeights[cat] ?? 1;
  const totalWeight = categories.reduce((s, c) => s + weight(c), 0) || 1;

  const credit = new Map(categories.map((c) => [c, 0]));
  const cursor = new Map(categories.map((c) => [c, 0])); // next unused index per category

  const out: ScoredCandidate[] = [];
  const isExhausted = (cat: string) => (cursor.get(cat) ?? 0) >= (byCategory.get(cat)?.length ?? 0);

  while (out.length < maxCount && categories.some((c) => !isExhausted(c))) {
    for (const c of categories) credit.set(c, (credit.get(c) ?? 0) + weight(c));

    // Highest-credit non-exhausted category wins this pick.
    let winner: string | null = null;
    for (const c of categories) {
      if (isExhausted(c)) continue;
      if (winner === null || (credit.get(c) ?? 0) > (credit.get(winner) ?? 0)) winner = c;
    }
    if (!winner) break;

    const idx = cursor.get(winner)!;
    out.push(byCategory.get(winner)![idx]);
    cursor.set(winner, idx + 1);
    credit.set(winner, (credit.get(winner) ?? 0) - totalWeight);
  }

  return out;
}
