import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (category && category !== "all") where.category = category;
  if (search) where.name = { contains: search };

  const places = await prisma.place.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    places.map((p) => ({ ...p, tags: JSON.parse(p.tags) }))
  );
}

export async function POST(request: Request) {
  const body = await request.json();
  const place = await prisma.place.create({
    data: {
      name: body.name,
      lat: body.lat,
      lng: body.lng,
      category: body.category || "other",
      tags: JSON.stringify(body.tags || []),
      notes: body.notes || "",
      source: body.source || "manual",
      imageUrl: body.imageUrl,
      address: body.address,
      rating: body.rating,
      isHiddenGem: body.isHiddenGem || false,
    },
  });
  return NextResponse.json({ ...place, tags: JSON.parse(place.tags) }, { status: 201 });
}
