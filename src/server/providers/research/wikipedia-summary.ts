import "server-only";
import { prisma } from "@/lib/db";
import {
  wikipediaFetch,
  wikiPagesOf,
  isWikiPlaceArticle,
  wikiTitlesRelated,
  type WikiPage,
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

/**
 * Entity identity, not geographic proximity, is what makes a summary true of
 * a place. A nearby-but-unrelated article (e.g. a museum two doors down from
 * a bar with no Wikipedia page of its own) used to be accepted as a "close
 * enough" fallback — that is exactly how a bar ends up describing itself
 * with a museum's history. No name match means no description, never a
 * plausible-looking wrong one. Exported as its own pure function so this
 * exact regression stays covered by a real, network-free unit test.
 */
export function selectNamedPage(pages: WikiPage[], name: string): WikiPage | null {
  return pages.find((p) => wikiTitlesRelated(p.title, name)) ?? null;
}

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

  const named = selectNamedPage(pages, name);
  if (!named?.extract) return null;

  return {
    text: named.extract.trim(),
    pageTitle: named.title,
    pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(named.title.replace(/ /g, "_"))}`,
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
