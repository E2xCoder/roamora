import { z } from "zod";
import { LOCATION_SOURCES, SOURCE_TYPES } from "@/lib/taxonomy";

/**
 * Validation schemas for every API boundary.
 *
 * Handlers previously consumed `await request.json()` and used the fields
 * directly, so malformed input reached Prisma unchecked. Everything crossing
 * the boundary is parsed here first.
 */

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);

/**
 * Query-string variants. Search params are always strings, so bounding-box
 * edges must be coerced before range validation — otherwise every bbox request
 * fails with "expected number, received string".
 */
export const latitudeParam = z.coerce.number().min(-90).max(90);
export const longitudeParam = z.coerce.number().min(-180).max(180);

/** Personal knowledge vs. the bulk reference corpus (spec §33). */
export const PERSONAL_SOURCE_TYPES = [
  "PERSONAL",
  "IMPORTED",
  "MANUAL",
  "DISCOVERED",
] as const;

export const placeQuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).optional(),

  /**
   * Which knowledge pool to read.
   *   personal   — places the user saved or imported (default)
   *   reference  — the bulk Wikivoyage discovery corpus
   *   all        — both, with sourceType exposed so the UI can distinguish
   */
  pool: z.enum(["personal", "reference", "all"]).default("personal"),

  // Bounding box; all four required together.
  north: latitudeParam.optional(),
  south: latitudeParam.optional(),
  east: longitudeParam.optional(),
  west: longitudeParam.optional(),

  limit: z.coerce.number().int().min(1).max(2000).default(500),
  cursor: z.string().optional(),
});

export type PlaceQuery = z.infer<typeof placeQuerySchema>;

export const createPlaceSchema = z.object({
  name: z.string().trim().min(1).max(300),
  lat: latitude,
  lng: longitude,
  category: z.string().trim().default("other"),
  categoryId: z.string().trim().optional(),
  subcategory: z.string().trim().max(120).optional(),
  notes: z.string().max(5000).default(""),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  address: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  countryCode: z.string().length(2).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  website: z.string().url().max(2000).optional(),
  sourceType: z.enum(SOURCE_TYPES).default("MANUAL"),
  source: z.string().trim().default("manual"),
  locationSource: z.enum(LOCATION_SOURCES).optional(),
  locationConfidence: z.number().min(0).max(1).optional(),
  estimatedVisitMinutes: z.number().int().min(0).max(1440).optional(),
  rating: z.number().min(0).max(5).optional(),
  isHiddenGem: z.boolean().default(false),
});

export type CreatePlaceInput = z.infer<typeof createPlaceSchema>;

/**
 * Update schema — deliberately NOT `createPlaceSchema.partial()`.
 *
 * `.partial()` makes keys optional but keeps their `.default()`s, so zod
 * materialises `category: "other"`, `sourceType: "MANUAL"`, `tags: []` and
 * friends for any field the caller omitted. A PATCH that only touched `notes`
 * therefore rewrote the record's classification and provenance, moving
 * reference rows into the personal pool. Every field here is optional with no
 * default, so an absent key stays absent.
 */
export const updatePlaceSchema = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  lat: latitude.optional(),
  lng: longitude.optional(),
  category: z.string().trim().min(1).optional(),
  categoryId: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().max(120).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  countryCode: z.string().length(2).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  website: z.string().url().max(2000).optional(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
  source: z.string().trim().min(1).optional(),
  locationSource: z.enum(LOCATION_SOURCES).optional(),
  locationConfidence: z.number().min(0).max(1).optional(),
  estimatedVisitMinutes: z.number().int().min(0).max(1440).optional(),
  rating: z.number().min(0).max(5).optional(),
  isHiddenGem: z.boolean().optional(),
});

export const routeRequestSchema = z.object({
  waypoints: z
    .array(z.object({ lat: latitude, lng: longitude }))
    .min(2, "En az 2 nokta gerekli")
    .max(25, "En fazla 25 nokta"),
  profile: z.enum(["foot", "bike", "car"]).default("foot"),
});

export const importUrlSchema = z.object({
  url: z.string().url().max(2000),
});

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "SS:DD formatında olmalı (ör. 13:30)");

export const optimizeStopSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(300),
  lat: latitude,
  lng: longitude,
  category: z.string().optional(),
  visitMinutes: z.number().int().min(0).max(600).optional(),
  earliestTime: hhmm.optional(),
  latestTime: hhmm.optional(),
  fixedTime: hhmm.optional(),
  locked: z.boolean().optional(),
  estimatedCost: z.number().min(0).max(1_000_000).optional(),
});

export const autoplanRequestSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD bekleniyor"),
  arrivalTime: hhmm,
  departureTime: hhmm,
  startLocation: z
    .object({ lat: latitude, lng: longitude, name: z.string().max(300).optional() })
    .optional(),
  endLocation: z
    .object({ lat: latitude, lng: longitude, name: z.string().max(300).optional() })
    .optional(),
  budget: z.number().min(0).max(1_000_000).optional(),
  currency: z.string().max(6).optional(),
  interests: z.array(z.string().trim().min(1)).max(20).optional(),
  maxStops: z.number().int().min(1).max(16).optional(),
  profile: z.enum(["foot", "bike", "car", "transit"]).default("foot"),
  mustSeeNames: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  eventQueries: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
});

export const optimizeRequestSchema = z.object({
  stops: z.array(optimizeStopSchema).min(1).max(30),
  dayStart: hhmm.default("09:00"),
  dayEnd: hhmm.default("20:00"),
  start: z.object({
    lat: latitude,
    lng: longitude,
    name: z.string().max(300).optional(),
  }),
  end: z
    .object({ lat: latitude, lng: longitude, name: z.string().max(300).optional() })
    .optional(),
  profile: z.enum(["foot", "bike", "car"]).default("foot"),
  realismFactor: z.number().min(1).max(2).optional(),
});

/** Shape returned to the client for every failed request. */
export interface ApiErrorBody {
  error: string;
  /** Machine-readable reason so the UI can react specifically. */
  code: string;
  /** Which pipeline stage failed, when applicable (spec §55). */
  stage?: string;
  details?: unknown;
}
