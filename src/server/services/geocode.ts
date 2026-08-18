import "server-only";
import { prisma } from "@/lib/db";
import { config } from "@/server/config";

/**
 * Geocoding with a read-through cache.
 *
 * Nominatim is a free community service with a strict usage policy: one
 * request per second and a real identifying User-Agent. Results were
 * previously re-fetched on every call; identical queries now hit the
 * ProviderCache table instead (spec §63).
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  city?: string;
  country?: string;
  countryCode?: string;
}

const NAMESPACE = "geocode";
const TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days — place coordinates are stable

let lastRequestAt = 0;

function cacheKey(query: string) {
  return `${NAMESPACE}:${query.toLowerCase().trim().replace(/\s+/g, "-")}`;
}

/** Serialises outbound calls to respect the 1 req/s policy. */
async function throttle() {
  const since = Date.now() - lastRequestAt;
  if (since < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - since));
  }
  lastRequestAt = Date.now();
}

export async function geocodeOnce(
  query: string
): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const key = cacheKey(trimmed);

  // --- cache read --------------------------------------------------------
  try {
    const hit = await prisma.providerCache.findUnique({ where: { key } });
    if (hit && (!hit.expiresAt || hit.expiresAt > new Date())) {
      return hit.payload ? (JSON.parse(hit.payload) as GeocodeResult) : null;
    }
  } catch {
    // A cache failure must never break geocoding.
  }

  // --- provider ----------------------------------------------------------
  let result: GeocodeResult | null = null;
  try {
    await throttle();

    const url = new URL("/search", config.NOMINATIM_BASE_URL);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "1");

    const res = await fetch(url, {
      headers: { "User-Agent": config.NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);

    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }>;

    if (data.length > 0) {
      const a = data[0].address ?? {};
      result = {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        displayName: data[0].display_name,
        city: a.city || a.town || a.village || a.municipality,
        country: a.country,
        countryCode: a.country_code?.toUpperCase(),
      };
    }
  } catch (err) {
    console.error("[geocode] provider failed:", err);
    // Do not cache provider failures — the next call should retry.
    return null;
  }

  // --- cache write (negative results included, to stop repeat lookups) ---
  try {
    const payload = result ? JSON.stringify(result) : "";
    await prisma.providerCache.upsert({
      where: { key },
      create: {
        key,
        namespace: NAMESPACE,
        payload,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
      update: {
        payload,
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
  } catch {
    // Caching is best-effort.
  }

  return result;
}

/** Approximate degree deltas for a radius in km at a given latitude. */
export function bboxAround(lat: number, lng: number, radiusKm: number) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    south: lat - dLat,
    north: lat + dLat,
    west: lng - dLng,
    east: lng + dLng,
  };
}
