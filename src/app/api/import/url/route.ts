import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ingestUrl } from "@/server/services/ingestion";
import { attachSourceToPlace } from "@/server/services/dedup";
import { legacyCategoryToId, normalizeForSearch } from "@/lib/taxonomy";
import { importUrlSchema } from "@/server/schemas";
import { apiError, parseBody, serverError } from "@/server/api-utils";

export const maxDuration = 60;

/**
 * POST /api/import/url — analyse a link and propose a place.
 *
 * Nothing is persisted here. The pipeline returns a proposal plus a per-stage
 * report; the client confirms via PUT. That keeps a low-confidence guess from
 * being saved silently (spec §11).
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, importUrlSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await ingestUrl(parsed.data.url);

    if (!result.ok || !result.proposal) {
      return NextResponse.json(
        {
          error: result.error?.message ?? "İçe aktarma başarısız",
          code: result.error?.code ?? "INGESTION_FAILED",
          stage: result.error?.stage,
          stages: result.stages,
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      proposal: result.proposal,
      stages: result.stages,
    });
  } catch (err) {
    return serverError(err, "INGESTION_FAILED");
  }
}

/**
 * The pipeline emits `placeName` (to sit alongside the source's `title`),
 * while a saved place has a `name`. Accepting either lets a client hand the
 * proposal straight back with only the fields the user edited.
 */
const confirmSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    placeName: z.string().trim().min(1).max(300).optional(),
    lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  category: z.string().trim().min(1).default("attraction"),
  notes: z.string().max(5000).default(""),
  address: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  countryCode: z.string().length(2).optional(),
  locationSource: z.string().optional(),
  locationConfidence: z.number().min(0).max(1).optional(),

  platform: z.string().trim().min(1),
  sourceUrl: z.string().url().max(2000).optional(),
  normalizedUrl: z.string().url().max(2000).optional(),
  title: z.string().max(500).optional(),
  creator: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  thumbnailUrl: z.string().url().max(2000).optional(),
  externalId: z.string().max(200).optional(),

    /** When set, attach the source to this place instead of creating a new one. */
    mergeIntoPlaceId: z.string().optional(),
  })
  .refine((v) => Boolean(v.name ?? v.placeName), {
    message: "name veya placeName gerekli",
    path: ["name"],
  })
  .transform((v) => ({ ...v, name: (v.name ?? v.placeName)! }));

/**
 * PUT /api/import/url — persist a confirmed proposal.
 *
 * When the client accepts a duplicate match, the source is attached to the
 * existing place rather than creating a second copy; the incoming source is
 * never discarded (spec §14).
 */
export async function PUT(request: Request) {
  const parsed = await parseBody(request, confirmSchema);
  if (!parsed.ok) return parsed.response;

  const input = parsed.data;

  try {
    if (input.mergeIntoPlaceId) {
      const target = await prisma.place.findFirst({
        where: { id: input.mergeIntoPlaceId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!target) {
        return apiError(
          "Birleştirilecek yer bulunamadı",
          "MERGE_TARGET_NOT_FOUND",
          404
        );
      }

      const source = await attachSourceToPlace(target.id, {
        platform: input.platform,
        url: input.normalizedUrl ?? input.sourceUrl,
        title: input.title,
        creator: input.creator,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        externalId: input.externalId,
      });

      return NextResponse.json(
        { merged: true, placeId: target.id, placeName: target.name, sourceId: source.id },
        { status: 200 }
      );
    }

    const place = await prisma.place.create({
      data: {
        name: input.name,
        nameNormalized: normalizeForSearch(input.name),
        lat: input.lat,
        lng: input.lng,
        category: input.category,
        categoryId: legacyCategoryToId(input.category),
        notes: input.notes,
        tags: JSON.stringify([input.platform]),
        address: input.address,
        city: input.city,
        country: input.country,
        countryCode: input.countryCode,
        source: input.platform,
        sourceType: "PERSONAL",
        locationSource: input.locationSource,
        locationConfidence: input.locationConfidence,
        imageUrl: input.thumbnailUrl,
        sources: {
          create: {
            platform: input.platform,
            url: input.normalizedUrl ?? input.sourceUrl,
            title: input.title,
            creator: input.creator,
            description: input.description,
            thumbnailUrl: input.thumbnailUrl,
            externalId: input.externalId,
          },
        },
        // Record where each automatically-derived value came from (spec §91).
        provenance: {
          create: [
            {
              field: "lat",
              source: input.locationSource ?? "GEOCODER",
              confidence: input.locationConfidence,
            },
            {
              field: "category",
              source: "AI",
              confidence: 0.6,
            },
          ],
        },
      },
      include: { sources: true },
    });

    return NextResponse.json({ merged: false, place }, { status: 201 });
  } catch (err) {
    return serverError(err, "IMPORT_SAVE_FAILED");
  }
}
