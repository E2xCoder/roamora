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
import { validateExtractedOpeningHours } from "@/server/services/opening-hours-guard";
import { validateExtractedPrice } from "@/server/services/price-guard";
import { extractEventFactsFromText, extractEventListFromText } from "@/server/services/event-extraction";
import { validateExtractedEvent } from "@/server/services/event-guard";
import {
  researchRestaurant,
  researchLocalFood,
  restaurantStopInput,
  type RestaurantResearchResult,
  type LocalFoodResult,
} from "@/server/services/restaurant";
import { scoreConfidence, detectStaleness, selectBestResult, type ConfidenceLevel } from "@/server/services/confidence";
import { resolveResearchSource } from "@/server/services/direct-research";
import { fetchTextCapped } from "@/server/services/url-safety";
import { fetchMatrix } from "@/server/services/osrm-matrix";
import { fetchTransitMatrix, MAX_OTP_CALLS as OTP_MAX_CALLS } from "@/server/services/otp-matrix";
import { planBudgetOptimization, type BudgetOptimizationResult } from "@/server/services/budget-optimizer";
import { findHiddenGemsNearCorridor } from "@/server/services/hidden-gem";
import { fetchDailyForecast, isBadWeatherDay, type WeatherForecast } from "@/server/providers/research/weather";
import { applyWeatherWeights, isOutdoorCategory } from "@/server/services/weather-routing";
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
  /**
   * Extra minutes to hold in reserve at `endLocation` before `departureTime`
   * — platform-finding, station navigation, a train/flight boarding cutoff
   * before its actual departure. Real, not decorative: this tightens the
   * effective end-of-day time the optimizer schedules against (see
   * `departureSafety` in the result), reusing its existing, already-tested
   * day-overrun conflict detection rather than adding a second, parallel
   * safety check.
   */
  departureBufferMinutes?: number;
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
  /**
   * Named real-world events (a specific concert, festival, show) the caller
   * wants researched and, if genuinely happening during the trip, scheduled
   * as a fixed appointment the rest of the day plans around. Not autonomous
   * event *discovery* — OSM has no concept of a time-bound event, so there
   * is no free/self-hostable source this pipeline can poll for "what's on
   * near here" without being told what to look for. Given a name, though,
   * the same real research chain (search → fetch → extract → validate) used
   * for opening hours/prices applies directly.
   */
  eventQueries?: string[];
  /**
   * Free-text food preferences ("vegan", "seafood", "budget-friendly") used
   * as a real scoring signal for restaurant selection (spec §Priority 3.2) —
   * matched against an OSM `cuisine` tag and extracted menu items' local-
   * specialty flags, never used to fabricate a cuisine a candidate doesn't
   * actually have.
   */
  foodPreferences?: string[];
}

export interface StopProvenance {
  stopId: string;
  name: string;
  category: string;
  openingHoursSource: "osm" | "web-research" | "unverified";
  openingHoursConfidence: ConfidenceLevel;
  priceSource: "web-research" | "unverified";
  priceConfidence: ConfidenceLevel;
  /** Set only when priceSource is "web-research" — a "minimum"/"reduced" price is real and textually-supported, but not what a typical traveller pays. */
  priceType?: "standard" | "minimum" | "reduced";
  /** Which research tier actually supplied the web-research facts above — "official" means fetched directly from the place's own resolved domain, never via a generic search query. */
  sourceType?: "official" | "secondary" | "unverified";
  /** Set only when sourceType is "official" — the resolved official domain, e.g. "rijksmuseum.nl". */
  officialDomain?: string;
  summarySource: "wikipedia" | "none";
  summaryText?: string;
  summaryUrl?: string;
}

export interface ResearchTraceEntry {
  stage: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

export interface DepartureSafetyResult {
  /** Whether an end/departure location was actually given — without one there is no specific point to be safe for, only the generic day-end time. */
  hasDeparturePoint: boolean;
  bufferMinutes: number;
  requestedDepartureTime: string;
  /** requestedDepartureTime minus bufferMinutes — the real cutoff the optimizer scheduled against. */
  latestSafeArrivalTime: string;
  /** True when the itinerary's real routing/scheduling fits within latestSafeArrivalTime. */
  safe: boolean;
  overrunMinutes: number;
}

export interface DelaySimulationResult {
  delayMinutes: number;
  feasible: boolean;
  conflictCount: number;
  departureSafe: boolean;
}

export interface EventResearchResult {
  query: string;
  status: "scheduled" | "not-matching-trip-date" | "not-found" | "research-unavailable";
  eventName?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  reason?: string;
}

/** One place found via the route-aware hidden-gem engine (spec §Priority 5) — real distance to the actual route corridor, not a guess. */
export interface HiddenGemFound {
  stopId: string;
  name: string;
  category: string;
  distanceMeters: number;
  radiusTierMeters: number;
}

export interface HiddenGemResult {
  status: "found" | "none" | "skipped";
  found: HiddenGemFound[];
  reason?: string;
}

/** Real weather influence on routing (spec §Priority 6) — not a forecast display. */
export interface WeatherResult {
  status: "found" | "unavailable";
  forecast?: WeatherForecast;
  /** Whether the forecast actually met the bad-weather threshold (see isBadWeatherDay). */
  badWeatherDay: boolean;
  /** True exactly when badWeatherDay caused a real category-weight change to the shortlist. */
  categoriesAdjusted: boolean;
  reason?: string;
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
  /** Second-stage "Direct Official Source Resolution" metrics (spec §Priority-4) — how often an official domain/page was found and used instead of a generic SearXNG query. */
  officialSource: {
    domainAttempted: number;
    domainResolved: number;
    pageAttempted: number;
    pageResolved: number;
    /** Generic SearXNG fallback queries that were never made because an official source answered the fact directly. */
    searchQueriesAvoided: number;
  };
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
  /** One entry per requested `eventQueries` item — what was researched and what happened to it. Empty when none were requested. */
  events: EventResearchResult[];
  /** Autonomous restaurant discovery/selection for a meal that fits the trip (spec §Priority 3). */
  restaurant: RestaurantResearchResult;
  /** Destination-level local food facts (spec §Priority 3.6) — independent of which restaurant, if any, was selected. */
  localFood: LocalFoodResult;
  /** Route-aware hidden-gem engine result (spec §Priority 5) — real places found near the actual route corridor and re-inserted into the optimizer, not appended. */
  hiddenGems: HiddenGemResult;
  /** Real weather forecast and whether it actually changed category weighting (spec §Priority 6). */
  weather: WeatherResult;
  departureSafety: DepartureSafetyResult;
  /** Real robustness check: re-runs the same deterministic optimizer, same real matrix, with the start time pushed back by each increment. No new network calls. */
  delaySimulation: DelaySimulationResult[];
  /** The smallest delay (minutes) that breaks feasibility or departure safety — null if the plan survives every simulated delay. */
  fragileAtMinutes: number | null;
}

const SHORTLIST_MULTIPLIER = 2; // discover more than needed, in case some are closed that day

function subtractMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = ((h * 60 + m - minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function addMinutes(hhmm: string, minutes: number): string {
  return subtractMinutes(hhmm, -minutes);
}

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

  // --- 1b. weather (spec §Priority 6) — computed early so it can actually
  // change which candidates get shortlisted, not just be displayed -------
  let weather: WeatherResult;
  const forecast = await fetchDailyForecast(center.lat, center.lng, req.date).catch(() => null);
  if (!forecast) {
    weather = { status: "unavailable", badWeatherDay: false, categoriesAdjusted: false, reason: "tarih tahmin ufkunun dışında ya da servis yanıt vermedi" };
    trace.push({ stage: "weather", status: "skipped", detail: weather.reason! });
  } else {
    const badWeatherDay = isBadWeatherDay(forecast);
    weather = { status: "found", forecast, badWeatherDay, categoriesAdjusted: badWeatherDay };
    trace.push({
      stage: "weather",
      status: "ok",
      detail: `${forecast.condition} (${forecast.precipitationProbability ?? "?"}% yağış ihtimali, ${forecast.temperatureMinC ?? "?"}–${forecast.temperatureMaxC ?? "?"}°C)${badWeatherDay ? " — kötü hava, kapalı mekan kategorileri önceliklendirildi" : ""}`,
    });
  }

  // Computed early (not just at routing time) because restaurant meal-window
  // selection needs the real effective end-of-day before the optimizer runs.
  const departureBufferMinutes = Math.max(0, req.departureBufferMinutes ?? 0);
  const effectiveDayEnd = subtractMinutes(req.departureTime, departureBufferMinutes);

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
  const baseWeights = Object.fromEntries((req.interests ?? []).map((cat) => [cat, 3]));
  // Real routing-decision change on a bad-weather day, not a cosmetic
  // forecast: indoor categories are weighted up and outdoor ones down
  // BEFORE the shortlist is built, on top of whatever the user's own
  // stated interests already weighted — see weather-routing.ts.
  const weights = applyWeatherWeights(baseWeights, [...new Set(scored.map((c) => c.category))], weather.badWeatherDay);
  const shortlist = pruneAndDiversify(scored, maxStops * SHORTLIST_MULTIPLIER, weights);
  // Every OSM restaurant candidate, not just the ones that made the general
  // attraction shortlist — pruneAndDiversify's category round-robin can
  // easily leave real restaurant candidates out entirely when interests skew
  // toward other categories, which would silently starve restaurant research
  // of anything to consider.
  const restaurantCandidates = scored.filter((c) => c.category === "restaurant");

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
  const officialSourceMetrics = {
    domainAttempted: 0,
    domainResolved: 0,
    pageAttempted: 0,
    pageResolved: 0,
    searchQueriesAvoided: 0,
  };

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
    let priceType: StopProvenance["priceType"];
    let estimatedCost: number | undefined;

    // Web research only for gaps OSM left, and only up to a hard call budget.
    const needsHoursResearch = !osmHours && searchAvailable && aiAvailable;
    const needsPriceResearch = searchAvailable && aiAvailable && p.tags.fee !== "no";

    const wantsWebResearch = needsHoursResearch || needsPriceResearch;
    if (wantsWebResearch && webResearchAttempts >= MAX_WEB_RESEARCH_CALLS) {
      webResearchSkippedDueToCap++;
    }

    let sourceTypeUsed: StopProvenance["sourceType"] = "unverified";
    let officialDomainUsed: string | undefined;

    if (wantsWebResearch && webResearchAttempts < MAX_WEB_RESEARCH_CALLS) {
      webResearchAttempts++;
      try {
        // Second-stage research: try the place's own official site directly
        // (no search-engine round trip at all when it resolves) before
        // falling back to the existing generic SearXNG query. Prefer the
        // "hours" fact type when hours are still unknown — a museum's
        // "plan your visit" page routinely carries both hours AND price, so
        // one fetch commonly answers both facts extracted below, same as
        // the previous single-search-result flow always assumed.
        const { source, metrics } = await resolveResearchSource(
          p.name,
          req.destination,
          p.tags,
          needsHoursResearch ? "hours" : "price",
          `"${p.name}" ${req.destination} official opening hours price`,
          searchAvailable
        );
        officialSourceMetrics.domainAttempted += metrics.officialDomainAttempted ? 1 : 0;
        officialSourceMetrics.domainResolved += metrics.officialDomainResolved ? 1 : 0;
        officialSourceMetrics.pageAttempted += metrics.officialPageAttempted ? 1 : 0;
        officialSourceMetrics.pageResolved += metrics.officialPageResolved ? 1 : 0;
        officialSourceMetrics.searchQueriesAvoided += metrics.searchQueryAvoided ? 1 : 0;

        if (source) {
          const sourceText = htmlToPlainText(source.text);
          const facts = await extractFactsFromText(p.name, source.text);
          if (facts) {
            const official = source.official;
            const stale = detectStaleness(sourceText);
            const ambiguous = !facts.facts.hoursScope || facts.facts.hoursScope === "unclear";
            sourceTypeUsed = source.sourceType === "official" ? "official" : "secondary";
            if (source.sourceType === "official") {
              officialDomainUsed = (() => {
                try {
                  return new URL(source.url).hostname.replace(/^www\./, "");
                } catch {
                  return undefined;
                }
              })();
            }

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
                    // corroboration was ever actually attempted for. An
                    // official-tier source has no "second search result" —
                    // it is already the strongest evidence this pipeline
                    // has, so no cross-check is needed or attempted.
                    let agreement: boolean | null = null;
                    const secondSource = source.searchResults.find((r) => r.url !== source.url);
                    if (!official && secondSource && webResearchAttempts < MAX_WEB_RESEARCH_CALLS) {
                      webResearchAttempts++;
                      agreement = await crossCheckAgreement(p.name, secondSource.url, guardResult.osmSyntax, trace);
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
            const priceGuardResult = validateExtractedPrice(facts.facts.priceAmount, facts.facts.priceCurrency, sourceText);
            if (priceGuardResult.status !== "unknown") {
              // A minimum ("from €X") or reduced (child/student) fare is a
              // real, textually-supported number, but not the price most
              // travellers will actually pay — accepted (never invented),
              // just never at the same confidence as a plain standard price.
              const priceTypeAmbiguous = priceGuardResult.status !== "valid";
              estimatedCost = priceGuardResult.amount;
              priceType = priceGuardResult.status === "valid" ? "standard" : priceGuardResult.status === "valid-minimum" ? "minimum" : "reduced";
              priceSource = "web-research";
              priceConfidence = scoreConfidence({
                textuallySupported: true, // the guard already required this to reach a non-"unknown" status
                officialSource: official,
                extractionAmbiguous: priceTypeAmbiguous || facts.facts.priceCurrency == null,
                stale,
                multiSourceAgreement: null, // price cross-checking is not implemented — one extra fetch per fact would double the already-bounded research budget
              });
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
      priceType,
      sourceType: sourceTypeUsed,
      officialDomain: officialDomainUsed,
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

  // --- 4b. event research: named queries, plus autonomous discovery -------
  const events: EventResearchResult[] = [];
  const scheduledEventIds = new Set<string>();

  /** Turns one validated, trip-date-matching event into a real stop (real venue geocode, real fixedTime), shared by both the named-query and autonomous-discovery paths below. */
  async function scheduleEventStop(
    stopId: string,
    eventName: string,
    venueName: string | null,
    startDate: string,
    endDate: string,
    startTime: string | null
  ): Promise<void> {
    if (scheduledEventIds.has(stopId)) return; // the same real event surfaced by both a named query and discovery — don't double-book it
    scheduledEventIds.add(stopId);

    let venueCoords = center;
    if (venueName) {
      const venueGeo = await geocodeOnce(`${venueName}, ${req.destination}`);
      if (venueGeo) venueCoords = { lat: venueGeo.lat, lng: venueGeo.lng };
    }

    const eventInput: StopInput = {
      id: stopId,
      name: eventName,
      lat: venueCoords.lat,
      lng: venueCoords.lng,
      category: "event",
      fixedTime: startTime ?? undefined,
    };
    finalStops.push({
      input: eventInput,
      scored: {
        place: { id: stopId, name: eventName, lat: venueCoords.lat, lng: venueCoords.lng, osmTag: "event", osmValue: "event", tags: {}, source: "osm" },
        category: "event",
        notabilityScore: 0,
        distanceFromCenterMeters: 0,
      },
    });
    provenance.push({
      stopId,
      name: eventName,
      category: "event",
      openingHoursSource: "unverified",
      openingHoursConfidence: "unknown",
      priceSource: "unverified",
      priceConfidence: "unknown",
      summarySource: "none",
    });
    trace.push({
      stage: `event:${eventName}`,
      status: "ok",
      detail: `Gerçek etkinlik bulundu ve programa eklendi: ${eventName}${startTime ? ` (${startTime})` : ""}`,
    });
  }

  // --- 4b-i. named event queries (real, but not autonomous discovery — see
  //           AutoplanRequest.eventQueries's own comment for why) ----------
  const MAX_EVENT_QUERIES = 3;
  for (const query of (req.eventQueries ?? []).slice(0, MAX_EVENT_QUERIES)) {
    if (!searchAvailable || !aiAvailable) {
      events.push({ query, status: "research-unavailable" });
      continue;
    }
    try {
      const results = await searxngProvider.searchWeb(`"${query}" official program dates`, 5);
      const page = selectBestResult(results, query);
      if (!page) {
        events.push({ query, status: "not-found", reason: "arama sonucu yok" });
        continue;
      }
      const fetched = await fetchTextCapped(page.url);
      if (!fetched.ok) {
        events.push({ query, status: "not-found", reason: fetched.reason });
        continue;
      }
      const sourceText = htmlToPlainText(fetched.text);
      const eventFacts = await extractEventFactsFromText(query, fetched.text);
      if (!eventFacts) {
        events.push({ query, status: "not-found", reason: "sayfadan etkinlik bilgisi çıkarılamadı" });
        continue;
      }
      const guardResult = validateExtractedEvent(eventFacts.facts, req.date, sourceText);
      if (guardResult.status === "unknown") {
        events.push({ query, status: "not-found", reason: guardResult.reason });
        continue;
      }
      if (!guardResult.matchesTripDate) {
        events.push({
          query,
          status: "not-matching-trip-date",
          eventName: eventFacts.facts.eventName ?? undefined,
          startDate: guardResult.startDate,
          endDate: guardResult.endDate,
        });
        continue;
      }

      const eventName = eventFacts.facts.eventName ?? query;
      await scheduleEventStop(
        `event:${query}`,
        eventName,
        eventFacts.facts.venueName,
        guardResult.startDate,
        guardResult.endDate,
        guardResult.startTime
      );
      events.push({
        query,
        status: "scheduled",
        eventName,
        startDate: guardResult.startDate,
        endDate: guardResult.endDate,
        startTime: guardResult.startTime ?? undefined,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "etkinlik araştırması başarısız";
      events.push({ query, status: "not-found", reason: detail });
      trace.push({ stage: `event:${query}`, status: "failed", detail });
    }
  }

  // --- 4b-ii. autonomous event discovery — no named query required --------
  // Real, but bounded: a single generic "what's on" style query against the
  // destination for the trip's month, one page fetched, every dated event on
  // it extracted and independently re-validated (real calendar date,
  // textually supported, not already ended, matches the trip date) exactly
  // like a named lookup — a hallucinated or stale entry in the list is
  // rejected the same way a bad single-event extraction would be. This does
  // not replace a dedicated events API/site — none exists free for this
  // stack to poll — it searches the same way a traveller would.
  const MAX_DISCOVERED_EVENTS = 2;
  if (searchAvailable && aiAvailable) {
    try {
      const monthName = new Date(`${req.date}T12:00:00`).toLocaleString("en-US", { month: "long" });
      const year = req.date.slice(0, 4);
      const discoveryQuery = `${req.destination} events calendar concerts festivals ${monthName} ${year}`;
      const results = await searxngProvider.searchWeb(discoveryQuery, 5);
      const page = selectBestResult(results, req.destination);
      if (!page) {
        trace.push({ stage: "event-discovery", status: "skipped", detail: "arama sonucu yok" });
      } else {
        const fetched = await fetchTextCapped(page.url);
        if (!fetched.ok) {
          trace.push({ stage: "event-discovery", status: "failed", detail: fetched.reason });
        } else {
          const sourceText = htmlToPlainText(fetched.text);
          const items = await extractEventListFromText(fetched.text);
          let scheduledCount = 0;
          for (const item of items) {
            if (scheduledCount >= MAX_DISCOVERED_EVENTS) break;
            if (!item.startDate) continue;
            const guardResult = validateExtractedEvent(item, req.date, sourceText);
            if (guardResult.status !== "valid" || !guardResult.matchesTripDate) continue;
            await scheduleEventStop(
              `event-discovered:${item.eventName}`,
              item.eventName,
              item.venueName,
              guardResult.startDate,
              guardResult.endDate,
              guardResult.startTime
            );
            events.push({
              query: discoveryQuery,
              status: "scheduled",
              eventName: item.eventName,
              startDate: guardResult.startDate,
              endDate: guardResult.endDate,
              startTime: guardResult.startTime ?? undefined,
            });
            scheduledCount++;
          }
          trace.push({
            stage: "event-discovery",
            status: "ok",
            detail: `${items.length} etkinlik listelendi (${page.url}), ${scheduledCount} tanesi gezi tarihine uyuyor ve programa eklendi`,
          });
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "otonom etkinlik keşfi başarısız";
      trace.push({ stage: "event-discovery", status: "failed", detail });
    }
  } else {
    trace.push({
      stage: "event-discovery",
      status: "skipped",
      detail: "arama veya AI sağlayıcı yapılandırılmamış",
    });
  }

  // --- 4c. restaurant + local food intelligence (spec §Priority 3) --------
  // Runs before the optimizer, not after: a selected restaurant becomes a
  // real StopInput pushed into finalStops here, so the FIRST routeAndOptimize
  // call below inserts it at its real cheapest-feasible position within its
  // meal window — the same "insert into the optimizer, don't append"
  // discipline as event scheduling above, not a separate pass tacked onto a
  // finished itinerary.
  const routeReferencePoint =
    finalStops.length > 0
      ? {
          lat: finalStops.reduce((s, x) => s + x.input.lat, 0) / finalStops.length,
          lng: finalStops.reduce((s, x) => s + x.input.lng, 0) / finalStops.length,
        }
      : center;
  const spentSoFar = finalStops.reduce((s, x) => s + (x.input.estimatedCost ?? 0), 0);
  const remainingBudget = req.budget != null ? Math.max(0, req.budget - spentSoFar) : undefined;

  const [restaurant, localFood] = await Promise.all([
    researchRestaurant({
      restaurantCandidates,
      destination: req.destination,
      tripDate,
      routeReferencePoint,
      arrivalTime: req.arrivalTime,
      dayEnd: effectiveDayEnd,
      searchAvailable,
      aiAvailable,
      foodPreferences: req.foodPreferences,
      remainingBudget,
      currency: req.currency,
    }),
    researchLocalFood(req.destination, searchAvailable, aiAvailable),
  ]);

  officialSourceMetrics.domainAttempted += restaurant.officialSourceMetrics.domainAttempted;
  officialSourceMetrics.domainResolved += restaurant.officialSourceMetrics.domainResolved;
  officialSourceMetrics.pageAttempted += restaurant.officialSourceMetrics.pageAttempted;
  officialSourceMetrics.pageResolved += restaurant.officialSourceMetrics.pageResolved;
  officialSourceMetrics.searchQueriesAvoided += restaurant.officialSourceMetrics.searchQueriesAvoided;

  if (restaurant.status === "scheduled" && restaurant.selected) {
    const sel = restaurant.selected;
    finalStops.push({
      input: restaurantStopInput(sel),
      scored: {
        place: { id: sel.stopId, name: sel.name, lat: sel.lat, lng: sel.lng, osmTag: "amenity", osmValue: "restaurant", tags: {}, source: "osm" },
        category: "restaurant",
        notabilityScore: 0,
        distanceFromCenterMeters: 0,
      },
    });
    provenance.push({
      stopId: sel.stopId,
      name: sel.name,
      category: "restaurant",
      openingHoursSource: sel.openingHoursSource,
      openingHoursConfidence: sel.openingHoursConfidence,
      priceSource: sel.estimatedMealCost != null ? "web-research" : "unverified",
      priceConfidence: sel.estimatedMealCost != null ? "medium" : "unknown",
      summarySource: "none",
    });
    trace.push({
      stage: "restaurant",
      status: "ok",
      detail: `${sel.name} seçildi (${sel.mealWindow}, ${sel.menuItems.length} menü öğesi, ${restaurant.consideredCount} aday araştırıldı) — ${sel.selectionReason}`,
    });
  } else {
    trace.push({
      stage: "restaurant",
      status: restaurant.status === "no-meal-window" ? "skipped" : "failed",
      detail: `${restaurant.status}${restaurant.reason ? `: ${restaurant.reason}` : ""} (${restaurant.consideredCount} aday değerlendirildi)`,
    });
  }
  trace.push({
    stage: "local-food",
    status: localFood.status === "found" ? "ok" : localFood.status === "research-unavailable" ? "skipped" : "failed",
    detail: localFood.status === "found" ? `yerel yemek bilgisi bulundu (${localFood.source})` : (localFood.reason ?? localFood.status),
  });

  // --- 5. real routing + the EXISTING deterministic optimizer --------------
  async function routeAndOptimize(
    stopsForRoute: Array<{ input: StopInput }>,
    stageLabel: string
  ): Promise<{
    itinerary: OptimizeResult;
    transitMetadata: ResearchMetadata["transitRouting"];
    matrix: Awaited<ReturnType<typeof fetchMatrix>>;
  }> {
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
        dayEnd: effectiveDayEnd,
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

    return { itinerary: routeItinerary, transitMetadata: routeTransitMetadata, matrix: routeMatrix };
  }

  let { itinerary, transitMetadata, matrix: lastMatrix } = await routeAndOptimize(finalStops, "routing");

  const mustSeeIds = new Set(
    finalStops
      .filter((s) => (req.mustSeeNames ?? []).some((n) => s.input.name.toLowerCase().includes(n.toLowerCase())))
      .map((s) => s.input.id)
  );

  // --- 5b. route-aware hidden-gem engine (spec §Priority 5) ----------------
  // Needs the route's real geometry, so this can only run AFTER the first
  // itinerary exists — real corridor, not a guess from the destination's
  // center. Entirely network-free: re-filters the SAME candidates already
  // discovered for the whole destination (scored, from step 3) by real
  // distance to the actual path, escalating 100/200/300m. A find is
  // inserted into finalStops and the WHOLE optimizer is re-run — never
  // appended to the finished schedule — so it competes for a real slot
  // exactly like any other stop and can still be dropped later by budget
  // or departure-safety replanning if the day doesn't have room for it.
  let hiddenGems: HiddenGemResult = { status: "none", found: [] };
  const orderedRoutePoints = [
    start,
    ...[...itinerary.stops].sort((a, b) => a.order - b.order).map((s) => ({ lat: s.lat, lng: s.lng })),
    ...(req.endLocation ? [req.endLocation] : []),
  ];
  if (orderedRoutePoints.length < 2) {
    hiddenGems = { status: "skipped", found: [], reason: "rota için yeterli durak yok" };
  } else {
    const usedIds = new Set(finalStops.map((s) => s.input.id));
    // Bad weather also rules out an outdoor hidden gem specifically — the
    // same real routing-decision change as the shortlist weighting above,
    // applied to this later, separate discovery stage too.
    const gemCandidatePool = weather.badWeatherDay ? scored.filter((c) => !isOutdoorCategory(c.category)) : scored;
    const gemFindings = findHiddenGemsNearCorridor(gemCandidatePool, orderedRoutePoints, usedIds);

    const addedGems: HiddenGemFound[] = [];
    for (const finding of gemFindings) {
      const p = finding.candidate.place;
      let earliestTime: string | undefined;
      let latestTime: string | undefined;
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
          }
        }
      }
      if (excludedAsClosed) continue; // a real gem we know is shut that day is not scheduled

      finalStops.push({
        input: {
          id: p.id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          category: finding.candidate.category,
          earliestTime,
          latestTime,
          estimatedCost: p.tags.fee === "no" ? 0 : undefined,
        },
        scored: finding.candidate,
      });
      provenance.push({
        stopId: p.id,
        name: p.name,
        category: finding.candidate.category,
        openingHoursSource: osmHours && earliestTime ? "osm" : "unverified",
        openingHoursConfidence: osmHours && earliestTime ? "high" : "unknown",
        priceSource: "unverified",
        priceConfidence: "unknown",
        summarySource: "none",
      });
      addedGems.push({
        stopId: p.id,
        name: p.name,
        category: finding.candidate.category,
        distanceMeters: Math.round(finding.distanceMeters),
        radiusTierMeters: finding.radiusTierMeters,
      });
    }

    if (addedGems.length > 0) {
      hiddenGems = { status: "found", found: addedGems };
      ({ itinerary, transitMetadata, matrix: lastMatrix } = await routeAndOptimize(finalStops, "hidden-gem-reroute"));
      trace.push({
        stage: "hidden-gem",
        status: "ok",
        detail: `${addedGems.length} gizli hazine bulundu (${addedGems.map((g) => `${g.name}, ${g.distanceMeters} m`).join("; ")}) — plan yeniden optimize edildi`,
      });
    } else {
      hiddenGems = { status: "none", found: [] };
      trace.push({
        stage: "hidden-gem",
        status: "ok",
        detail: "rota koridorunun 300 m yakınında yeni bir gizli hazine bulunamadı",
      });
    }
  }

  // --- 6. real budget replanning, not a passive warning --------------------
  let budgetOptimization: BudgetOptimizationResult | null = null;
  if (req.budget != null) {
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
        ({ itinerary, transitMetadata, matrix: lastMatrix } = await routeAndOptimize(finalStops, "budget-reroute"));
      }
    }
  }

  // --- 6b. departure safety: replan if the schedule risks missing it ------
  // Same removal-priority idea as budget-optimizer.ts (least-notable,
  // non-protected stop first) but keyed on real schedule overrun rather than
  // cost — reuses the same mustSeeIds protection and the same
  // routeAndOptimize closure, never inventing a new optimizer path.
  let departureReplanAttempts = 0;
  while (itinerary.overrunMinutes > 0 && departureReplanAttempts < finalStops.length) {
    const removable = finalStops
      .filter((s) => !mustSeeIds.has(s.input.id) && !s.input.locked && !s.input.fixedTime)
      .sort((a, b) => a.scored.notabilityScore - b.scored.notabilityScore);
    const target = removable[0];
    if (!target) break; // nothing left we're allowed to remove
    finalStops = finalStops.filter((s) => s.input.id !== target.input.id);
    provenance = provenance.filter((p) => p.stopId !== target.input.id);
    departureReplanAttempts++;
    ({ itinerary, transitMetadata, matrix: lastMatrix } = await routeAndOptimize(finalStops, "departure-safety-reroute"));
  }
  if (departureReplanAttempts > 0) {
    trace.push({
      stage: "departure-safety",
      status: itinerary.overrunMinutes === 0 ? "ok" : "failed",
      detail:
        itinerary.overrunMinutes === 0
          ? `Kalkış güvenliği için ${departureReplanAttempts} durak çıkarıldı, plan artık güvenli varış saatine uyuyor`
          : `${departureReplanAttempts} durak çıkarıldıktan sonra bile kalkış güvenliği sağlanamadı (zorunlu/sabit/kilitli duraklar korundu)`,
    });
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
    officialSource: officialSourceMetrics,
  };

  const departureSafety: DepartureSafetyResult = {
    hasDeparturePoint: req.endLocation != null,
    bufferMinutes: departureBufferMinutes,
    requestedDepartureTime: req.departureTime,
    latestSafeArrivalTime: effectiveDayEnd,
    safe: itinerary.overrunMinutes === 0,
    overrunMinutes: itinerary.overrunMinutes,
  };
  if (!departureSafety.safe) {
    trace.push({
      stage: "departure-safety",
      status: "failed",
      detail: `Plan, güvenli varış saatinden (${effectiveDayEnd}) ${itinerary.overrunMinutes} dakika sonra tamamlanıyor — kalkışı kaçırma riski var.`,
    });
  }

  // --- 7. delay simulation — real robustness check, no new network calls --
  // Reuses the same real routing matrix and the same deterministic
  // optimizer; only the simulated start time changes, so this tests
  // exactly what a real late start (a delayed train, a slow first leg)
  // would do to fixed events, closing-time constraints, and the departure
  // cutoff — not a separate, parallel model of the day.
  const DELAY_INCREMENTS_MIN = [5, 10, 15, 20, 30];
  const delaySimulation: DelaySimulationResult[] = DELAY_INCREMENTS_MIN.map((delayMinutes) => {
    const simulated = optimizeItinerary(
      {
        stops: finalStops.map((s) => s.input),
        dayStart: addMinutes(req.arrivalTime, delayMinutes),
        dayEnd: effectiveDayEnd,
        start,
        end: req.endLocation,
      },
      lastMatrix
    );
    return {
      delayMinutes,
      feasible: simulated.feasible,
      conflictCount: simulated.conflicts.length,
      departureSafe: simulated.overrunMinutes === 0,
    };
  });
  const fragileAtMinutes = delaySimulation.find((d) => !d.feasible || !d.departureSafe)?.delayMinutes ?? null;
  if (fragileAtMinutes != null) {
    trace.push({
      stage: "delay-simulation",
      status: "failed",
      detail: `Plan +${fragileAtMinutes} dakika gecikmeyle artık uygun/güvenli değil — kırılgan bir segment var.`,
    });
  } else {
    trace.push({
      stage: "delay-simulation",
      status: "ok",
      detail: `Plan test edilen tüm gecikmelere (+${DELAY_INCREMENTS_MIN[DELAY_INCREMENTS_MIN.length - 1]} dakikaya kadar) karşı dayanıklı`,
    });
  }

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
    events,
    restaurant,
    localFood,
    hiddenGems,
    weather,
    departureSafety,
    delaySimulation,
    fragileAtMinutes,
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
