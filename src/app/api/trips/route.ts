import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateTripPlan } from "@/lib/ai-planner";

export async function GET() {
  const trips = await prisma.trip.findMany({
    include: {
      days: {
        include: { activities: { orderBy: { order: "asc" } } },
        orderBy: { dayNumber: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(
    trips.map((t) => ({ ...t, preferences: JSON.parse(t.preferences) }))
  );
}

export async function POST(request: Request) {
  const body = await request.json();
  const { destination, startDate, endDate, preferences } = body;

  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  const savedPlaces = await prisma.place.findMany();
  const nearbyPlaces = savedPlaces.map((p) => ({
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    category: p.category,
  }));

  const plan = await generateTripPlan({
    destination,
    days,
    startDate,
    preferences: preferences || [],
    savedPlaces: nearbyPlaces,
  });

  const trip = await prisma.trip.create({
    data: {
      destination,
      startDate,
      endDate,
      preferences: JSON.stringify(preferences || []),
      status: "draft",
      days: {
        create: plan.map((day) => ({
          dayNumber: day.dayNumber,
          date: day.date,
          activities: {
            create: day.activities.map((act) => ({
              placeName: act.placeName,
              lat: act.lat,
              lng: act.lng,
              timeSlot: act.timeSlot,
              order: act.order,
              notes: act.notes,
            })),
          },
        })),
      },
    },
    include: {
      days: {
        include: { activities: { orderBy: { order: "asc" } } },
        orderBy: { dayNumber: "asc" },
      },
    },
  });

  return NextResponse.json(
    { ...trip, preferences: JSON.parse(trip.preferences) },
    { status: 201 }
  );
}
