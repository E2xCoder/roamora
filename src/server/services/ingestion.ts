import "server-only";
import { providerFor } from "@/server/providers/source/providers";
import { normalizeUrl, type SourceMetadata } from "@/server/providers/source/types";
import { checkImportUrl } from "@/server/services/url-safety";
import {
  combineConfidence,
  extractLocationCandidates,
  type LocationCandidate,
} from "@/server/services/location-extraction";
import { geocodeOnce, type GeocodeResult } from "@/server/services/geocode";
import { findDuplicate, type DuplicateMatch } from "@/server/services/dedup";
import { getCapabilities } from "@/server/services/capabilities";
import { checkBoilerplate } from "@/server/services/boilerplate";
import { extractPlaceWithAI } from "@/lib/extract-place";
import { AUTO_SAVE_CONFIDENCE, type LocationSource } from "@/lib/taxonomy";
import { guessCategoryFromText } from "@/server/services/classify";

/**
 * The ingestion pipeline (spec §9).
 *
 *   RECEIVE -> DETECT SOURCE -> FETCH METADATA -> EXTRACT TEXT
 *     -> EXTRACT LOCATION -> GEOCODE -> CLASSIFY -> DEDUPE -> PROPOSE
 *
 * Every stage reports its own outcome so a failure names the step that failed
 * rather than collapsing into a generic error (spec §55). The pipeline never
 * persists on its own — it returns a proposal the caller confirms, so a
 * low-confidence guess is never saved silently (spec §11).
 */

export type StageStatus = "ok" | "skipped" | "failed";

export interface Stage {
  stage: string;
  status: StageStatus;
  detail?: string;
}

export interface IngestionProposal {
  platform: string;
  sourceUrl: string;
  normalizedUrl: string;
  title?: string;
  description?: string;
  creator?: string;
  thumbnailUrl?: string;
  externalId?: string;

  placeName?: string;
  lat?: number;
  lng?: number;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;

  category: string;
  locationSource?: LocationSource;
  locationConfidence: number;
  /** Alternatives the user can pick instead of the top guess. */
  alternatives: Array<{ name: string; lat: number; lng: number; label: string }>;

  duplicate?: DuplicateMatch;
  /** True when confidence is high enough to save without asking. */
  autoSaveEligible: boolean;
}

export interface IngestionResult {
  ok: boolean;
  stages: Stage[];
  proposal?: IngestionProposal;
  error?: { message: string; code: string; stage: string };
}

export async function ingestUrl(rawUrl: string): Promise<IngestionResult> {
  const stages: Stage[] = [];
  const fail = (
    stage: string,
    code: string,
    message: string
  ): IngestionResult => ({
    ok: false,
    stages,
    error: { message, code, stage },
  });

  // --- 1. validate ---------------------------------------------------------
  const check = await checkImportUrl(rawUrl);
  if (!check.ok || !check.url) {
    stages.push({ stage: "validate", status: "failed", detail: check.reason });
    return fail("validate", "INVALID_URL", check.reason ?? "Geçersiz URL");
  }
  stages.push({ stage: "validate", status: "ok", detail: check.url.hostname });

  // --- 2. detect source ----------------------------------------------------
  const provider = providerFor(check.url);
  stages.push({ stage: "detect", status: "ok", detail: provider.id });

  // --- 3. fetch metadata ---------------------------------------------------
  const fetched = await provider.fetchMetadata(check.url);
  if (!fetched.ok) {
    stages.push({ stage: "metadata", status: "failed", detail: fetched.reason });

    // yt-dlp can sometimes succeed where the keyless path cannot; say so.
    const caps = await getCapabilities();
    const ytdlp = caps.find((c) => c.id === "ytdlp");
    const hint =
      ytdlp && !ytdlp.available && (provider.id === "tiktok" || provider.id === "instagram")
        ? ` ${ytdlp.remedy}`
        : "";

    return fail("metadata", "METADATA_UNAVAILABLE", fetched.reason + hint);
  }

  const meta = fetched.data;

  // A deleted or private post still serves the platform's generic chrome.
  // Feeding that into extraction produced confident nonsense, so it is
  // rejected here — unless the source gave coordinates outright, which are
  // trustworthy regardless of the surrounding text.
  const hasExplicitCoords = meta.lat != null && meta.lng != null;
  const boilerplate = checkBoilerplate(meta.title, meta.description);

  if (boilerplate.isBoilerplate && !hasExplicitCoords) {
    stages.push({
      stage: "metadata",
      status: "failed",
      detail: boilerplate.reason,
    });

    const caps = await getCapabilities();
    const ytdlp = caps.find((c) => c.id === "ytdlp");
    const hint =
      ytdlp && !ytdlp.available && (provider.id === "tiktok" || provider.id === "instagram")
        ? ` ${ytdlp.remedy}`
        : "";

    return fail(
      "metadata",
      "BOILERPLATE_ONLY",
      `${boilerplate.reason}.${hint}`
    );
  }

  stages.push({
    stage: "metadata",
    status: "ok",
    detail: `${meta.strategy} · ${meta.title?.slice(0, 60) || "başlıksız"}`,
  });

  stages.push({
    stage: "media",
    status: meta.thumbnailUrl ? "ok" : "skipped",
    detail: meta.thumbnailUrl ? "Kapak görseli bulundu" : "Görsel yok",
  });

  // --- 4. locate -----------------------------------------------------------
  const located = await locate(meta, stages);

  if (!located) {
    return fail(
      "location",
      "NO_LOCATION",
      "İçerikten bir yer çıkarılamadı. Yer adını elle girebilirsin."
    );
  }

  // --- 5. classify ---------------------------------------------------------
  const text = `${meta.title ?? ""} ${meta.description ?? ""}`;
  const category = guessCategoryFromText(text, located.name);
  stages.push({ stage: "classify", status: "ok", detail: category });

  // --- 6. dedupe -----------------------------------------------------------
  const duplicate = await findDuplicate({
    name: located.name,
    lat: located.lat,
    lng: located.lng,
    externalId: meta.externalId,
    platform: meta.platform,
    normalizedUrl: meta.normalizedUrl,
  });
  stages.push({
    stage: "dedupe",
    status: duplicate ? "ok" : "skipped",
    detail: duplicate
      ? `Zaten kayıtlı: ${duplicate.name} (${duplicate.reason})`
      : "Benzer kayıt yok",
  });

  return {
    ok: true,
    stages,
    proposal: {
      platform: meta.platform,
      sourceUrl: meta.url,
      normalizedUrl: meta.normalizedUrl,
      title: meta.title,
      description: meta.description?.slice(0, 1000),
      creator: meta.creator,
      thumbnailUrl: meta.thumbnailUrl,
      externalId: meta.externalId,

      placeName: located.name,
      lat: located.lat,
      lng: located.lng,
      address: located.address,
      city: located.city,
      country: located.country,
      countryCode: located.countryCode,

      category,
      locationSource: located.source,
      locationConfidence: located.confidence,
      alternatives: located.alternatives,

      duplicate: duplicate ?? undefined,
      autoSaveEligible:
        located.confidence >= AUTO_SAVE_CONFIDENCE && !duplicate,
    },
  };
}

interface Located {
  name: string;
  lat: number;
  lng: number;
  confidence: number;
  source: LocationSource;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  alternatives: Array<{ name: string; lat: number; lng: number; label: string }>;
}

async function locate(
  meta: SourceMetadata,
  stages: Stage[]
): Promise<Located | null> {
  // --- strongest: the source states coordinates outright -------------------
  if (meta.lat != null && meta.lng != null) {
    stages.push({
      stage: "location",
      status: "ok",
      detail: `Kaynak koordinat verdi (${meta.strategy})`,
    });

    const name = meta.placeHints?.[0] ?? meta.title ?? "İsimsiz yer";
    return {
      name,
      lat: meta.lat,
      lng: meta.lng,
      confidence: combineConfidence(0.9, true, true),
      source: "EXPLICIT_COORDINATE",
      alternatives: [],
    };
  }

  // --- text candidates -----------------------------------------------------
  const text = [meta.title, meta.description, ...(meta.placeHints ?? [])]
    .filter(Boolean)
    .join(" \n ");

  const candidates = extractLocationCandidates(text);
  stages.push({
    stage: "location",
    status: candidates.length ? "ok" : "skipped",
    detail: candidates.length
      ? candidates.slice(0, 3).map((c) => c.name).join(" · ")
      : "Metinde yer adı bulunamadı",
  });

  // --- AI, only if text alone found nothing usable -------------------------
  let aiCandidate: LocationCandidate | null = null;
  if (candidates.length === 0 && text.trim()) {
    const caps = await getCapabilities();
    const ai = caps.find((c) => c.id === "ai");

    if (ai?.available) {
      const guess = await extractPlaceWithAI(text);
      if (guess) {
        aiCandidate = {
          name: guess,
          confidence: 0.45,
          strategy: "ai",
          source: "AI",
        };
      }
      stages.push({
        stage: "location-ai",
        status: guess ? "ok" : "failed",
        detail: guess ?? "AI bir yer adı çıkaramadı",
      });
    } else {
      stages.push({
        stage: "location-ai",
        status: "skipped",
        detail: ai?.remedy ?? ai?.detail,
      });
    }
  }

  const ordered = aiCandidate ? [aiCandidate, ...candidates] : candidates;
  if (ordered.length === 0) return null;

  // --- geocode, best candidate first ---------------------------------------
  const resolved: Array<{ candidate: LocationCandidate; geo: GeocodeResult }> = [];

  for (const candidate of ordered.slice(0, 4)) {
    const geo = await geocodeOnce(candidate.name);
    if (geo) resolved.push({ candidate, geo });
    if (resolved.length >= 3) break;
  }

  stages.push({
    stage: "geocode",
    status: resolved.length ? "ok" : "failed",
    detail: resolved.length
      ? resolved[0].geo.displayName.slice(0, 80)
      : "Hiçbir aday için koordinat bulunamadı",
  });

  if (resolved.length === 0) return null;

  const [top, ...rest] = resolved;

  return {
    name: top.candidate.name,
    lat: top.geo.lat,
    lng: top.geo.lng,
    confidence: combineConfidence(top.candidate.confidence, true),
    source: top.candidate.source === "AI" ? "AI" : "GEOCODER",
    address: top.geo.displayName,
    city: top.geo.city,
    country: top.geo.country,
    countryCode: top.geo.countryCode,
    alternatives: rest.map((r) => ({
      name: r.candidate.name,
      lat: r.geo.lat,
      lng: r.geo.lng,
      label: r.geo.displayName.slice(0, 90),
    })),
  };
}

export { normalizeUrl };
