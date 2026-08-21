import "server-only";
import { geocodeOnce } from "@/server/services/geocode";
import { overpassDiscovery } from "@/server/providers/discovery/overpass-discovery";
import { scoreCandidates, pruneAndDiversify } from "@/server/services/discovery-scoring";
import { resolveOpeningHoursForDate, widestWindow } from "@/lib/opening-hours";
import { findPlaceSummary } from "@/server/providers/research/wikipedia-summary";
import { searxngProvider, SearchUnavailableError } from "@/server/providers/research/searxng";
import {
  extractFactsFromText,
  looseTextToOsmSyntax,
  ExtractionUnavailableError,
} from "@/server/services/fact-extraction";
import { fetchTextCapped } from "@/server/services/url-safety";
import { fetchMatrix } from "@/server/services/osrm-matrix";
import {
  optimizeItinerary,
  type StopInput,
  type OptimizeResult,
} from "@/server/services/itinerary-optimizer";
import { getCapabilities } from "@/server/services/capabilities";
import { config } from "@/server/config";

/**
 * Autonomous discovery + enrichment, feeding the existing deterministic
 * optimizer.
 *
 * USER PARAMETERS → OSM DISCOVERY → SCORE/PRUNE → OPENING-HOUR RESOLUTION
 *   → (optional) WEB RESEARCH ENRICHMENT → WIKIPEDIA SUMMARY
 *   → EXISTING OPTIMIZER (unchanged) → ITINERARY + SOURCE/CONFIDENCE
 *
 * The optimizer itself is reused as-is — this module's entire job is to
 * produce the `StopInput[]` it already knows how to consume, without the user
 * having typed a single coordinate, opening hour or price by hand. Every fact
 * that could not be verified stays unset rather than guessed; the optimizer's
 * own "costKnown" / conflict reporting already refuses to invent totals, so
 * this layer does not need to duplicate that logic.
 */

export interface AutoplanRequest {
  destination: string;
  date: string; // YYYY-MM-DD
  arrivalTime: string; // HH:MM
  departureTime: string; // HH:MM
  startLocation?: { lat: number; lng: number; name?: string };
  endLocation?: { lat: number; lng: number; name?: string };
  budget?: number;
  currency?: string;
  /** Taxonomy category ids the user cares about more; used as scoring weights. */
  interests?: string[];
  maxStops?: number;
  profile?: "foot" | "bike" | "car";
}

export interface StopProvenance {
  stopId: string;
  name: string;
  category: string;
  openingHoursSource: "osm" | "web-research" | "unverified";
  openingHoursConfidence: "medium" | "low" | "unknown";
  priceSource: "web-research" | "unverified";
  priceConfidence: "low" | "unknown";
  summarySource: "wikipedia" | "none";
  summaryText?: string;
  summaryUrl?: string;
}

export interface ResearchTraceEntry {
  stage: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

export interface AutoplanResult {
  destination: { name: string; lat: number; lng: number };
  candidatesDiscovered: number;
  candidatesConsidered: number;
  itinerary: OptimizeResult;
  provenance: StopProvenance[];
  trace: ResearchTraceEntry[];
  budgetWarning: string | null;
}

const SHORTLIST_MULTIPLIER = 2; // discover more than needed, in case some are closed that day

export async function autoplan(req: AutoplanRequest): Promise<AutoplanResult> {
  const trace: ResearchTraceEntry[] = [];
  const maxStops = Math.min(Math.max(req.maxStops ?? 8, 1), 16);
  const profile = req.profile ?? "foot";
  const tripDate = new Date(`${req.date}T12:00:00`);

  // --- 1. destination ------------------------------------------------------
  const destGeo = await geocodeOnce(req.destination);
  if (!destGeo) {
    trace.push({ stage: "geocode", status: "failed", detail: `"${req.destination}" bulunamadı` });
    throw new AutoplanError(
      "DESTINATION_NOT_FOUND",
      `"${req.destination}" için koordinat bulunamadı.`
    );
  }
  const center = { lat: destGeo.lat, lng: destGeo.lng };
  trace.push({ stage: "geocode", status: "ok", detail: destGeo.displayName });

  const start = req.startLocation ?? { ...center, name: req.destination };

  // --- 2. autonomous POI discovery (OSM) -----------------------------------
  let discovered;
  try {
    const result = await overpassDiscovery.discoverDetailed(
      center,
      config.DISCOVERY_RADIUS_METERS
    );
    discovered = result.places;
    trace.push({
      stage: "discovery",
      status: result.complete ? "ok" : "ok", // partial data is still usable, just noted
      detail: result.complete
        ? `${discovered.length} aday (${config.DISCOVERY_RADIUS_METERS} m yarıçapta, OpenStreetMap)`
        : `${discovered.length} aday bulundu, ancak şu kategoriler zaman aşımına uğradı ve atlandı: ${result.failedCategories.join(", ")}`,
    });
  } catch (err) {
    trace.push({
      stage: "discovery",
      status: "failed",
      detail: err instanceof Error ? err.message : "Overpass hatası",
    });
    throw new AutoplanError("DISCOVERY_FAILED", "Yer keşfi başarısız oldu.");
  }

  if (discovered.length === 0) {
    throw new AutoplanError(
      "NO_CANDIDATES",
      `${req.destination} çevresinde OpenStreetMap üzerinde yer bulunamadı.`
    );
  }

  // --- 3. score, classify, prune -------------------------------------------
  const scored = scoreCandidates(discovered, center);
  const weights = Object.fromEntries((req.interests ?? []).map((cat) => [cat, 3]));
  const shortlist = pruneAndDiversify(scored, maxStops * SHORTLIST_MULTIPLIER, weights);

  // --- 4. opening-hours resolution (OSM first, web research second) -------
  const caps = await getCapabilities();
  const searchAvailable = caps.find((c) => c.id === "search")?.available ?? false;
  const aiAvailable = caps.find((c) => c.id === "ai")?.available ?? false;

  if (!searchAvailable) {
    trace.push({
      stage: "web-research",
      status: "skipped",
      detail:
        caps.find((c) => c.id === "search")?.remedy ??
        "SearXNG yapılandırılmamış — açılış saati/fiyat bilgisi yalnızca OSM'den alınabildi.",
    });
  }

  const provenance: StopProvenance[] = [];
  const finalStops: Array<{ input: StopInput; scored: (typeof shortlist)[number] }> = [];

  let webResearchAttempts = 0;
  const MAX_WEB_RESEARCH_CALLS = 10; // cost/time control (spec §44/§54)

  for (const candidate of shortlist) {
    if (finalStops.length >= maxStops) break;

    const p = candidate.place;
    let earliestTime: string | undefined;
    let latestTime: string | undefined;
    let openingSource: StopProvenance["openingHoursSource"] = "unverified";
    let openingConfidence: StopProvenance["openingHoursConfidence"] = "unknown";
    let excludedAsClosed = false;

    const osmHours = p.tags.opening_hours;
    if (osmHours) {
      const resolved = resolveOpeningHoursForDate(osmHours, tripDate);
      if (resolved.status === "closed") {
        excludedAsClosed = true;
      } else if (resolved.status === "open" || resolved.status === "always") {
        const window = widestWindow(resolved);
        if (window) {
          earliestTime = window.open;
          latestTime = window.close;
          openingSource = "osm";
          openingConfidence = "medium";
        }
        // No same-day window (e.g. only an overnight-spanning range like
        // "12:00-02:00") leaves the stop correctly unconstrained rather than
        // claiming an OSM-verified time that was never actually applied.
      }
      // "unparseable" leaves the stop unconstrained rather than guessing.
    }

    if (excludedAsClosed) continue; // do not schedule a place we know is shut that day

    let priceSource: StopProvenance["priceSource"] = "unverified";
    let priceConfidence: StopProvenance["priceConfidence"] = "unknown";
    let estimatedCost: number | undefined;

    // Web research only for gaps OSM left, and only up to a hard call budget.
    const needsHoursResearch = !osmHours && searchAvailable && aiAvailable;
    const needsPriceResearch = searchAvailable && aiAvailable && p.tags.fee !== "no";

    if ((needsHoursResearch || needsPriceResearch) && webResearchAttempts < MAX_WEB_RESEARCH_CALLS) {
      webResearchAttempts++;
      try {
        const results = await searxngProvider.searchWeb(
          `${p.name} ${req.destination} opening hours price`,
          3
        );
        const page = results[0];
        if (page) {
          const fetched = await fetchTextCapped(page.url);
          if (fetched.ok) {
            const facts = await extractFactsFromText(p.name, fetched.text);
            if (facts) {
              if (facts.facts.openingHoursText && !osmHours) {
                const osmSyntax = looseTextToOsmSyntax(facts.facts.openingHoursText);
                if (osmSyntax) {
                  const resolved = resolveOpeningHoursForDate(osmSyntax, tripDate);
                  if (resolved.status === "open" || resolved.status === "always") {
                    const window = widestWindow(resolved);
                    if (window) {
                      earliestTime = window.open;
                      latestTime = window.close;
                      openingSource = "web-research";
                      openingConfidence = "low";
                    }
                  } else if (resolved.status === "closed") {
                    excludedAsClosed = true;
                  }
                }
              }
              if (facts.facts.priceAmount != null) {
                estimatedCost = facts.facts.priceAmount;
                priceSource = "web-research";
                priceConfidence = "low";
              }
            }
          }
        }
      } catch (err) {
        const detail =
          err instanceof SearchUnavailableError || err instanceof ExtractionUnavailableError
            ? err.message
            : err instanceof Error
              ? err.message
              : "web araştırması başarısız";
        trace.push({ stage: `web-research:${p.name}`, status: "failed", detail });
      }
    }

    if (excludedAsClosed) continue;

    // --- Wikipedia summary — real, sourced "why this place" text ----------
    let summarySource: StopProvenance["summarySource"] = "none";
    let summaryText: string | undefined;
    let summaryUrl: string | undefined;
    try {
      const summary = await findPlaceSummary(p.name, p.lat, p.lng);
      if (summary.status === "found") {
        summarySource = "wikipedia";
        summaryText = summary.summary.text;
        summaryUrl = summary.summary.pageUrl;
      }
    } catch {
      // Non-critical — the itinerary works without a description.
    }

    const stopInput: StopInput = {
      id: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: candidate.category,
      earliestTime,
      latestTime,
      estimatedCost,
    };

    finalStops.push({ input: stopInput, scored: candidate });
    provenance.push({
      stopId: p.id,
      name: p.name,
      category: candidate.category,
      openingHoursSource: openingSource,
      openingHoursConfidence: openingConfidence,
      priceSource,
      priceConfidence,
      summarySource,
      summaryText,
      summaryUrl,
    });
  }

  if (finalStops.length === 0) {
    throw new AutoplanError(
      "NO_USABLE_CANDIDATES",
      "Keşfedilen yerlerin hiçbiri bu tarihte uygun değildi (kapalı ya da doğrulanamadı)."
    );
  }

  trace.push({
    stage: "enrichment",
    status: "ok",
    detail: `${finalStops.length} durak hazırlandı (${provenance.filter((p) => p.openingHoursSource !== "unverified").length} açılış saati doğrulandı)`,
  });

  // --- 5. real routing + the EXISTING deterministic optimizer --------------
  const points = [start, ...finalStops.map((s) => s.input)];
  const matrix = await fetchMatrix(points, profile);
  trace.push({
    stage: "routing",
    status: matrix.source === "osrm" ? "ok" : "failed",
    detail: matrix.source === "osrm" ? "OSRM matrisi hesaplandı" : "OSRM yanıt vermedi, kuş uçuşu kullanıldı",
  });

  const itinerary = optimizeItinerary(
    {
      stops: finalStops.map((s) => s.input),
      dayStart: req.arrivalTime,
      dayEnd: req.departureTime,
      start,
      end: req.endLocation,
    },
    matrix
  );

  trace.push({
    stage: "optimize",
    status: itinerary.feasible ? "ok" : "failed",
    detail: itinerary.feasible
      ? `${itinerary.stops.length} durak, ${(itinerary.totalDistanceMeters / 1000).toFixed(1)} km`
      : `${itinerary.conflicts.length} çakışma tespit edildi`,
  });

  let budgetWarning: string | null = null;
  if (req.budget != null && itinerary.costKnown && itinerary.totalCost > req.budget) {
    budgetWarning = `Tahmini maliyet (${itinerary.totalCost} ${req.currency ?? ""}) bütçeyi (${req.budget} ${req.currency ?? ""}) aşıyor.`;
  }

  return {
    destination: { name: destGeo.displayName, ...center },
    candidatesDiscovered: discovered.length,
    candidatesConsidered: shortlist.length,
    itinerary,
    provenance,
    trace,
    budgetWarning,
  };
}

export class AutoplanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AutoplanError";
    this.code = code;
  }
}
