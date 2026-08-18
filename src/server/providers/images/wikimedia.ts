import "server-only";
import { prisma } from "@/lib/db";
import { haversine } from "@/lib/place-meta";

/**
 * Photo lookup via the Wikipedia/Wikimedia API.
 *
 * Free, keyless and generously licensed — which matters because the whole
 * point is that Roamora costs nothing to run (§8). Saved places had no
 * imagery at all, so every card fell back to an emoji tile.
 *
 * Two strategies, in order of reliability:
 *   1. geosearch — articles whose coordinates are near the place, then match
 *      on title. Coordinates are far more trustworthy than a name.
 *   2. title search — for places Wikipedia has no coordinates for.
 *
 * Results are cached in ProviderCache, including misses, so a place without a
 * photo is not looked up repeatedly.
 */

const API = "https://en.wikipedia.org/w/api.php";
const NAMESPACE = "place-image";
const TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 days
const THUMB_SIZE = 800;

export interface PlaceImage {
  url: string;
  /** Wikipedia article the image came from, for attribution. */
  pageTitle: string;
  strategy: "geosearch" | "title";
}

let lastRequestAt = 0;
/** Raised after a 429 so the next calls back off instead of piling on. */
let backoffUntil = 0;

/**
 * Wikimedia's anonymous rate limit is stricter than it looks: 250 ms between
 * calls was enough to earn a sustained 429, which the enrichment then reported
 * as "no photo". One request per second, with a cooling-off period after a
 * rejection, keeps within policy.
 */
const MIN_INTERVAL_MS = 1000;
const BACKOFF_MS = 60_000;

async function throttle() {
  const now = Date.now();
  if (now < backoffUntil) {
    throw new ProviderUnavailable(
      `Wikipedia hız sınırı — ${Math.ceil((backoffUntil - now) / 1000)} sn sonra tekrar denenebilir`
    );
  }

  const since = now - lastRequestAt;
  if (since < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
  }
  lastRequestAt = Date.now();
}

/** Raised when the provider itself failed, as opposed to finding nothing. */
class ProviderUnavailable extends Error {}

/** Exposed so callers can tell a rate limit from a genuine absence. */
export function imageProviderCoolingOff(): number {
  return Math.max(0, backoffUntil - Date.now());
}

async function wikiFetch(params: Record<string, string>): Promise<unknown> {
  await throttle();
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");

  try {
    const res = await fetch(url, {
      // Wikimedia's policy requires an identifying agent with a contact.
      headers: {
        "User-Agent":
          "Roamora/1.0 (personal travel planner; https://github.com/E2xCoder/roamora)",
      },
      signal: AbortSignal.timeout(12_000),
    });

    // Rate limiting and outages are transient. Treating them as "this place
    // has no photo" cached the failure for 60 days, so well-photographed
    // places like Nanga Parbat were permanently marked as having none.
    if (res.status === 429) {
      backoffUntil = Date.now() + BACKOFF_MS;
      throw new ProviderUnavailable("Wikipedia hız sınırı (429)");
    }
    if (res.status >= 500) {
      throw new ProviderUnavailable(`Wikipedia ${res.status}`);
    }
    if (!res.ok) return null;

    return await res.json();
  } catch (err) {
    if (err instanceof ProviderUnavailable) throw err;
    throw new ProviderUnavailable(
      err instanceof Error ? err.message : "request failed"
    );
  }
}

interface WikiPage {
  pageid: number;
  title: string;
  thumbnail?: { source: string };
  coordinates?: Array<{ lat: number; lon: number }>;
}

function pagesOf(payload: unknown): WikiPage[] {
  const query = (payload as { query?: { pages?: Record<string, WikiPage> } })?.query;
  return query?.pages ? Object.values(query.pages) : [];
}

/**
 * Articles that are never a photograph of a specific place.
 *
 * Without this, "Engstligenfälle Adelboden" picked up the lead image of
 * "List of waterfalls in Switzerland" — a real photo, of the wrong waterfall.
 */
const NON_PLACE_TITLE = /^(list of |lists of |index of |outline of |timeline of )|\(disambiguation\)|^category:/i;

function isPlaceArticle(title: string): boolean {
  return !NON_PLACE_TITLE.test(title);
}

/** Loose containment check — "Mürren" should match "Mürren, Switzerland". */
function titlesRelated(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

async function byGeosearch(
  name: string,
  lat: number,
  lng: number
): Promise<PlaceImage | null> {
  const payload = await wikiFetch({
    action: "query",
    generator: "geosearch",
    ggscoord: `${lat}|${lng}`,
    ggsradius: "2000",
    ggslimit: "12",
    prop: "pageimages|coordinates",
    piprop: "thumbnail",
    pithumbsize: String(THUMB_SIZE),
  });

  const pages = pagesOf(payload).filter(
    (p) => p.thumbnail?.source && isPlaceArticle(p.title)
  );
  if (pages.length === 0) return null;

  // Prefer an article whose title matches the place name.
  const named = pages.find((p) => titlesRelated(p.title, name));
  if (named?.thumbnail) {
    return { url: named.thumbnail.source, pageTitle: named.title, strategy: "geosearch" };
  }

  // Otherwise take the geographically closest article that has a photo.
  const withDistance = pages
    .filter((p) => p.coordinates?.[0])
    .map((p) => ({
      page: p,
      distance: haversine(
        { lat, lng },
        { lat: p.coordinates![0].lat, lng: p.coordinates![0].lon }
      ),
    }))
    .sort((a, b) => a.distance - b.distance);

  // Only accept a nearby article; anything further is probably a different site.
  const closest = withDistance[0];
  if (closest && closest.distance <= 400 && closest.page.thumbnail) {
    return {
      url: closest.page.thumbnail.source,
      pageTitle: closest.page.title,
      strategy: "geosearch",
    };
  }

  return null;
}

async function byTitle(name: string): Promise<PlaceImage | null> {
  const payload = await wikiFetch({
    action: "query",
    generator: "search",
    gsrsearch: name,
    gsrlimit: "3",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: String(THUMB_SIZE),
  });

  const pages = pagesOf(payload).filter(
    (p) => p.thumbnail?.source && isPlaceArticle(p.title)
  );

  // Only accept a title that actually relates to the place. Taking the first
  // search hit regardless matched "Ponte Tatiana" to a Brazilian musician and
  // attached her portrait to a bridge.
  const match = pages.find((p) => titlesRelated(p.title, name));
  if (!match?.thumbnail) return null;

  return { url: match.thumbnail.source, pageTitle: match.title, strategy: "title" };
}

export type ImageLookup =
  | { status: "found"; image: PlaceImage }
  | { status: "none" }
  | { status: "unavailable"; reason: string };

export async function findPlaceImage(
  name: string,
  lat: number,
  lng: number
): Promise<ImageLookup> {
  const key = `${NAMESPACE}:${lat.toFixed(4)},${lng.toFixed(4)}:${name.toLowerCase().slice(0, 60)}`;

  try {
    const hit = await prisma.providerCache.findUnique({ where: { key } });
    if (hit && (!hit.expiresAt || hit.expiresAt > new Date())) {
      return hit.payload
        ? { status: "found", image: JSON.parse(hit.payload) as PlaceImage }
        : { status: "none" };
    }
  } catch {
    // Cache problems must not prevent a lookup.
  }

  let found: PlaceImage | null;
  try {
    found = (await byGeosearch(name, lat, lng)) ?? (await byTitle(name));
  } catch (err) {
    // Nothing is cached: the next run should retry rather than inherit a
    // transient outage as a permanent verdict.
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : "provider unavailable",
    };
  }

  try {
    await prisma.providerCache.upsert({
      where: { key },
      create: {
        key,
        namespace: NAMESPACE,
        payload: found ? JSON.stringify(found) : "",
        expiresAt: new Date(Date.now() + TTL_MS),
      },
      update: {
        payload: found ? JSON.stringify(found) : "",
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
  } catch {
    // Best effort.
  }

  return found ? { status: "found", image: found } : { status: "none" };
}
