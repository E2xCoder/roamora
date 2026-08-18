import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseGoogleTakeout, parseGoogleCsv, geocodePlaces } from "@/lib/google-import";
import { legacyCategoryToId, normalizeForSearch } from "@/lib/taxonomy";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json();
  const { jsonContent, source, format, batchStart, batchSize } = body;

  if (source === "google" && format === "csv") {
    const csvPlaces = parseGoogleCsv(jsonContent);
    if (csvPlaces.length === 0) {
      return NextResponse.json({ error: "No places found in CSV" }, { status: 400 });
    }

    const start = batchStart || 0;
    const size = batchSize || 50;
    const batch = csvPlaces.slice(start, start + size);

    const geocoded = await geocodePlaces(batch);

    if (geocoded.length > 0) {
      await prisma.place.createMany({
        data: geocoded.map((p) => ({
          name: p.name,
          nameNormalized: normalizeForSearch(p.name),
          lat: p.lat,
          lng: p.lng,
          category: p.category,
          categoryId: legacyCategoryToId(p.category),
          sourceType: "IMPORTED",
          tags: JSON.stringify(p.tags),
          notes: p.notes,
          source: "google",
          address: p.address,
        })),
      });
    }

    return NextResponse.json({
      imported: geocoded.length,
      batchTotal: batch.length,
      total: csvPlaces.length,
      nextBatch: start + size < csvPlaces.length ? start + size : null,
      processed: Math.min(start + size, csvPlaces.length),
    });
  }

  if (source === "google") {
    const places = parseGoogleTakeout(jsonContent);
    const created = await prisma.place.createMany({
      data: places.map((p) => ({
        name: p.name,
        nameNormalized: normalizeForSearch(p.name),
        lat: p.lat,
        lng: p.lng,
        category: p.category,
        categoryId: legacyCategoryToId(p.category),
        sourceType: "IMPORTED",
        tags: JSON.stringify(p.tags),
        notes: p.notes,
        source: "google",
        address: p.address,
      })),
    });
    return NextResponse.json({
      imported: created.count,
      total: places.length,
    });
  }

  return NextResponse.json({ error: "Unknown source" }, { status: 400 });
}



