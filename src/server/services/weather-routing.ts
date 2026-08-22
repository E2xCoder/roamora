/**
 * Turns a real weather forecast into an actual routing-decision change
 * (spec §Priority 6: "influences routing decisions, not just displays
 * forecast") — a category weight adjustment fed into the EXISTING
 * pruneAndDiversify weighting mechanism (discovery-scoring.ts), not a new,
 * parallel selection system. On a real bad-weather day, indoor categories
 * are weighted up and outdoor categories down before the shortlist is
 * built, so the actual set of stops a traveller gets is different — not
 * just a forecast blurb sitting next to an unchanged plan.
 */

const OUTDOOR_CATEGORIES = new Set(["viewpoint", "park", "nature", "beach", "hike", "trekking", "cycling", "monument", "landmark"]);
const INDOOR_CATEGORIES = new Set(["museum", "church", "castle", "historic", "architecture", "shopping"]);

export function isOutdoorCategory(category: string): boolean {
  return OUTDOOR_CATEGORIES.has(category);
}

export function isIndoorCategory(category: string): boolean {
  return INDOOR_CATEGORIES.has(category);
}

const OUTDOOR_WEIGHT_MULTIPLIER = 0.4;
const INDOOR_WEIGHT_MULTIPLIER = 2;

/**
 * Adjusts a category-weight map for bad weather — multiplicatively, on
 * top of whatever weight the caller (the user's own stated interests)
 * already assigned, so a traveller who explicitly asked for more parks
 * still gets relatively more parks than someone who didn't, just fewer
 * than they would have on a clear day. Returns the SAME weights unchanged
 * (a fresh copy, not a mutation) when the weather isn't actually bad —
 * this must never touch the plan on a normal day.
 */
export function applyWeatherWeights(
  baseWeights: Record<string, number>,
  allCategories: string[],
  badWeatherDay: boolean
): Record<string, number> {
  if (!badWeatherDay) return { ...baseWeights };

  const adjusted: Record<string, number> = { ...baseWeights };
  for (const category of allCategories) {
    const base = adjusted[category] ?? 1;
    if (isOutdoorCategory(category)) adjusted[category] = base * OUTDOOR_WEIGHT_MULTIPLIER;
    else if (isIndoorCategory(category)) adjusted[category] = base * INDOOR_WEIGHT_MULTIPLIER;
  }
  return adjusted;
}
