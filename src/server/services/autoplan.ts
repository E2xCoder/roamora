import "server-only";
import { geocodeOnce } from "@/server/services/geocode";
import { overpassDiscovery } from "@/server/providers/discovery/overpass-discovery";
import { scoreCandidates, pruneAndDiversify } from "@/server/services/discovery-scoring";
import { resolveOpeningHoursForDate, widestWindow } from "@/lib/opening-hours";
import { findPlaceSummary } from "@/server/providers/research/wikipedia-summary";
import { searxngProvider, SearchUnavailableError } from "@/server/providers/research/searxng";
import {
  extractFactsFromText,
  htmlToPlainText,
  ExtractionUnavailableError,
} from "@/server/services/fact-extraction";
import { validateExtractedOpeningHours, isSupportedBySource } from "@/server/services/opening-hours-guard";
import { scoreConfidence, isOfficialSource, detectStaleness, type ConfidenceLevel } from "@/server/services/confidence";
import { fetchTextCapped } from "@/server/services/url-safety";
import { fetchMatrix } from "@/server/services/osrm-matrix";
import { fetchTransitMatrix, MAX_OTP_CALLS as OTP_MAX_CALLS } from "@/server/services/otp-matrix";
import { planBudgetOptimization, type BudgetOptimizationResult } from "@/server/services/budget-optimizer";
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
  profile?: "foot" | "bike" | "car" | "transit";
  /**
   * Place names the user explicitly wants kept no matter what — matched
   * case-insensitively against a discovered candidate's name. Protects a
   * stop from budget-driven removal or substitution (see budget-optimizer.ts);
   * has no effect if the name never turns up in discovery at all (this
   * cannot force-add a place that OSM doesn't have).
   */
  mustSeeNames?: string[];
}

export interface StopProvenance {
  stopId: string;
  name: string;
  category: string;
  openingHoursSource: "osm" | "web-research" | "unverified";
  openingHoursConfidence: ConfidenceLevel;
  priceSource: "web-research" | "unverified";
  priceConfidence: ConfidenceLevel;
  summarySource: "wikipedia" | "none";
  summaryText?: string;
  summaryUrl?: string;
}

export interface ResearchTraceEntry {
  stage: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

/**
 * Real counts behind the cost caps that bound this run — the caps exist to
 * keep a single plan from making unbounded outbound calls, but silently
 * hitting one and reporting nothing looked identical to "there was simply
 * nothing to research". A user (or caller) deciding whether a plan's
 * unverified stops are "nothing was found" vs "we ran out of budget to
 * check" needs these numbers, not just the aggregate trace line.
 */
export interface ResearchMetadata {
  webResearch: {
    attempted: number;
    succeeded: number;
    skippedDueToCap: number;
    capLimit: number;
  };
  transitRouting: {
    totalPairs: number;
    otpCallsAttempted: number;
    otpCallsSucceeded: number;
    skippedDueToCap: number;
    capLimit: number;
    fallbackUsed: boolean;
  } | null; // null when profile !== "transit"
}

export interface AutoplanResult {
  destination: { name: string; lat: number; lng: number };
  candidatesDiscovered: number;
  candidatesConsidered: number;
  itinerary: OptimizeResult;
  provenance: StopProvenance[];
  trace: ResearchTraceEntry[];
  researchMetadata: ResearchMetadata;
  /** Real replanning result when a budget was given and the initial itinerary exceeded it — see budget-optimizer.ts. Null when no budget was given or the first pass already fit. */
  budgetOptimization: BudgetOptimizationResult | null;
  budgetWarning: string | null;
}

const SHORTLIST_MULTIPLIER = 2; // discover more than needed, in case some are closed that day

/**
 * Fetches and extracts hours from a second, independent search result and
 * reports whether it agrees with the first source's resolved OSM syntax.
 * Deliberately strict — an exact string match, not a fuzzy overlap check —
 * since "roughly similar" hours from two sources is weaker evidence than
 * either a real match or a real, informative conflict; being lenient here
 * would just relabel "we didn't actually check" as "medium confidence".
 * Any failure along the way (fetch/extract error, no hours found) reports
 * `null` (not checked) rather than `false` (disagreement) — an unreachable
 * second source is not evidence the first one is wrong.
 */
async function crossCheckAgreement(
  placeName: string,
  secondUrl: string,
  firstOsmSyntax: string,
  trace: ResearchTraceEntry[]
): Promise<boolean | null> {
  try {
    const fetched = await fetchTextCapped(secondUrl);
    if (!fetched.ok) return null;
    const facts = await extractFactsFromText(placeName, fetched.text);
    if (!facts) return null;
    const guardResult = validateExtractedOpeningHours(
      facts.facts.openingHoursText,
      facts.facts.hoursScope,
      htmlToPlainText(fetched.text)
    );
    if (guardResult.status !== "specific-hours") return null;
    return guardResult.osmSyntax === firstOsmSyntax;
  } catch (err) {
    trace.push({
      stage: `web-research-crosscheck:${placeName}`,
      status: "failed",
      detail: err instanceof Error ? err.message : "ikinci kaynak kontrolü başarısız",
    });
    return null;
  }
}

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

  if (!searchAvailable || !aiAvailable) {
    // Both a search backend and an LLM are required to turn a fetched page
    // into structured facts — reporting only the search gap left this stage
    // silently invisible whenever SearXNG was up but Ollama wasn't (or vice
    // versa): OSM-only results with no explanation of why enrichment never ran.
    const missing = [
      !searchAvailable ? (caps.find((c) => c.id === "search")?.remedy ?? "SearXNG yapılandırılmamış") : null,
      !aiAvailable ? (caps.find((c) => c.id === "ai")?.remedy ?? "AI sağlayıcı yapılandırılmamış") : null,
    ].filter(Boolean);
    trace.push({
      stage: "web-research",
      status: "skipped",
      detail: `${missing.join(" ")} — açılış saati/fiyat bilgisi yalnızca OSM'den alınabildi.`,
    });
  }

  let provenance: StopProvenance[] = [];
  let finalStops: Array<{ input: StopInput; scored: (typeof shortlist)[number] }> = [];

  let webResearchAttempts = 0;
  let webResearchSucceeded = 0;
  let webResearchSkippedDueToCap = 0;
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
          // A community-maintained structured tag, not free text pulled off
          // a webpage — categorically stronger evidence than anything the
          // web-research path can produce, so this never goes through the
          // general-purpose scorer below.
          openingConfidence = "high";
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

    const wantsWebResearch = needsHoursResearch || needsPriceResearch;
    if (wantsWebResearch && webResearchAttempts >= MAX_WEB_RESEARCH_CALLS) {
      webResearchSkippedDueToCap++;
    }

    if (wantsWebResearch && webResearchAttempts < MAX_WEB_RESEARCH_CALLS) {
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
            const sourceText = htmlToPlainText(fetched.text);
            const facts = await extractFactsFromText(p.name, fetched.text);
            if (facts) {
              const official = isOfficialSource(page.url, page.title, p.name);
              const stale = detectStaleness(sourceText);
              const ambiguous = !facts.facts.hoursScope || facts.facts.hoursScope === "unclear";

              if (!osmHours) {
                const guardResult = validateExtractedOpeningHours(
                  facts.facts.openingHoursText,
                  facts.facts.hoursScope,
                  sourceText
                );
                if (guardResult.status === "specific-hours") {
                  const resolved = resolveOpeningHoursForDate(guardResult.osmSyntax, tripDate);
                  if (resolved.status === "open" || resolved.status === "always") {
                    const window = widestWindow(resolved);
                    if (window) {
                      // A non-official single source is weak evidence on its
                      // own — cross-check against a second independent
                      // result when one exists and the budget allows,
                      // rather than reporting a confidence level no
                      // corroboration was ever actually attempted for.
                      let agreement: boolean | null = null;
                      if (!official && results[1] && webResearchAttempts < MAX_WEB_RESEARCH_CALLS) {
                        webResearchAttempts++;
                        agreement = await crossCheckAgreement(p.name, results[1].url, guardResult.osmSyntax, trace);
                      }
                      earliestTime = window.open;
                      latestTime = window.close;
                      openingSource = "web-research";
                      openingConfidence = scoreConfidence({
                        textuallySupported: true,
                        officialSource: official,
                        extractionAmbiguous: ambiguous,
                        stale,
                        multiSourceAgreement: agreement,
                      });
                    }
                  } else if (resolved.status === "closed") {
                    excludedAsClosed = true;
                  }
                } else if (guardResult.status === "closed") {
                  excludedAsClosed = true;
                }
                // "by-appointment" / "today-only" (never a same-day-of-week
                // constraint without known trip-date-vs-fetch-date context,
                // which nothing here tracks) / "unknown" all leave the stop
                // unconstrained, same as no web-research data at all.
              }
              if (facts.facts.priceAmount != null) {
                const priceText = `${facts.facts.priceAmount}`;
                const priceSupported =
                  isSupportedBySource(priceText, sourceText) ||
                  (facts.facts.priceCurrency != null && isSupportedBySource(facts.facts.priceCurrency, sourceText));
                estimatedCost = facts.facts.priceAmount;
                priceSource = "web-research";
                priceConfidence = scoreConfidence({
                  textuallySupported: priceSupported,
                  officialSource: official,
                  extractionAmbiguous: facts.facts.priceCurrency == null,
                  stale,
                  multiSourceAgreement: null, // price cross-checking is not implemented — one extra fetch per fact would double the already-bounded research budget
                });
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
      if (openingSource === "web-research" || priceSource === "web-research" || excludedAsClosed) {
        webResearchSucceeded++;
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
  async function routeAndOptimize(
    stopsForRoute: Array<{ input: StopInput }>,
    stageLabel: string
  ): Promise<{ itinerary: OptimizeResult; transitMetadata: ResearchMetadata["transitRouting"] }> {
    const routePoints = [start, ...stopsForRoute.map((s) => s.input)];
    let routeMatrix: Awaited<ReturnType<typeof fetchMatrix>>;
    let routeTransitMetadata: ResearchMetadata["transitRouting"] = null;

    if (profile === "transit") {
      const transitAvailable = caps.find((c) => c.id === "transit")?.available ?? false;
      if (transitAvailable && config.OTP_URL) {
        const otpMatrix = await fetchTransitMatrix(routePoints, config.OTP_URL, req.date, req.arrivalTime);
        routeMatrix = otpMatrix;
        routeTransitMetadata = {
          totalPairs: otpMatrix.totalPairs,
          otpCallsAttempted: otpMatrix.otpCalls,
          otpCallsSucceeded: otpMatrix.otpSucceeded,
          skippedDueToCap: otpMatrix.skippedDueToCap,
          capLimit: OTP_MAX_CALLS,
          fallbackUsed: otpMatrix.fallbackUsed,
        };
        trace.push({
          stage: stageLabel,
          status: otpMatrix.source === "fallback" ? "failed" : "ok",
          detail:
            otpMatrix.source === "otp"
              ? `OpenTripPlanner: ${otpMatrix.otpCalls} durak çifti için gerçek toplu taşıma rotası hesaplandı`
              : otpMatrix.source === "otp+osrm"
                ? `OpenTripPlanner: ${otpMatrix.otpSucceeded}/${otpMatrix.totalPairs} çift gerçek toplu taşıma verisiyle (${otpMatrix.skippedDueToCap} çift limit nedeniyle denenmedi), kalanı yürüyüşle`
                : "OpenTripPlanner hiçbir çift için yanıt vermedi, yürüyüş mesafesi kullanıldı",
        });
      } else {
        trace.push({
          stage: stageLabel,
          status: "failed",
          detail:
            caps.find((c) => c.id === "transit")?.remedy ??
            "OTP_URL yapılandırılmamış, yürüyüş mesafesi kullanıldı",
        });
        routeMatrix = await fetchMatrix(routePoints, "foot");
      }
    } else {
      routeMatrix = await fetchMatrix(routePoints, profile);
      trace.push({
        stage: stageLabel,
        status: routeMatrix.source === "osrm" ? "ok" : "failed",
        detail: routeMatrix.source === "osrm" ? "OSRM matrisi hesaplandı" : "OSRM yanıt vermedi, kuş uçuşu kullanıldı",
      });
    }

    const routeItinerary = optimizeItinerary(
      {
        stops: stopsForRoute.map((s) => s.input),
        dayStart: req.arrivalTime,
        dayEnd: req.departureTime,
        start,
        end: req.endLocation,
      },
      routeMatrix
    );

    trace.push({
      stage: `${stageLabel}:optimize`,
      status: routeItinerary.feasible ? "ok" : "failed",
      detail: routeItinerary.feasible
        ? `${routeItinerary.stops.length} durak, ${(routeItinerary.totalDistanceMeters / 1000).toFixed(1)} km`
        : `${routeItinerary.conflicts.length} çakışma tespit edildi`,
    });

    return { itinerary: routeItinerary, transitMetadata: routeTransitMetadata };
  }

  let { itinerary, transitMetadata } = await routeAndOptimize(finalStops, "routing");

  // --- 6. real budget replanning, not a passive warning --------------------
  let budgetOptimization: BudgetOptimizationResult | null = null;
  if (req.budget != null) {
    const mustSeeIds = new Set(
      finalStops
        .filter((s) =>
          (req.mustSeeNames ?? []).some((n) => s.input.name.toLowerCase().includes(n.toLowerCase()))
        )
        .map((s) => s.input.id)
    );
    const { keptStops, result } = planBudgetOptimization(finalStops, shortlist, req.budget, mustSeeIds);
    budgetOptimization = result;

    if (result.applied) {
      trace.push({
        stage: "budget",
        status: result.satisfied ? "ok" : "failed",
        detail: `${result.reason} — ${result.originalCost} ${req.currency ?? ""} → ${result.optimizedCost} ${req.currency ?? ""}`,
      });

      if (result.removedStops.length > 0 || result.replacedStops.length > 0) {
        finalStops = keptStops;
        provenance = provenance.filter((p) => finalStops.some((s) => s.input.id === p.stopId));
        for (const r of result.replacedStops) {
          const added = keptStops.find((s) => s.input.id === r.addedId);
          if (added) {
            provenance.push({
              stopId: added.input.id,
              name: added.input.name,
              category: added.scored.category,
              openingHoursSource: "unverified",
              openingHoursConfidence: "unknown",
              priceSource: "unverified", // free by construction (isFreeCandidate), but not independently re-verified — reported as unknown rather than claiming a checked "free" fact
              priceConfidence: "unknown",
              summarySource: "none",
            });
          }
        }
        ({ itinerary, transitMetadata } = await routeAndOptimize(finalStops, "budget-reroute"));
      }
    }
  }

  const budgetWarning =
    budgetOptimization && !budgetOptimization.satisfied
      ? `Bütçe (${req.budget} ${req.currency ?? ""}) tüm zorunlu/kilitli duraklar korunarak karşılanamadı — ulaşılabilir minimum maliyet: ${budgetOptimization.minimumFeasibleCost} ${req.currency ?? ""}.`
      : null;

  const researchMetadata: ResearchMetadata = {
    webResearch: {
      attempted: webResearchAttempts,
      succeeded: webResearchSucceeded,
      skippedDueToCap: webResearchSkippedDueToCap,
      capLimit: MAX_WEB_RESEARCH_CALLS,
    },
    transitRouting: transitMetadata,
  };

  return {
    destination: { name: destGeo.displayName, ...center },
    candidatesDiscovered: discovered.length,
    candidatesConsidered: shortlist.length,
    itinerary,
    provenance,
    trace,
    researchMetadata,
    budgetOptimization,
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
