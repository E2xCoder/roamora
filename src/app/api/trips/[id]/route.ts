import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trip = await prisma.trip.findUnique({
    where: { id },
    include: {
      days: {
        include: { activities: { orderBy: { order: "asc" } } },
        orderBy: { dayNumber: "asc" },
      },
    },
  });
  if (!trip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ...trip, preferences: JSON.parse(trip.preferences) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.trip.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
