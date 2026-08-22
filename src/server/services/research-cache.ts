import "server-only";
import { prisma } from "@/lib/db";

/**
 * Generic read-through cache over the existing `ProviderCache` table —
 * extracted from geocode.ts's proven pattern (the third real caller of this
 * exact read/upsert shape: geocode, place-summary, and now official-source
 * resolution / official-fact-page resolution). A negative result (null) is
 * still cached, same as geocode.ts, so a place with no discoverable official
 * site is not silently re-attempted on every single autoplan run — this is
 * exactly what spec §Priority-4/10 asks ("do not repeatedly rediscover the
 * same official URLs").
 */
export async function getCached<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T | null>
): Promise<T | null> {
  const cacheKey = `${namespace}:${key}`;

  try {
    const hit = await prisma.providerCache.findUnique({ where: { key: cacheKey } });
    if (hit && (!hit.expiresAt || hit.expiresAt > new Date())) {
      return hit.payload ? (JSON.parse(hit.payload) as T) : null;
    }
  } catch {
    // A cache failure must never break research — fall through to a real fetch.
  }

  const result = await fetcher();

  try {
    const payload = result != null ? JSON.stringify(result) : "";
    await prisma.providerCache.upsert({
      where: { key: cacheKey },
      create: { key: cacheKey, namespace, payload, expiresAt: new Date(Date.now() + ttlMs) },
      update: { payload, fetchedAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) },
    });
  } catch {
    // Caching is best-effort.
  }

  return result;
}
