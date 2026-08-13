import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const place = await prisma.place.update({
    where: { id },
    data: {
      name: body.name,
      lat: body.lat,
      lng: body.lng,
      category: body.category,
      tags: body.tags ? JSON.stringify(body.tags) : undefined,
      notes: body.notes,
      source: body.source,
      imageUrl: body.imageUrl,
      address: body.address,
      rating: body.rating,
      isHiddenGem: body.isHiddenGem,
    },
  });
  return NextResponse.json({ ...place, tags: JSON.parse(place.tags) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.place.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
