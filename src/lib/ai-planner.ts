import "server-only";
import { z } from "zod";
import { config } from "@/server/config";
import type { TripPlanDay } from "@/types";

/**
 * Trip planning via the configured AI provider.
 *
 * This module previously fabricated a plan when Ollama was unreachable —
 * activities named "Explore {city} - Activity 1" at coordinates 0,0, which
 * render in the Gulf of Guinea. Inventing itinerary data is exactly what
 * spec §98/§99 forbid, so unavailability is now an explicit, typed failure
 * that the caller must surface.
 */

export class PlannerUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlannerUnavailableError";
    this.code = code;
  }
}

interface PlanRequest {
  destination: string;
  days: number;
  startDate: string;
  preferences: string[];
  /** Candidate places, already filtered to the destination by the caller. */
  savedPlaces: Array<{ name: string; lat: number; lng: number; category: string }>;
}

const activitySchema = z.object({
  placeName: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  timeSlot: z.string().min(1),
  notes: z.string().default(""),
  order: z.number().int().min(1),
});

const planSchema = z
  .array(
    z.object({
      dayNumber: z.number().int().min(1),
      date: z.string().min(1),
      activities: z.array(activitySchema).min(1),
    })
  )
  .min(1);

export async function generateTripPlan(req: PlanRequest): Promise<TripPlanDay[]> {
  if (config.AI_PROVIDER === "none") {
    throw new PlannerUnavailableError(
      "AI_DISABLED",
      "AI sağlayıcı devre dışı (AI_PROVIDER=none)."
    );
  }

  if (req.savedPlaces.length === 0) {
    throw new PlannerUnavailableError(
      "NO_CANDIDATE_PLACES",
      `${req.destination} için kayıtlı yer bulunamadı. Önce bu bölgede yer kaydet.`
    );
  }

  const prompt = buildPrompt(req);

  let raw: string;
  try {
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new PlannerUnavailableError(
        "AI_HTTP_ERROR",
        `Ollama ${res.status} döndürdü (${config.OLLAMA_BASE_URL}).`
      );
    }

    raw = (await res.json()).response ?? "";
  } catch (err) {
    if (err instanceof PlannerUnavailableError) throw err;
    throw new PlannerUnavailableError(
      "AI_UNREACHABLE",
      `Ollama'ya ulaşılamadı (${config.OLLAMA_BASE_URL}). Çalıştığından ve "${config.OLLAMA_MODEL}" modelinin kurulu olduğundan emin ol.`
    );
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new PlannerUnavailableError(
      "AI_BAD_OUTPUT",
      "AI geçerli bir plan üretmedi."
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(match[0]);
  } catch {
    throw new PlannerUnavailableError(
      "AI_BAD_OUTPUT",
      "AI çıktısı geçerli JSON değil."
    );
  }

  const validated = planSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new PlannerUnavailableError(
      "AI_SCHEMA_MISMATCH",
      "AI çıktısı beklenen plan yapısına uymuyor."
    );
  }

  // The model may invent coordinates. Snap every activity back onto a real
  // candidate place; anything that matches nothing is dropped rather than
  // trusted (spec §40).
  return snapToKnownPlaces(validated.data, req.savedPlaces);
}

function buildPrompt(req: PlanRequest): string {
  const places = req.savedPlaces
    .map((p) => `- ${p.name} (${p.category}) [${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}]`)
    .join("\n");

  return `Create a ${req.days}-day trip plan for ${req.destination} starting ${req.startDate}.
Preferences: ${req.preferences.join(", ") || "general sightseeing"}.

Use ONLY places from this list. Copy their names and coordinates exactly:
${places}

Return ONLY a JSON array, no prose:
[{"dayNumber":1,"date":"${req.startDate}","activities":[{"placeName":"<exact name from list>","lat":<exact>,"lng":<exact>,"timeSlot":"09:00-11:00","notes":"<short tip>","order":1}]}]

Include 4-6 activities per day. Order each day to minimise travel between consecutive stops.`;
}

/**
 * Replaces model-supplied coordinates with those of the matching candidate.
 * Guarantees every returned coordinate came from the database, never the LLM.
 */
function snapToKnownPlaces(
  plan: z.infer<typeof planSchema>,
  candidates: PlanRequest["savedPlaces"]
): TripPlanDay[] {
  const byName = new Map(candidates.map((p) => [normalize(p.name), p]));

  const days = plan.map((day) => {
    const activities = day.activities
      .map((a) => {
        const known = byName.get(normalize(a.placeName));
        if (!known) return null;
        return {
          placeName: known.name,
          lat: known.lat,
          lng: known.lng,
          timeSlot: a.timeSlot,
          notes: a.notes,
          order: a.order,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .sort((x, y) => x.order - y.order)
      .map((a, i) => ({ ...a, order: i + 1 }));

    return { dayNumber: day.dayNumber, date: day.date, activities };
  });

  const kept = days.filter((d) => d.activities.length > 0);
  if (kept.length === 0) {
    throw new PlannerUnavailableError(
      "AI_NO_MATCHING_PLACES",
      "AI, kayıtlı yerlerinle eşleşmeyen bir plan üretti."
    );
  }
  return kept;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
