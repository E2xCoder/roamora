import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { legacyCategoryToId } from "@/lib/taxonomy";
import {
  createPlaceSchema,
  placeQuerySchema,
  PERSONAL_SOURCE_TYPES,
} from "@/server/schemas";
import { parseBody, parseQuery, badRequest, serverError } from "@/server/api-utils";

/**
 * GET /api/places
 *
 * Returns a page of places. Previously this returned the entire table — 9320
 * rows on every load — because the client filtered in the browser. Filtering,
 * bounding-box restriction and pagination now happen in SQL.
 *
 * `pool` separates personal saves from the bulk reference corpus so the two
 * are never silently mixed (spec §33).
 */
export async function GET(request: Request) {
  const parsed = parseQuery(request.url, placeQuerySchema);
  if (!parsed.success) return badRequest(parsed.error);

  const q = parsed.data;

  try {
    const where: Prisma.PlaceWhereInput = { deletedAt: null };

    if (q.pool === "personal") {
      where.sourceType = { in: [...PERSONAL_SOURCE_TYPES] };
    } else if (q.pool === "reference") {
      where.sourceType = "REFERENCE";
    }

    if (q.category && q.category !== "all") {
      where.categoryId = legacyCategoryToId(q.category);
    }
    if (q.search) where.name = { contains: q.search };
    if (q.city) where.city = q.city;

    // Bounding box — only applied when all four edges are present.
    const hasBbox =
      q.north != null && q.south != null && q.east != null && q.west != null;
    if (hasBbox) {
      where.lat = { gte: q.south!, lte: q.north! };
      where.lng = { gte: q.west!, lte: q.east! };
    }

    const rows = await prisma.place.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        category: true,
        categoryId: true,
        subcategory: true,
        notes: true,
        address: true,
        city: true,
        country: true,
        tags: true,
        source: true,
        sourceType: true,
        imageUrl: true,
        locationConfidence: true,
        hiddenGemScore: true,
        estimatedVisitMinutes: true,
      },
    });

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return NextResponse.json({
      places: page.map((p) => ({ ...p, tags: safeParseTags(p.tags) })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      hasMore,
    });
  } catch (err) {
    return serverError(err, "PLACES_QUERY_FAILED");
  }
}

export async function POST(request: Request) {
  const parsed = await parseBody(request, createPlaceSchema);
  if (!parsed.ok) return parsed.response;

  const input = parsed.data;

  try {
    const place = await prisma.place.create({
      data: {
        name: input.name,
        lat: input.lat,
        lng: input.lng,
        category: input.category,
        categoryId: input.categoryId ?? legacyCategoryToId(input.category),
        subcategory: input.subcategory,
        tags: JSON.stringify(input.tags),
        notes: input.notes,
        source: input.source,
        sourceType: input.sourceType,
        locationSource: input.locationSource,
        locationConfidence: input.locationConfidence,
        imageUrl: input.imageUrl,
        website: input.website,
        address: input.address,
        city: input.city,
        country: input.country,
        countryCode: input.countryCode,
        estimatedVisitMinutes: input.estimatedVisitMinutes,
        rating: input.rating,
        isHiddenGem: input.isHiddenGem,
      },
    });

    return NextResponse.json(
      { ...place, tags: safeParseTags(place.tags) },
      { status: 201 }
    );
  } catch (err) {
    return serverError(err, "PLACE_CREATE_FAILED");
  }
}

/** Legacy rows may hold malformed JSON; never let that fail a whole page. */
function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
