import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findPlaceImage } from "@/server/providers/images/wikimedia";
import { guessCategoryFromText } from "@/server/services/classify";
import { parseBody, serverError } from "@/server/api-utils";

export const maxDuration = 120;

/**
 * POST /api/places/enrich — fetch missing photos for saved places.
 *
 * Runs in explicit, user-triggered batches rather than on page load, so a
 * free community API is never hammered and nothing expensive happens
 * implicitly (spec §8).
 *
 * Only fills gaps: a place that already has an image, or one a previous run
 * found nothing for, is skipped via the provider cache.
 */
const enrichSchema = z.object({
  /** How many places to attempt in this batch. */
  limit: z.number().int().min(1).max(50).default(20),
  pool: z.enum(["personal", "reference", "all"]).default("personal"),
  /** "photos" fetches imagery; "categories" reclassifies uncategorised rows. */
  task: z.enum(["photos", "categories"]).default("photos"),
});

/**
 * Re-runs classification over places stuck on "other".
 *
 * The Takeout importer only ever saw a place name and guessed from a short
 * keyword list, so 72 of 75 imported places landed in "other" and the category
 * filter was useless. The ingestion classifier reads the notes too.
 */
async function reclassify(where: Prisma.PlaceWhereInput, limit: number) {
  const candidates = await prisma.place.findMany({
    // `in` cannot carry null in Prisma; the two cases need separate branches.
    where: {
      ...where,
      OR: [{ categoryId: "other" }, { categoryId: null }],
    },
    select: { id: true, name: true, notes: true, address: true },
    take: limit,
  });

  let changed = 0;
  const results: Array<{ name: string; status: "found" | "none"; via?: string }> = [];

  for (const place of candidates) {
    const category = guessCategoryFromText(
      `${place.notes ?? ""} ${place.address ?? ""}`,
      place.name
    );

    if (category !== "other" && category !== "attraction") {
      await prisma.place.update({
        where: { id: place.id },
        data: { category, categoryId: category, classificationConfidence: 0.6 },
      });
      changed++;
      results.push({ name: place.name, status: "found", via: category });
    } else {
      results.push({ name: place.name, status: "none" });
    }
  }

  return { attempted: candidates.length, found: changed, results };
}

export async function POST(request: Request) {
  const parsed = await parseBody(request, enrichSchema);
  if (!parsed.ok) return parsed.response;

  const { limit, pool, task } = parsed.data;

  const poolFilter: Prisma.PlaceWhereInput =
    pool === "personal"
      ? { sourceType: { in: ["PERSONAL", "IMPORTED", "MANUAL", "DISCOVERED"] } }
      : pool === "reference"
        ? { sourceType: "REFERENCE" }
        : {};

  try {
    if (task === "categories") {
      const result = await reclassify({ deletedAt: null, ...poolFilter }, limit);
      const remaining = await prisma.place.count({
        where: { deletedAt: null, ...poolFilter, categoryId: "other" },
      });
      return NextResponse.json({ ...result, unavailable: 0, remaining });
    }

    const candidates = await prisma.place.findMany({
      where: {
        deletedAt: null,
        OR: [{ imageUrl: null }, { imageUrl: "" }],
        ...(pool === "personal"
          ? { sourceType: { in: ["PERSONAL", "IMPORTED", "MANUAL", "DISCOVERED"] } }
          : pool === "reference"
            ? { sourceType: "REFERENCE" }
            : {}),
      },
      select: { id: true, name: true, lat: true, lng: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    let found = 0;
    let unavailable = 0;
    const results: Array<{
      name: string;
      status: "found" | "none" | "unavailable";
      via?: string;
    }> = [];

    for (const place of candidates) {
      const lookup = await findPlaceImage(place.name, place.lat, place.lng);

      if (lookup.status === "found") {
        await prisma.$transaction([
          prisma.place.update({
            where: { id: place.id },
            data: { imageUrl: lookup.image.url },
          }),
          prisma.media.create({
            data: {
              placeId: place.id,
              type: "image",
              originalUrl: lookup.image.url,
              // Attribution: the Wikipedia article the photo belongs to.
              storagePath: null,
              mimeType: "image/jpeg",
            },
          }),
        ]);
        found++;
        results.push({
          name: place.name,
          status: "found",
          via: lookup.image.pageTitle,
        });
        continue;
      }

      if (lookup.status === "unavailable") {
        unavailable++;
        console.error(`[enrich] ${place.name}: ${lookup.reason}`);
        results.push({ name: place.name, status: "unavailable" });
        // Stop early: continuing would just accumulate more failures against
        // a provider that is currently refusing us.
        if (unavailable >= 3) break;
        continue;
      }

      results.push({ name: place.name, status: "none" });
    }

    const remaining = await prisma.place.count({
      where: {
        deletedAt: null,
        OR: [{ imageUrl: null }, { imageUrl: "" }],
        ...(pool === "personal"
          ? { sourceType: { in: ["PERSONAL", "IMPORTED", "MANUAL", "DISCOVERED"] } }
          : pool === "reference"
            ? { sourceType: "REFERENCE" }
            : {}),
      },
    });

    return NextResponse.json({
      attempted: results.length,
      found,
      unavailable,
      remaining,
      results,
    });
  } catch (err) {
    return serverError(err, "ENRICH_FAILED");
  }
}
