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
 * Real, sourced "why visit this place" text — Wikipedia's own article
 * summary, geographically matched to the coordinate, not an LLM paraphrase or
 * invention. This is what backs the itinerary's per-stop explanation (spec
 * §52) with an actual citation instead of a generated-sounding blurb.
 */

const NAMESPACE = "place-summary";
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — article text changes rarely

export interface PlaceSummary {
  text: string;
  pageTitle: string;
  pageUrl: string;
}

export type SummaryLookup =
  | { status: "found"; summary: PlaceSummary }
  | { status: "none" }
  | { status: "unavailable"; reason: string };

async function fetchSummary(name: string, lat: number, lng: number): Promise<PlaceSummary | null> {
  const payload = await wikipediaFetch({
    action: "query",
    generator: "geosearch",
    ggscoord: `${lat}|${lng}`,
    ggsradius: "1500",
    ggslimit: "8",
    prop: "extracts|coordinates",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
  });

  const pages = wikiPagesOf(payload).filter(
    (p) => p.extract && p.extract.trim().length > 20 && isWikiPlaceArticle(p.title)
  );
  if (pages.length === 0) return null;

  const named = pages.find((p) => wikiTitlesRelated(p.title, name));
  const chosen =
    named ??
    pages
      .filter((p) => p.coordinates?.[0])
      .map((p) => ({
        page: p,
        distance: haversine({ lat, lng }, { lat: p.coordinates![0].lat, lng: p.coordinates![0].lon }),
      }))
      .filter((p) => p.distance <= 300) // tighter radius than images: a wrong summary is worse than a wrong photo
      .sort((a, b) => a.distance - b.distance)[0]?.page;

  if (!chosen?.extract) return null;

  return {
    text: chosen.extract.trim(),
    pageTitle: chosen.title,
    pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(chosen.title.replace(/ /g, "_"))}`,
  };
}

export async function findPlaceSummary(
  name: string,
  lat: number,
  lng: number
): Promise<SummaryLookup> {
  const key = `${NAMESPACE}:${lat.toFixed(4)},${lng.toFixed(4)}:${name.toLowerCase().slice(0, 60)}`;

  try {
    const hit = await prisma.providerCache.findUnique({ where: { key } });
    if (hit && (!hit.expiresAt || hit.expiresAt > new Date())) {
      return hit.payload
        ? { status: "found", summary: JSON.parse(hit.payload) as PlaceSummary }
        : { status: "none" };
    }
  } catch {
    // Cache problems must not prevent a lookup.
  }

  let found: PlaceSummary | null;
  try {
    found = await fetchSummary(name, lat, lng);
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

  return found ? { status: "found", summary: found } : { status: "none" };
}
