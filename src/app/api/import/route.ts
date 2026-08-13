import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseGoogleTakeout } from "@/lib/google-import";

export async function POST(request: Request) {
  const body = await request.json();
  const { jsonContent, source } = body;

  if (source === "google") {
    const places = parseGoogleTakeout(jsonContent);
    const created = await prisma.place.createMany({
      data: places.map((p) => ({
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        category: p.category,
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
