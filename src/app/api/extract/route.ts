import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { extractFromUrl, extractPlaceWithAI } from "@/lib/extract-place";
import {
  legacyCategoryToId,
  normalizeForSearch,
  AUTO_SAVE_CONFIDENCE,
} from "@/lib/taxonomy";
import { importUrlSchema } from "@/server/schemas";
import { apiError, parseBody, serverError } from "@/server/api-utils";
import { getCapabilities } from "@/server/services/capabilities";
import { geocodeOnce } from "@/server/services/geocode";

export const maxDuration = 60;

/** One step of the ingestion pipeline, reported to the UI (spec §55). */
interface StageResult {
  stage: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

/**
 * POST /api/extract — analyse a URL and report what was found.
 *
 * This endpoint previously returned HTTP 200 with empty fields whenever
 * yt-dlp was missing, which the UI rendered as a blank form. Every stage now
 * reports its own outcome, and a run that discovers nothing usable returns a
 * failure naming the reason rather than an empty success.
 */
export async function POST(request: Request) {
  const parsed = await parseBody(request, importUrlSchema);
  if (!parsed.ok) return parsed.response;

  const { url } = parsed.data;
  const stages: StageResult[] = [];

  try {
    // --- capability check -------------------------------------------------
    const caps = await getCapabilities();
    const ytdlp = caps.find((c) => c.id === "ytdlp");
    const ai = caps.find((c) => c.id === "ai");

    // --- extraction -------------------------------------------------------
    // The capability probe informs the metadata stage's detail below rather
    // than emitting a stage of its own, so each stage appears exactly once.
    const extracted = await extractFromUrl(url);

    const gotMetadata = Boolean(extracted.title || extracted.description);
    stages.push({
      stage: "metadata",
      status: gotMetadata ? "ok" : "failed",
      detail: gotMetadata
        ? `${extracted.platform} · ${extracted.title || "başlıksız"}`
        : ytdlp?.available
          ? "Bu içerikten üstveri okunamadı"
          : ytdlp?.remedy,
    });

    stages.push({
      stage: "media",
      status: extracted.thumbnailPath || extracted.thumbnailUrl ? "ok" : "skipped",
    });

    // --- location from text ----------------------------------------------
    let confidence = extracted.placeName ? 0.6 : 0;
    let locationSource: string | undefined = extracted.placeName
      ? "TEXT"
      : undefined;

    stages.push({
      stage: "location-text",
      status: extracted.placeName ? "ok" : "skipped",
      detail: extracted.placeName,
    });

    // --- location from AI -------------------------------------------------
    if (!extracted.placeName && gotMetadata) {
      if (ai?.available) {
        const aiPlace = await extractPlaceWithAI(
          `${extracted.title} ${extracted.description}`
        );
        if (aiPlace) {
          extracted.placeName = aiPlace;
          confidence = 0.5;
          locationSource = "AI";
        }
        stages.push({
          stage: "location-ai",
          status: aiPlace ? "ok" : "failed",
          detail: aiPlace ?? "AI bir yer adı çıkaramadı",
        });
      } else {
        stages.push({
          stage: "location-ai",
          status: "skipped",
          detail: ai?.remedy ?? ai?.detail,
        });
      }
    }

    // --- geocoding --------------------------------------------------------
    if (extracted.placeName && (extracted.lat == null || extracted.lng == null)) {
      const geo = await geocodeOnce(extracted.placeName);
      if (geo) {
        extracted.lat = geo.lat;
        extracted.lng = geo.lng;
        confidence = Math.min(confidence + 0.25, 0.95);
        locationSource = "GEOCODER";
      }
      stages.push({
        stage: "geocode",
        status: geo ? "ok" : "failed",
        detail: geo?.displayName ?? "Koordinat bulunamadı",
      });
    } else if (extracted.lat != null) {
      stages.push({ stage: "geocode", status: "skipped", detail: "Koordinat zaten var" });
    }

    // --- outcome ----------------------------------------------------------
    const usable = Boolean(extracted.placeName || gotMetadata);

    if (!usable) {
      return apiError(
        ytdlp?.available
          ? "Bu bağlantıdan hiçbir bilgi çıkarılamadı."
          : (ytdlp?.remedy ?? "Üstveri okuyucu kurulu değil."),
        ytdlp?.available ? "EXTRACTION_EMPTY" : "YTDLP_MISSING",
        422,
        { stage: "metadata", details: stages }
      );
    }

    return NextResponse.json({
      extracted: {
        ...extracted,
        locationConfidence: confidence,
        locationSource,
      },
      stages,
      /** Below the threshold the UI must ask before saving (spec §11). */
      needsConfirmation: confidence < AUTO_SAVE_CONFIDENCE,
    });
  } catch (err) {
    return serverError(err, "EXTRACTION_FAILED");
  }
}

const savePlaceSchema = z.object({
  name: z.string().trim().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  category: z.string().trim().default("attraction"),
  notes: z.string().max(5000).default(""),
  sourceUrl: z.string().url().max(2000).optional(),
  thumbnailPath: z.string().max(2000).optional(),
  thumbnailUrl: z.string().max(2000).optional(),
  platform: z.string().trim().default("social"),
  locationConfidence: z.number().min(0).max(1).optional(),
  locationSource: z.string().optional(),
});

/**
 * PUT /api/extract — persist a confirmed place.
 *
 * The source URL used to be accepted and silently discarded; it is now stored
 * as a PlaceSource row so the origin of every save is recoverable (spec §15).
 */
export async function PUT(request: Request) {
  const parsed = await parseBody(request, savePlaceSchema);
  if (!parsed.ok) return parsed.response;

  const input = parsed.data;

  try {
    const place = await prisma.place.create({
      data: {
        name: input.name,
        nameNormalized: normalizeForSearch(input.name),
        lat: input.lat,
        lng: input.lng,
        category: input.category,
        categoryId: legacyCategoryToId(input.category),
        tags: JSON.stringify([input.platform, "saved"]),
        notes: input.notes,
        source: input.platform,
        sourceType: "PERSONAL",
        locationSource: input.locationSource,
        locationConfidence: input.locationConfidence,
        imageUrl: input.thumbnailPath || input.thumbnailUrl || null,
        isHiddenGem: false,
        sources: {
          create: {
            platform: input.platform,
            url: input.sourceUrl,
            title: input.name,
            thumbnailUrl: input.thumbnailUrl,
          },
        },
      },
      include: { sources: true },
    });

    return NextResponse.json(
      { ...place, tags: JSON.parse(place.tags) },
      { status: 201 }
    );
  } catch (err) {
    return serverError(err, "PLACE_SAVE_FAILED");
  }
}
