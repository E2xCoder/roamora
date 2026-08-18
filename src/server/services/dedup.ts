import "server-only";
import { prisma } from "@/lib/db";
import { haversine } from "@/lib/place-meta";
import { bboxAround } from "@/server/services/geocode";

/**
 * Duplicate detection (spec §14).
 *
 * The same viewpoint discovered through three different videos must become one
 * Place with three PlaceSource rows, not three Places. Matching combines
 * geographic proximity with name similarity; the source is never discarded
 * when merging.
 */

export interface DuplicateMatch {
  placeId: string;
  name: string;
  distanceMeters: number;
  nameSimilarity: number;
  score: number;
  reason: string;
}

/** Places closer than this with a similar name are the same place. */
const SAME_PLACE_METERS = 120;
/** Beyond this, no name similarity is enough. */
const MAX_CANDIDATE_METERS = 600;
const NAME_MATCH_THRESHOLD = 0.72;

export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(
      /\b(the|a|an|le|la|les|el|los|der|die|das|il|lo)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Dice coefficient over bigrams — cheap, and forgiving of word order. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };

  const ax = bigrams(x);
  const bx = bigrams(y);
  let shared = 0;
  for (const [g, count] of ax) {
    const other = bx.get(g);
    if (other) shared += Math.min(count, other);
  }

  const total = x.length - 1 + (y.length - 1);
  return total > 0 ? (2 * shared) / total : 0;
}

/**
 * Finds an existing place that is the same as the incoming one.
 *
 * An exact external-id match on a source wins outright; otherwise proximity
 * and name are combined.
 */
export async function findDuplicate(candidate: {
  name: string;
  lat: number;
  lng: number;
  externalId?: string;
  platform?: string;
  normalizedUrl?: string;
}): Promise<DuplicateMatch | null> {
  // 1. The identical source URL was already saved.
  if (candidate.normalizedUrl) {
    const bySource = await prisma.placeSource.findFirst({
      where: { url: candidate.normalizedUrl, place: { deletedAt: null } },
      include: { place: { select: { id: true, name: true, lat: true, lng: true } } },
    });
    if (bySource?.place) {
      return {
        placeId: bySource.place.id,
        name: bySource.place.name,
        distanceMeters: 0,
        nameSimilarity: 1,
        score: 1,
        reason: "Bu bağlantı zaten kayıtlı",
      };
    }
  }

  // 2. Same platform-native id.
  if (candidate.externalId && candidate.platform) {
    const byExternal = await prisma.placeSource.findFirst({
      where: {
        externalId: candidate.externalId,
        platform: candidate.platform,
        place: { deletedAt: null },
      },
      include: { place: { select: { id: true, name: true, lat: true, lng: true } } },
    });
    if (byExternal?.place) {
      return {
        placeId: byExternal.place.id,
        name: byExternal.place.name,
        distanceMeters: 0,
        nameSimilarity: 1,
        score: 1,
        reason: "Bu içerik zaten kayıtlı",
      };
    }
  }

  // 3. Geographic + name match.
  const box = bboxAround(candidate.lat, candidate.lng, MAX_CANDIDATE_METERS / 1000);
  const nearby = await prisma.place.findMany({
    where: {
      deletedAt: null,
      lat: { gte: box.south, lte: box.north },
      lng: { gte: box.west, lte: box.east },
    },
    select: { id: true, name: true, lat: true, lng: true },
    take: 100,
  });

  let best: DuplicateMatch | null = null;

  for (const place of nearby) {
    const distance = haversine(candidate, place);
    if (distance > MAX_CANDIDATE_METERS) continue;

    const similarity = nameSimilarity(candidate.name, place.name);

    // Very close and clearly the same name.
    const isDuplicate =
      (distance <= SAME_PLACE_METERS && similarity >= NAME_MATCH_THRESHOLD) ||
      (distance <= 30 && similarity >= 0.5);

    if (!isDuplicate) continue;

    // Prefer the closest strong match.
    const score = similarity * (1 - distance / (MAX_CANDIDATE_METERS * 2));
    if (!best || score > best.score) {
      best = {
        placeId: place.id,
        name: place.name,
        distanceMeters: Math.round(distance),
        nameSimilarity: Number(similarity.toFixed(2)),
        score,
        reason: `${Math.round(distance)} m uzakta, benzer isim`,
      };
    }
  }

  return best;
}

/**
 * Attaches a new source to an existing place rather than creating a second
 * copy of it. The place's own fields are left alone — a later import must not
 * silently rewrite what is already there.
 */
export async function attachSourceToPlace(
  placeId: string,
  source: {
    platform: string;
    url?: string;
    title?: string;
    creator?: string;
    description?: string;
    thumbnailUrl?: string;
    externalId?: string;
    metadata?: unknown;
  }
) {
  return prisma.placeSource.create({
    data: {
      placeId,
      platform: source.platform,
      url: source.url,
      title: source.title,
      creator: source.creator,
      description: source.description,
      thumbnailUrl: source.thumbnailUrl,
      externalId: source.externalId,
      metadata: source.metadata ? JSON.stringify(source.metadata) : undefined,
    },
  });
}
