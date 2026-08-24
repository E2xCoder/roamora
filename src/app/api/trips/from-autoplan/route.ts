import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody, serverError } from "@/server/api-utils";

/**
 * POST /api/trips/from-autoplan — persists an already-computed real
 * itinerary (one or more days, each a genuine autoplan()/planTripOptions()
 * result the client already polled to completion via
 * /api/itinerary/autoplan or /api/itinerary/autoplan/options) into the
 * existing Trip/TripDay/TripActivity tables.
 *
 * Deliberately separate from the autoplan job endpoints themselves: those
 * run the real, potentially multi-minute research/optimization pipeline in
 * the background (see job-runner.ts) and must never block on a database
 * write too. This endpoint does no planning of its own — it only maps an
 * already-real OptimizeResult's stops onto TripActivity rows, which already
 * had arrivalTime/departureTime/travelSeconds/travelMeters columns from an
 * earlier phase's optimizer-output design, so no schema change was needed.
 *
 * Keeps every existing trip-list/detail/delete flow (GET/DELETE /api/trips)
 * working unchanged — a trip created this way is indistinguishable in shape
 * from one created by the older POST /api/trips (still present, unused by
 * the UI now, not deleted).
 */

const stopSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  order: z.number().int().min(1),
  arrivalTime: z.string(),
  departureTime: z.string(),
  travelFromPrevMeters: z.number().min(0).default(0),
  travelFromPrevSeconds: z.number().min(0).default(0),
});

const provenanceSchema = z.object({
  stopId: z.string(),
  category: z.string().optional(),
  summaryText: z.string().optional(),
});

const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD bekleniyor"),
  stops: z.array(stopSchema).max(20),
  provenance: z.array(provenanceSchema).max(20).optional().default([]),
  /**
   * The real restaurant/hiddenGems/weather/departureSafety/budget/conflicts
   * subset of this day's already-computed AutoplanResult — display data
   * only, never re-validated field-by-field here (it already went through
   * autoplan()'s own real guards to get this far; this endpoint's job is
   * persistence, not re-research). Capped so a client can't stuff arbitrary
   * data into the database under this key.
   */
  research: z.record(z.string(), z.unknown()).optional(),
});

const persistSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferences: z.array(z.string().trim().min(1)).max(20).default([]),
  profile: z.enum(["foot", "bike", "car", "transit"]).default("foot"),
  days: z.array(daySchema).min(1).max(30),
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, persistSchema);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const hasAnyStop = input.days.some((d) => d.stops.length > 0);
  if (!hasAnyStop) {
    return apiError(
      "Kaydedilecek gerçek bir durak yok — hiçbir gün için geçerli bir rota hesaplanmadı.",
      "NO_STOPS_TO_SAVE",
      422
    );
  }

  const MAX_RESEARCH_JSON_BYTES = 200_000;
  for (const day of input.days) {
    if (day.research && JSON.stringify(day.research).length > MAX_RESEARCH_JSON_BYTES) {
      return apiError("Araştırma verisi beklenenden çok büyük", "RESEARCH_TOO_LARGE", 413);
    }
  }

  try {
    const trip = await prisma.trip.create({
      data: {
        destination: input.destination,
        startDate: input.startDate,
        endDate: input.endDate,
        preferences: JSON.stringify(input.preferences),
        status: "draft",
        days: {
          create: input.days.map((day, i) => ({
            dayNumber: i + 1,
            date: day.date,
            researchData: day.research ? JSON.stringify(day.research) : null,
            activities: {
              create: day.stops.map((stop) => {
                const prov = day.provenance.find((p) => p.stopId === stop.id);
                return {
                  placeName: stop.name,
                  lat: stop.lat,
                  lng: stop.lng,
                  timeSlot: `${stop.arrivalTime}-${stop.departureTime}`,
                  order: stop.order,
                  // Real, sourced summary when the research pipeline found
                  // one — never an invented description.
                  notes: prov?.summaryText ?? "",
                  arrivalTime: stop.arrivalTime,
                  departureTime: stop.departureTime,
                  travelSeconds: Math.round(stop.travelFromPrevSeconds),
                  travelMeters: Math.round(stop.travelFromPrevMeters),
                  travelMode: input.profile,
                  inclusionReason: prov?.category
                    ? `otonom keşif — ${prov.category}`
                    : "otonom keşif",
                };
              }),
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
      {
        ...trip,
        preferences: safeParseArray(trip.preferences),
        days: trip.days.map((d) => ({ ...d, research: safeParseObject(d.researchData) })),
      },
      { status: 201 }
    );
  } catch (err) {
    return serverError(err, "TRIP_PERSIST_FAILED");
  }
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
