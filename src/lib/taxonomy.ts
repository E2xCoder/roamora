/**
 * Controlled place taxonomy (spec §13).
 *
 * Importable from both server and client — no server-only dependencies — so
 * the same definitions drive database seeding, classification and UI rendering.
 */

export interface CategoryDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  sort: number;
  /** Permitted subcategory values; free text is allowed but these are suggested. */
  subcategories?: string[];
}

export const CATEGORIES: CategoryDef[] = [
  // --- food & drink -------------------------------------------------------
  { id: "restaurant", label: "Restaurant", icon: "🍽️", color: "#ef4444", sort: 10,
    subcategories: ["Local", "Street Food", "Fine Dining", "Italian", "Asian", "Vegetarian"] },
  { id: "cafe", label: "Cafe", icon: "☕", color: "#f59e0b", sort: 11 },
  { id: "bar", label: "Bar", icon: "🍸", color: "#a855f7", sort: 12 },
  { id: "bakery", label: "Bakery", icon: "🥐", color: "#fbbf24", sort: 13 },
  { id: "food", label: "Food", icon: "🍴", color: "#f97316", sort: 14 },
  { id: "market", label: "Market", icon: "🧺", color: "#84cc16", sort: 15 },

  // --- sights -------------------------------------------------------------
  { id: "attraction", label: "Attraction", icon: "⭐", color: "#6366f1", sort: 20 },
  { id: "landmark", label: "Landmark", icon: "🗿", color: "#8b5cf6", sort: 21 },
  { id: "museum", label: "Museum", icon: "🖼️", color: "#6366f1", sort: 22 },
  { id: "historic", label: "Historic Site", icon: "🏛️", color: "#8b5cf6", sort: 23 },
  { id: "church", label: "Church", icon: "⛪", color: "#7c3aed", sort: 24 },
  { id: "castle", label: "Castle", icon: "🏰", color: "#9333ea", sort: 25 },
  { id: "monument", label: "Monument", icon: "🗽", color: "#a78bfa", sort: 26 },
  { id: "architecture", label: "Architecture", icon: "🏗️", color: "#818cf8", sort: 27 },

  // --- outdoors -----------------------------------------------------------
  { id: "viewpoint", label: "Viewpoint", icon: "🌅", color: "#ec4899", sort: 30 },
  { id: "park", label: "Park", icon: "🌳", color: "#22c55e", sort: 31 },
  { id: "nature", label: "Nature", icon: "🌿", color: "#16a34a", sort: 32 },
  { id: "beach", label: "Beach", icon: "🏖️", color: "#06b6d4", sort: 33 },

  // --- routes -------------------------------------------------------------
  { id: "hike", label: "Hike", icon: "🥾", color: "#059669", sort: 40,
    subcategories: ["Easy", "Moderate", "Hard"] },
  { id: "trekking", label: "Trekking Route", icon: "⛰️", color: "#047857", sort: 41 },
  { id: "cycling", label: "Cycling Route", icon: "🚲", color: "#0d9488", sort: 42 },

  // --- experience ---------------------------------------------------------
  { id: "neighborhood", label: "Neighborhood", icon: "🏘️", color: "#0ea5e9", sort: 50 },
  { id: "shopping", label: "Shopping", icon: "🛍️", color: "#f97316", sort: 51 },
  { id: "nightlife", label: "Nightlife", icon: "🎶", color: "#c026d3", sort: 52 },
  { id: "activity", label: "Activity", icon: "🎯", color: "#e11d48", sort: 53 },
  { id: "local-experience", label: "Local Experience", icon: "🎭", color: "#db2777", sort: 54 },
  { id: "hidden-gem", label: "Hidden Gem", icon: "💎", color: "#eab308", sort: 55 },

  // --- logistics ----------------------------------------------------------
  { id: "accommodation", label: "Accommodation", icon: "🏨", color: "#3b82f6", sort: 60 },
  { id: "transport", label: "Transport", icon: "🚉", color: "#64748b", sort: 61 },
  { id: "other", label: "Other", icon: "📍", color: "#78716c", sort: 99 },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryOf(id: string | null | undefined): CategoryDef {
  return (id && CATEGORY_BY_ID.get(id)) || CATEGORY_BY_ID.get("other")!;
}

/**
 * Maps the legacy free-text `Place.category` values to taxonomy ids.
 * Legacy rows predate the controlled vocabulary; this keeps them addressable
 * without rewriting the column the current UI still reads.
 */
const LEGACY_MAP: Record<string, string> = {
  restaurant: "restaurant",
  cafe: "cafe",
  bar: "bar",
  nature: "nature",
  historic: "historic",
  museum: "museum",
  beach: "beach",
  viewpoint: "viewpoint",
  hiking: "hike",
  nightlife: "nightlife",
  shopping: "shopping",
  accommodation: "accommodation",
  "hidden-gem": "hidden-gem",
  attraction: "attraction",
  park: "park",
  other: "other",
};

/**
 * Resolves any category string to a taxonomy id.
 *
 * Accepts three shapes: a value that is already a taxonomy id (the ingestion
 * pipeline emits these), a legacy free-text value from the seeded data, or
 * something unknown. Ids used to fall through to "other" because only the
 * legacy table was consulted, so a place classified as `castle` was stored as
 * `other`.
 */
export function legacyCategoryToId(input: string | null | undefined): string {
  if (!input) return "other";
  const key = input.toLowerCase().trim();
  if (CATEGORY_BY_ID.has(key)) return key;
  return LEGACY_MAP[key] ?? "other";
}

/**
 * Search-normalised form of a place name: lowercase, diacritics removed.
 *
 * SQLite offers no unaccent function, so this is precomputed into a column.
 * Without it, typing "poznan" missed every "Poznań" and a search for accented
 * places quietly returned a fraction of the matches.
 */
export function normalizeForSearch(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Polish ł and similar do not decompose, so map them explicitly.
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/** Provenance vocabularies (spec §11, §33). */
export const SOURCE_TYPES = [
  "PERSONAL",
  "RESEARCHED",
  "IMPORTED",
  "MANUAL",
  "DISCOVERED",
  "REFERENCE",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const LOCATION_SOURCES = [
  "EXPLICIT_COORDINATE",
  "PLATFORM_METADATA",
  "URL",
  "TEXT",
  "OCR",
  "AI",
  "GEOCODER",
  "MANUAL",
] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/**
 * Confidence at or above which an extracted location is saved without asking.
 * Below this the UI must confirm before persisting (spec §11).
 */
export const AUTO_SAVE_CONFIDENCE = 0.85;
