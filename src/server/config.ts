import "server-only";
import { z } from "zod";

/**
 * Single source of truth for environment configuration.
 *
 * Every external service endpoint lives here rather than being hardcoded at the
 * call site, so providers can be swapped or self-hosted without touching
 * application logic. This module is server-only — importing it from a client
 * component is a build error, which is what keeps secrets off the client.
 */

const schema = z.object({
  // DATABASE ---------------------------------------------------------------
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),

  // AUTH -------------------------------------------------------------------
  AUTH_SECRET: z.string().optional(),
  ROAMORA_PASSWORD_HASH: z.string().optional(),

  // AI ---------------------------------------------------------------------
  AI_PROVIDER: z.enum(["ollama", "none"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),

  // MAP TILES --------------------------------------------------------------
  MAP_TILE_URL: z
    .string()
    .default(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
    ),
  MAP_TILE_ATTRIBUTION: z
    .string()
    .default(
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    ),

  // GEOCODING --------------------------------------------------------------
  GEOCODING_PROVIDER: z.enum(["nominatim"]).default("nominatim"),
  NOMINATIM_BASE_URL: z.string().default("https://nominatim.openstreetmap.org"),
  NOMINATIM_USER_AGENT: z.string().default("Roamora/1.0"),

  // ROUTING ----------------------------------------------------------------
  ROUTING_PROVIDER: z.enum(["osrm"]).default("osrm"),
  OSRM_FOOT_URL: z.string().default("https://routing.openstreetmap.de/routed-foot"),
  OSRM_BIKE_URL: z.string().default("https://routing.openstreetmap.de/routed-bike"),
  OSRM_CAR_URL: z.string().default("https://routing.openstreetmap.de/routed-car"),

  // OVERPASS / WIKIVOYAGE / WAYMARKED --------------------------------------
  OVERPASS_URL: z.string().default("https://overpass-api.de/api/interpreter"),
  WIKIVOYAGE_URL: z.string().default("https://en.wikivoyage.org/w/api.php"),
  WAYMARKED_URL: z.string().default("https://hiking.waymarkedtrails.org/api/v1"),

  // STORAGE ----------------------------------------------------------------
  STORAGE_PROVIDER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_PATH: z.string().default("./storage"),

  // SOURCE INGESTION -------------------------------------------------------
  // Optional. Absence is a reported capability gap, never a silent failure.
  YTDLP_PATH: z.string().default("yt-dlp"),

  // DEFERRED (phases 7-8). Empty means the feature shows an explicit
  // "not configured" state rather than fabricating results.
  SEARCH_PROVIDER: z.string().optional(),
  FLIGHT_PROVIDER: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;

/** Resolves a routing profile to its configured OSRM host. */
export function osrmHostFor(profile: "foot" | "bike" | "car"): string {
  switch (profile) {
    case "bike":
      return config.OSRM_BIKE_URL;
    case "car":
      return config.OSRM_CAR_URL;
    default:
      return config.OSRM_FOOT_URL;
  }
}
