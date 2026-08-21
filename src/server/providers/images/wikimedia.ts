import "server-only";
import { prisma } from "@/lib/db";
import { haversine } from "@/lib/place-meta";
import {
  wikipediaFetch,
  wikiPagesOf,
  isWikiPlaceArticle,
  wikiTitlesRelated,
} from "@/server/providers/wikipedia-client";

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
 * photo is not looked up repeatedly. Request throttling is shared with the
 * place-description lookup via `wikipedia-client` — see that module for why.
 */

const NAMESPACE = "place-image";
const TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 days
const THUMB_SIZE = 800;

export interface PlaceImage {
  url: string;
  /** Wikipedia article the image came from, for attribution. */
  pageTitle: string;
  strategy: "geosearch" | "title";
}

async function byGeosearch(
  name: string,
  lat: number,
  lng: number
): Promise<PlaceImage | null> {
  const payload = await wikipediaFetch({
    action: "query",
    generator: "geosearch",
    ggscoord: `${lat}|${lng}`,
    ggsradius: "2000",
    ggslimit: "12",
    prop: "pageimages|coordinates",
    piprop: "thumbnail",
    pithumbsize: String(THUMB_SIZE),
  });

  const pages = wikiPagesOf(payload).filter(
    (p) => p.thumbnail?.source && isWikiPlaceArticle(p.title)
  );
  if (pages.length === 0) return null;

  const named = pages.find((p) => wikiTitlesRelated(p.title, name));
  if (named?.thumbnail) {
    return { url: named.thumbnail.source, pageTitle: named.title, strategy: "geosearch" };
  }

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
  const payload = await wikipediaFetch({
    action: "query",
    generator: "search",
    gsrsearch: name,
    gsrlimit: "3",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: String(THUMB_SIZE),
  });

  const pages = wikiPagesOf(payload).filter(
    (p) => p.thumbnail?.source && isWikiPlaceArticle(p.title)
  );

  const match = pages.find((p) => wikiTitlesRelated(p.title, name));
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
