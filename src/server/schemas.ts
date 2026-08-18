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

export const updatePlaceSchema = createPlaceSchema.partial();

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

/** Shape returned to the client for every failed request. */
export interface ApiErrorBody {
  error: string;
  /** Machine-readable reason so the UI can react specifically. */
  code: string;
  /** Which pipeline stage failed, when applicable (spec §55). */
  stage?: string;
  details?: unknown;
}
