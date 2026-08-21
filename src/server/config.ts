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

  // DEFERRED (phase 8). Empty means the feature shows an explicit
  // "not configured" state rather than fabricating results.
  FLIGHT_PROVIDER: z.string().optional(),

  // WEB RESEARCH -------------------------------------------------------------
  // SearXNG is a self-hostable, keyless meta-search engine — the open-source
  // answer to "the app needs to search the web but must not require a paid
  // API key." Optional: absence is a reported capability gap (autoplan falls
  // back to OSM-only data with lower confidence), never a silent guess.
  // Self-host with: docker run -d -p 8080:8080 searxng/searxng
  SEARXNG_URL: z.string().optional(),

  // TRANSIT ROUTING ------------------------------------------------------------
  // OpenTripPlanner is a separate, self-hosted Java service fed OSM + GTFS
  // data per destination — genuine infrastructure, not an API call this
  // process can stand up on its own. Optional: absence means transit legs are
  // reported as unavailable rather than estimated.
  OTP_URL: z.string().optional(),

  // AUTONOMOUS DISCOVERY -------------------------------------------------------
  // 1500m keeps the Overpass query cheap enough to complete reliably against
  // the public instance while still covering a walkable city-centre day.
  DISCOVERY_RADIUS_METERS: z.coerce.number().int().min(200).max(20_000).default(1500),
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
