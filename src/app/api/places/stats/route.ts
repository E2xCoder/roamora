import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeForSearch } from "@/lib/taxonomy";
import { placeQuerySchema, PERSONAL_SOURCE_TYPES } from "@/server/schemas";
import { parseQuery, badRequest, serverError } from "@/server/api-utils";

/**
 * GET /api/places/stats
 *
 * True totals per category for the current filter.
 *
 * The map used to derive its chips by counting the loaded page, so with a
 * 2000-row page over 9320 places it showed "Tumu (2000)" and every category
 * count was wrong. Counting happens in SQL over the whole pool instead.
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

    if (q.search) where.nameNormalized = { contains: normalizeForSearch(q.search) };
    if (q.city) where.city = q.city;

    const hasBbox =
      q.north != null && q.south != null && q.east != null && q.west != null;
    if (hasBbox) {
      where.lat = { gte: q.south!, lte: q.north! };
      where.lng = { gte: q.west!, lte: q.east! };
    }

    const [total, grouped] = await Promise.all([
      prisma.place.count({ where }),
      prisma.place.groupBy({
        by: ["categoryId"],
        where,
        _count: { _all: true },
        orderBy: { _count: { categoryId: "desc" } },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of grouped) {
      counts[row.categoryId ?? "other"] = row._count._all;
    }

    return NextResponse.json({ total, counts });
  } catch (err) {
    return serverError(err, "PLACE_STATS_FAILED");
  }
}
