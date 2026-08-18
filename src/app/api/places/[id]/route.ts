import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { legacyCategoryToId, normalizeForSearch } from "@/lib/taxonomy";
import { updatePlaceSchema } from "@/server/schemas";
import { apiError, parseBody, serverError } from "@/server/api-utils";
import { bboxAround } from "@/server/services/geocode";

/**
 * GET /api/places/:id — a place with everything needed for its detail page:
 * why it was saved, what media came with it, and what else is nearby.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const place = await prisma.place.findFirst({
      where: { id, deletedAt: null },
      include: {
        sources: { orderBy: { savedAt: "desc" } },
        media: { orderBy: { createdAt: "desc" } },
        categoryRef: true,
        placeTags: { include: { tag: true } },
        provenance: true,
        visits: { orderBy: { visitedAt: "desc" } },
      },
    });

    if (!place) {
      return apiError("Yer bulunamadı", "PLACE_NOT_FOUND", 404);
    }

    // Nearby saved places — the "what else is around here" panel.
    const box = bboxAround(place.lat, place.lng, 3);
    const nearby = await prisma.place.findMany({
      where: {
        id: { not: place.id },
        deletedAt: null,
        lat: { gte: box.south, lte: box.north },
        lng: { gte: box.west, lte: box.east },
      },
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        category: true,
        categoryId: true,
        sourceType: true,
        imageUrl: true,
      },
      take: 12,
    });

    return NextResponse.json({
      ...place,
      tags: place.placeTags.map((pt) => pt.tag.name),
      nearby,
    });
  } catch (err) {
    return serverError(err, "PLACE_QUERY_FAILED");
  }
}

/**
 * PATCH /api/places/:id
 *
 * Manual edits are authoritative: each changed field records MANUAL
 * provenance so later automated passes never overwrite them (spec §90, §91).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = await parseBody(request, updatePlaceSchema);
  if (!parsed.ok) return parsed.response;

  const input = parsed.data;

  try {
    const existing = await prisma.place.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return apiError("Yer bulunamadı", "PLACE_NOT_FOUND", 404);

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (key === "tags") {
        data.tags = JSON.stringify(value);
      } else {
        data[key] = value;
      }
    }
    // Keep the search column in step with a renamed place.
    if (typeof input.name === "string") {
      data.nameNormalized = normalizeForSearch(input.name);
    }
    if (input.category && !input.categoryId) {
      data.categoryId = legacyCategoryToId(input.category);
    }

    const place = await prisma.place.update({ where: { id }, data });

    // Record that a human set these values.
    const editedFields = Object.keys(data);
    await Promise.all(
      editedFields.map((field) =>
        prisma.fieldProvenance.upsert({
          where: { placeId_field: { placeId: id, field } },
          create: { placeId: id, field, source: "MANUAL", confidence: 1 },
          update: { source: "MANUAL", confidence: 1, verifiedAt: new Date() },
        })
      )
    );

    return NextResponse.json({ ...place, tags: safeParseTags(place.tags) });
  } catch (err) {
    return serverError(err, "PLACE_UPDATE_FAILED");
  }
}

/** Kept for the existing map UI, which still issues PUT. */
export const PUT = PATCH;

/**
 * DELETE /api/places/:id — soft delete, so a place removed by accident can be
 * recovered and its sources are never lost (spec §57, §89).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const existing = await prisma.place.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return apiError("Yer bulunamadı", "PLACE_NOT_FOUND", 404);

    await prisma.place.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "PLACE_DELETE_FAILED");
  }
}

function safeParseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
