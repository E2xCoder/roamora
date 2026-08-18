import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateTripPlan, PlannerUnavailableError } from "@/lib/ai-planner";
import { z } from "zod";
import { apiError, parseBody, serverError } from "@/server/api-utils";
import { bboxAround, geocodeOnce } from "@/server/services/geocode";

const createTripSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD bekleniyor"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD bekleniyor"),
  preferences: z.array(z.string().trim().min(1)).max(20).default([]),
});

/** Places within ~30 km of the destination, personal saves first. */
const CANDIDATE_RADIUS_KM = 30;
const CANDIDATE_LIMIT = 60;

async function findCandidatePlaces(destination: string) {
  const geo = await geocodeOnce(destination);
  if (!geo) return [];

  const box = bboxAround(geo.lat, geo.lng, CANDIDATE_RADIUS_KM);

  const rows = await prisma.place.findMany({
    where: {
      deletedAt: null,
      lat: { gte: box.south, lte: box.north },
      lng: { gte: box.west, lte: box.east },
    },
    select: { name: true, lat: true, lng: true, category: true, sourceType: true },
    take: CANDIDATE_LIMIT * 4,
  });

  // The user's own saves outrank the bulk reference corpus (spec §100).
  const rank = (t: string) => (t === "REFERENCE" ? 1 : 0);
  return rows
    .sort((a, b) => rank(a.sourceType) - rank(b.sourceType))
    .slice(0, CANDIDATE_LIMIT)
    .map(({ name, lat, lng, category }) => ({ name, lat, lng, category }));
}

export async function GET() {
  try {
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
      trips.map((t) => ({ ...t, preferences: safeParse(t.preferences) }))
    );
  } catch (err) {
    return serverError(err, "TRIPS_QUERY_FAILED");
  }
}

function safeParse(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  const parsed = await parseBody(request, createTripSchema);
  if (!parsed.ok) return parsed.response;

  const { destination, startDate, endDate, preferences } = parsed.data;

  const start = new Date(startDate);
  const end = new Date(endDate);
  const days =
    Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return apiError(
      "Tarih aralığı geçersiz (1-30 gün olmalı)",
      "INVALID_DATE_RANGE",
      400
    );
  }

  // Candidate places must be near the destination. Previously every row in the
  // table was loaded and pushed into the prompt — 9320 places, far beyond any
  // usable context window.
  let candidates: Array<{ name: string; lat: number; lng: number; category: string }>;
  try {
    candidates = await findCandidatePlaces(destination);
  } catch (err) {
    return serverError(err, "CANDIDATE_LOOKUP_FAILED");
  }

  if (candidates.length === 0) {
    return apiError(
      `"${destination}" çevresinde kayıtlı yer bulunamadı. Önce oraya yer kaydet ya da keşif havuzundan ekle.`,
      "NO_CANDIDATE_PLACES",
      422,
      { stage: "candidate-selection" }
    );
  }

  let plan;
  try {
    plan = await generateTripPlan({
      destination,
      days,
      startDate,
      preferences,
      savedPlaces: candidates,
    });
  } catch (err) {
    // Planner unavailability is reported, never replaced with invented data.
    if (err instanceof PlannerUnavailableError) {
      return apiError(err.message, err.code, 503, { stage: "ai-planning" });
    }
    return serverError(err, "TRIP_GENERATION_FAILED");
  }

  try {
    const trip = await prisma.trip.create({
    data: {
      destination,
      startDate,
      endDate,
      preferences: JSON.stringify(preferences),
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
      { ...trip, preferences: safeParse(trip.preferences) },
      { status: 201 }
    );
  } catch (err) {
    return serverError(err, "TRIP_PERSIST_FAILED");
  }
}
