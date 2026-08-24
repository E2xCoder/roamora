import "server-only";
import type { ScoredCandidate } from "@/server/services/discovery-scoring";
import type { StopInput } from "@/server/services/itinerary-optimizer";
import { resolveOpeningHoursForDate, widestWindow } from "@/lib/opening-hours";
import { searxngProvider, SearchUnavailableError } from "@/server/providers/research/searxng";
import { extractFactsFromText, htmlToPlainText, ExtractionUnavailableError } from "@/server/services/fact-extraction";
import { validateExtractedOpeningHours } from "@/server/services/opening-hours-guard";
import { validateExtractedPrice } from "@/server/services/price-guard";
import { extractMenuFromText, extractLocalFoodFromText, extractJsonLdMenuItems, type ExtractedMenuItem } from "@/server/services/restaurant-extraction";
import { isMenuItemNameSupported, isLikelyNavigationLabel, estimateQueueSignal, scoreTouristTrapRisk, type QueueEstimate, type TouristTrapRisk } from "@/server/services/restaurant-guard";
import { scoreConfidence, detectStaleness, selectBestResult, type ConfidenceLevel } from "@/server/services/confidence";
import { fetchTextCapped } from "@/server/services/url-safety";
import { resolveResearchSource } from "@/server/services/direct-research";
import { checkPageContent } from "@/server/services/official-site-crawler";
import { fetchWikivoyageEatSection, cityNameForWikivoyageSearch } from "@/server/services/wikivoyage-research";

/**
 * Priority 3 — restaurant and menu intelligence.
 *
 * Reuses every existing verification primitive this pipeline already has
 * (the opening-hours guard, the price guard, confidence scoring, SearXNG's
 * cached/health-tracked search) rather than building a parallel system — a
 * restaurant is just a place whose hours/price research questions are
 * already solved by autoplan.ts's main enrichment loop; what this module
 * adds on top is menu-item extraction, meal-window-aware selection, and the
 * two purely evidence-based scorers (queue signal, tourist-trap risk) that
 * have no attraction-side equivalent.
 *
 * Like every other autoplan.ts research path, this is transient: a chosen
 * restaurant and its extracted menu are returned in the API response, not
 * written to the database. `MenuItem` (schema.prisma) exists for the moment
 * a user explicitly saves a restaurant as a Place — the same relationship
 * `Place.provenance`/`Place.sources` already have to autoplan's other
 * ephemeral research.
 */

export interface MealWindow {
  name: "lunch" | "dinner";
  earliest: string;
  latest: string;
}

const MEAL_WINDOWS: MealWindow[] = [
  { name: "lunch", earliest: "12:00", latest: "14:30" },
  { name: "dinner", earliest: "18:00", latest: "21:00" },
];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Which of the day's meal windows actually overlap the trip's active hours — real trip logistics, not a guess at when the traveller wants to eat. */
export function mealWindowsFor(arrivalTime: string, dayEnd: string): MealWindow[] {
  const arr = toMinutes(arrivalTime);
  const end = toMinutes(dayEnd);
  return MEAL_WINDOWS.filter((w) => toMinutes(w.earliest) < end && toMinutes(w.latest) > arr);
}

export interface MenuItemResult {
  category: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  portion?: string;
  isLocalSpecialty: boolean;
  isVegetarian: boolean;
  isVegan: boolean;
  priceType?: "standard" | "minimum" | "reduced";
  source: "web-research" | "unverified";
  confidence: ConfidenceLevel;
  checkedAt?: string;
}

/**
 * Honest, per-restaurant menu reporting (production-hardening spec §3):
 * "no-source" — research never ran or found nothing to fetch at all.
 * "unavailable" — a real page was fetched but genuinely had no retrievable
 * menu (JS-rendered shell, unparsable PDF, or real content with nothing a
 * guard would trust) — `reason` says which. "extracted" — menuItems has at
 * least one guard-verified item.
 */
export interface MenuAvailability {
  status: "extracted" | "no-source" | "unavailable";
  reason?: string;
}

export interface RestaurantCandidateResult {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  cuisine?: string;
  openingHoursSource: "osm" | "web-research" | "unverified";
  openingHoursConfidence: ConfidenceLevel;
  mealWindow: MealWindow["name"];
  menuItems: MenuItemResult[];
  menuAvailability: MenuAvailability;
  estimatedMealCost?: number;
  currency?: string;
  touristTrapRisk: TouristTrapRisk | "UNKNOWN";
  touristTrapReasons: string[];
  queueEstimate: QueueEstimate | null;
  routeDetourMeters: number;
  score: number;
  scoreBreakdown: Record<string, number>;
  source: string; // page URL used, or "osm" when no web research ran
  selectionReason: string;
}

export interface RestaurantResearchResult {
  status: "scheduled" | "no-meal-window" | "no-candidates" | "research-unavailable" | "no-suitable-candidate";
  selected?: RestaurantCandidateResult;
  considered: RestaurantCandidateResult[];
  consideredCount: number;
  reason?: string;
  /** Second-stage direct-research metrics accumulated across every candidate researched — merged into autoplan.ts's overall officialSource metrics. */
  officialSourceMetrics: {
    domainAttempted: number;
    domainResolved: number;
    pageAttempted: number;
    pageResolved: number;
    searchQueriesAvoided: number;
  };
}

export interface LocalFoodEntry {
  name: string;
  description?: string;
}

export interface LocalFoodResult {
  status: "found" | "not-found" | "research-unavailable" | "failed";
  iconicDish?: LocalFoodEntry;
  traditionalDish?: LocalFoodEntry;
  dessert?: LocalFoodEntry;
  bakerySpecialty?: LocalFoodEntry;
  localDrink?: LocalFoodEntry;
  affordableLocalOption?: LocalFoodEntry;
  source?: string;
  /** Which tier actually supplied the source text — Wikivoyage's own curated "Eat" section is tried before a generic web search. */
  sourceType?: "wikivoyage" | "web-search";
  /** Real, named food/restaurant listings from Wikivoyage's structured {{eat|...}} entries, when that source was used — independent of the six named fields above, and never LLM-derived. */
  curatedListings?: Array<{ name: string; description?: string }>;
  reason?: string;
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function keepLocalFoodEntry(
  entry: { name: string; description: string | null } | null,
  sourceText: string
): LocalFoodEntry | undefined {
  if (!entry) return undefined;
  if (!isMenuItemNameSupported(entry.name, sourceText)) return undefined; // not actually on the page — dropped, not invented
  return { name: entry.name, description: entry.description ?? undefined };
}

function hasAnyLocalFoodField(r: LocalFoodResult): boolean {
  return !!(r.iconicDish || r.traditionalDish || r.dessert || r.bakerySpecialty || r.localDrink || r.affordableLocalOption);
}

/**
 * Researches destination-level local food facts (spec §Priority 4) —
 * independent of any specific restaurant. Tries Wikivoyage's own curated
 * "Eat" section first (real, community-maintained travel-guide content
 * with structured, named listings — a genuinely more authoritative source
 * than a ranked web-search hit that might land anywhere), falling back to
 * a generic SearXNG search only when Wikivoyage has no article or no Eat
 * section for the destination at all. Every non-null field, from either
 * tier, is independently re-checked for real textual support in the
 * fetched source before being trusted; a field the model returned but that
 * never actually appears on the page is dropped, not passed through.
 */
export async function researchLocalFood(
  destination: string,
  searchAvailable: boolean,
  aiAvailable: boolean
): Promise<LocalFoodResult> {
  if (!aiAvailable) {
    return { status: "research-unavailable", reason: "AI sağlayıcı yapılandırılmamış" };
  }

  // --- tier 1: Wikivoyage's own curated Eat section -----------------------
  // Only the city portion is searched here (see
  // cityNameForWikivoyageSearch's docstring for the real bug this fixes);
  // the SearXNG fallback below still uses the full destination string.
  try {
    const eat = await fetchWikivoyageEatSection(cityNameForWikivoyageSearch(destination));
    if (eat) {
      const facts = await extractLocalFoodFromText(destination, eat.text);
      if (facts) {
        const result: LocalFoodResult = {
          status: "found",
          iconicDish: keepLocalFoodEntry(facts.iconicDish, eat.text),
          traditionalDish: keepLocalFoodEntry(facts.traditionalDish, eat.text),
          dessert: keepLocalFoodEntry(facts.dessert, eat.text),
          bakerySpecialty: keepLocalFoodEntry(facts.bakerySpecialty, eat.text),
          localDrink: keepLocalFoodEntry(facts.localDrink, eat.text),
          affordableLocalOption: keepLocalFoodEntry(facts.affordableLocalOption, eat.text),
          source: eat.articleUrl,
          sourceType: "wikivoyage",
          curatedListings: eat.listings.length > 0 ? eat.listings : undefined,
        };
        if (hasAnyLocalFoodField(result) || result.curatedListings) return result;
      }
      // Wikivoyage had an Eat section but nothing usable came out of it —
      // fall through to the search tier rather than reporting not-found
      // prematurely (a short Eat section can have real listings but no
      // narrative prose the extractor can use).
    }
  } catch {
    // Wikivoyage tier failure never aborts the whole lookup.
  }

  // --- tier 2: existing generic SearXNG fallback --------------------------
  if (!searchAvailable) {
    return { status: "research-unavailable", reason: "Wikivoyage'da sonuç yok, arama sağlayıcı da yapılandırılmamış" };
  }
  try {
    const results = await searxngProvider.searchWeb(
      `${destination} local food specialties traditional dishes must try`,
      5
    );
    const page = selectBestResult(results, destination);
    if (!page) return { status: "not-found", reason: "arama sonucu yok" };

    const fetched = await fetchTextCapped(page.url);
    if (!fetched.ok) return { status: "not-found", reason: fetched.reason };

    const sourceText = htmlToPlainText(fetched.text);
    const facts = await extractLocalFoodFromText(destination, fetched.text);
    if (!facts) return { status: "not-found", reason: "sayfadan yerel yemek bilgisi çıkarılamadı" };

    const result: LocalFoodResult = {
      status: "found",
      iconicDish: keepLocalFoodEntry(facts.iconicDish, sourceText),
      traditionalDish: keepLocalFoodEntry(facts.traditionalDish, sourceText),
      dessert: keepLocalFoodEntry(facts.dessert, sourceText),
      bakerySpecialty: keepLocalFoodEntry(facts.bakerySpecialty, sourceText),
      localDrink: keepLocalFoodEntry(facts.localDrink, sourceText),
      affordableLocalOption: keepLocalFoodEntry(facts.affordableLocalOption, sourceText),
      source: page.url,
      sourceType: "web-search",
    };
    if (!hasAnyLocalFoodField(result)) {
      return { status: "not-found", reason: "çıkarılan alanların hiçbiri kaynak sayfada doğrulanamadı" };
    }
    return result;
  } catch (err) {
    const reason =
      err instanceof SearchUnavailableError || err instanceof ExtractionUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : "yerel yemek araştırması başarısız";
    return { status: "failed", reason };
  }
}

export interface RestaurantResearchParams {
  restaurantCandidates: ScoredCandidate[];
  destination: string;
  tripDate: Date;
  routeReferencePoint: { lat: number; lng: number };
  arrivalTime: string;
  dayEnd: string;
  searchAvailable: boolean;
  aiAvailable: boolean;
  foodPreferences?: string[];
  remainingBudget?: number;
  currency?: string;
}

const MAX_RESTAURANT_RESEARCH_CALLS = 5;
const CANDIDATE_POOL_SIZE = 8; // candidates actually researched (real network calls), bounding real cost
const DISTANCE_SHORTLIST_SIZE = 24; // cheap, no-network candidates considered for the pre-score below

/**
 * Free, no-network pre-score used only to decide WHICH candidates are worth
 * spending the bounded real-research budget on — distance alone used to be
 * the sole filter here (nearest 8, full stop), which means a highly notable,
 * exactly-cuisine-matching restaurant a few hundred metres further away
 * could never even be researched if 8 closer, unremarkable places existed —
 * and central old-town districts routinely have that many restaurants
 * within a very small radius. Distance still dominates (a genuinely good
 * restaurant 2km off-route is still a bad choice), but notability and a
 * stated cuisine preference — both already-available, free signals — now
 * get a real say in which candidates are worth fetching at all, not just in
 * ranking the ones that already made the cut.
 */
export function preScoreRestaurantCandidate(
  candidate: ScoredCandidate,
  detourMeters: number,
  foodPreferences?: string[]
): number {
  const distanceScore = Math.max(0, 25 - detourMeters / 100); // same taper as the final routeCompat term
  const notabilityScore = Math.min(10, candidate.notabilityScore * 2);
  let cuisineScore = 0;
  const cuisine = candidate.place.tags.cuisine;
  if (cuisine && foodPreferences && foodPreferences.length > 0) {
    if (foodPreferences.join(" ").toLowerCase().includes(cuisine.toLowerCase())) cuisineScore = 10;
  }
  return distanceScore + notabilityScore + cuisineScore;
}

/**
 * Selects and researches one restaurant for the trip's first reachable meal
 * window (spec §Priority 3, end-to-end 1-9). Returns a stop ready to be
 * inserted into `finalStops` BEFORE the optimizer runs (§7 — "inserted into
 * the deterministic optimizer rather than appended afterward") — the caller
 * is responsible for that insertion and for re-running `routeAndOptimize`,
 * exactly like autoplan.ts's event scheduling already does.
 */
function emptyOfficialSourceMetrics() {
  return { domainAttempted: 0, domainResolved: 0, pageAttempted: 0, pageResolved: 0, searchQueriesAvoided: 0 };
}

export async function researchRestaurant(params: RestaurantResearchParams): Promise<RestaurantResearchResult> {
  const windows = mealWindowsFor(params.arrivalTime, params.dayEnd);
  if (windows.length === 0) {
    return { status: "no-meal-window", considered: [], consideredCount: 0, reason: "gezi süresine uyan bir öğün penceresi yok", officialSourceMetrics: emptyOfficialSourceMetrics() };
  }
  if (params.restaurantCandidates.length === 0) {
    return { status: "no-candidates", considered: [], consideredCount: 0, reason: "OpenStreetMap'te restoran adayı bulunamadı", officialSourceMetrics: emptyOfficialSourceMetrics() };
  }

  // Distance narrows the field first (still real, cheap, no-network), then
  // notability/cuisine-fit decide which of those are actually worth
  // researching — not distance alone, see preScoreRestaurantCandidate.
  const pool = [...params.restaurantCandidates]
    .map((c) => ({ c, detourMeters: haversineMeters(params.routeReferencePoint, c.place) }))
    .sort((a, b) => a.detourMeters - b.detourMeters)
    .slice(0, DISTANCE_SHORTLIST_SIZE)
    .sort(
      (a, b) =>
        preScoreRestaurantCandidate(b.c, b.detourMeters, params.foodPreferences) -
        preScoreRestaurantCandidate(a.c, a.detourMeters, params.foodPreferences)
    )
    .slice(0, CANDIDATE_POOL_SIZE);

  const considered: RestaurantCandidateResult[] = [];
  const officialSourceMetrics = emptyOfficialSourceMetrics();
  let researchCalls = 0;

  for (const { c: candidate, detourMeters } of pool) {
    const p = candidate.place;

    // --- opening hours: OSM first, exactly like the main enrichment loop ---
    let openingSource: RestaurantCandidateResult["openingHoursSource"] = "unverified";
    let openingConfidence: ConfidenceLevel = "unknown";
    let earliestTime: string | undefined;
    let latestTime: string | undefined;
    let excludedAsClosed = false;

    const osmHours = p.tags.opening_hours;
    if (osmHours) {
      const resolved = resolveOpeningHoursForDate(osmHours, params.tripDate);
      if (resolved.status === "closed") {
        excludedAsClosed = true;
      } else if (resolved.status === "open" || resolved.status === "always") {
        const window = widestWindow(resolved);
        if (window) {
          earliestTime = window.open;
          latestTime = window.close;
          openingSource = "osm";
          openingConfidence = "high";
        }
      }
    }
    if (excludedAsClosed) continue;

    // Which meal window this restaurant can actually serve — real hours
    // (when known) intersected with the trip's reachable windows; when
    // hours are unknown, the meal window alone is still a real, legitimate
    // constraint derived from trip logistics, not fabricated data.
    let usableWindow: MealWindow | undefined;
    for (const w of windows) {
      if (earliestTime && latestTime) {
        const overlap = toMinutes(earliestTime) < toMinutes(w.latest) && toMinutes(latestTime) > toMinutes(w.earliest);
        if (overlap) { usableWindow = w; break; }
      } else {
        usableWindow = w;
        break;
      }
    }
    if (!usableWindow) continue; // known hours never overlap any reachable meal window

    let menuItems: MenuItemResult[] = [];
    let menuAvailability: MenuAvailability = { status: "no-source" };
    let sourceUrl = "osm";
    let touristTrapRisk: RestaurantCandidateResult["touristTrapRisk"] = "UNKNOWN";
    let touristTrapReasons: string[] = [];
    let queueEstimate: QueueEstimate | null = null;
    let fallbackCost: number | undefined;
    let fallbackCurrency: string | undefined;

    const wantsResearch = params.searchAvailable && params.aiAvailable && researchCalls < MAX_RESTAURANT_RESEARCH_CALLS;
    menuAvailability = wantsResearch
      ? { status: "no-source", reason: "araştırma yapıldı ama hiçbir kaynak bulunamadı" }
      : { status: "no-source", reason: params.searchAvailable ? "araştırma çağrı sınırına ulaşıldı" : "arama/AI kullanılamıyor" };
    if (wantsResearch) {
      researchCalls++;
      try {
        // Second-stage research: resolve the restaurant's own official site
        // and go straight for its menu page, before falling back to a
        // generic SearXNG query — the exact fix for the wrong-page-selected
        // problem measured live in Priority 3 (e.g. a restaurant name
        // colliding with an unrelated support/Wikipedia/YouTube page).
        const { source, metrics } = await resolveResearchSource(
          p.name,
          params.destination,
          p.tags,
          "menu",
          `"${p.name}" ${params.destination} restaurant menu prices`,
          params.searchAvailable
        );
        officialSourceMetrics.domainAttempted += metrics.officialDomainAttempted ? 1 : 0;
        officialSourceMetrics.domainResolved += metrics.officialDomainResolved ? 1 : 0;
        officialSourceMetrics.pageAttempted += metrics.officialPageAttempted ? 1 : 0;
        officialSourceMetrics.pageResolved += metrics.officialPageResolved ? 1 : 0;
        officialSourceMetrics.searchQueriesAvoided += metrics.searchQueryAvoided ? 1 : 0;

        if (source) {
          sourceUrl = source.url;
          // PDF text is already real extracted text (pdf-extraction.ts), not
          // markup — running the HTML-tag-stripping transform on it again
          // would be a needless (if mostly harmless) no-op at best.
          const sourceText = source.wasPdf ? source.text : htmlToPlainText(source.text);
          const official = source.official;
          const stale = detectStaleness(sourceText);

          // Hours fallback when OSM had none — same guard as the main loop.
          if (!osmHours) {
            const facts = await extractFactsFromText(p.name, source.text);
            if (facts) {
                const guardResult = validateExtractedOpeningHours(facts.facts.openingHoursText, facts.facts.hoursScope, sourceText);
                if (guardResult.status === "specific-hours") {
                  const resolved = resolveOpeningHoursForDate(guardResult.osmSyntax, params.tripDate);
                  if (resolved.status === "open" || resolved.status === "always") {
                    const window = widestWindow(resolved);
                    if (window) {
                      earliestTime = window.open;
                      latestTime = window.close;
                      openingSource = "web-research";
                      openingConfidence = scoreConfidence({
                        textuallySupported: true,
                        officialSource: official,
                        extractionAmbiguous: !facts.facts.hoursScope || facts.facts.hoursScope === "unclear",
                        stale,
                        multiSourceAgreement: null,
                      });
                    }
                  } else if (resolved.status === "closed") {
                    excludedAsClosed = true;
                  }
                } else if (guardResult.status === "closed") {
                  excludedAsClosed = true;
                }
                const priceGuardResult = validateExtractedPrice(facts.facts.priceAmount, facts.facts.priceCurrency, sourceText);
                if (priceGuardResult.status !== "unknown") {
                  fallbackCost = priceGuardResult.amount;
                  fallbackCurrency = facts.facts.priceCurrency ?? undefined;
                }
              }
            }

          if (!excludedAsClosed) {
            // Real content check before attempting extraction at all — the
            // fix for a page that fetches fine (HTTP 200) but is a
            // JS-rendered shell with almost no static content (live-
            // confirmed: fulumandarijn.com/menu, 199KB HTML / 764 real
            // characters). The old check here operated on raw HTML byte
            // length, which is large for exactly this kind of page — this
            // one checks real extractable text instead, and reports the gap
            // honestly rather than running an extractor against near-empty
            // input and silently returning zero items with no explanation.
            const rawLength = source.wasPdf ? 0 : source.text.length;
            const contentCheck = checkPageContent(rawLength, sourceText);

            if (contentCheck.looksEmpty) {
              menuAvailability = {
                status: "unavailable",
                reason: source.wasPdf
                  ? "PDF'den gerçek metin çıkarılamadı"
                  : `sayfa büyük ölçüde JS ile oluşturulmuş görünüyor (yalnızca ${contentCheck.realTextChars} karakter gerçek metin bulundu) — statik olarak menü içeriği alınamadı`,
              };
            } else {
              // Real schema.org Menu structured data first — zero LLM risk,
              // the site's own markup, tried before any model call (spec §3:
              // "inspect JSON-LD"). Only meaningful for real HTML, not
              // already-extracted PDF text.
              const jsonLdItems = source.wasPdf ? [] : extractJsonLdMenuItems(source.text, p.name);
              const usedJsonLd = jsonLdItems.length > 0;
              const extracted = usedJsonLd ? jsonLdItems : await extractMenuFromText(p.name, source.text);

              menuItems = extracted
                .filter((item: ExtractedMenuItem) => isMenuItemNameSupported(item.name, sourceText)) // never invented — must actually be on the page
                .filter((item: ExtractedMenuItem) => !isLikelyNavigationLabel(item.name)) // not a nav/category link mistaken for a dish (real case: fulumandarijn.com/menu's "Food Menu"/"Drink Menu"/"Member Menu"/"Home Menu")
                .map((item: ExtractedMenuItem): MenuItemResult => {
                  // JSON-LD prices live inside <script> tags, which
                  // htmlToPlainText strips — validateExtractedPrice's
                  // visible-text-presence check would reject every genuine
                  // structured price for that reason alone, not because it's
                  // wrong. The site's own structured markup is trusted
                  // directly instead, same as how search engines consume it.
                  const priceGuardResult = usedJsonLd
                    ? (item.price != null ? { status: "valid" as const, amount: item.price } : { status: "unknown" as const })
                    : validateExtractedPrice(item.price, item.currency, sourceText);
                  const hasPrice = priceGuardResult.status !== "unknown";
                  return {
                    category: item.category,
                    name: item.name,
                    description: item.description ?? undefined,
                    price: hasPrice ? priceGuardResult.amount : undefined,
                    currency: hasPrice ? (item.currency ?? undefined) : undefined,
                    portion: item.portion ?? undefined,
                    isLocalSpecialty: item.isLocalSpecialty,
                    isVegetarian: item.isVegetarian,
                    isVegan: item.isVegan,
                    priceType: hasPrice
                      ? (priceGuardResult.status === "valid" ? "standard" : priceGuardResult.status === "valid-minimum" ? "minimum" : "reduced")
                      : undefined,
                    source: hasPrice ? "web-research" : "unverified",
                    confidence: hasPrice
                      ? scoreConfidence({ textuallySupported: !usedJsonLd, officialSource: official || usedJsonLd, extractionAmbiguous: !usedJsonLd && priceGuardResult.status !== "valid", stale, multiSourceAgreement: null })
                      : "unknown",
                    checkedAt: new Date().toISOString(),
                  };
                });

              menuAvailability = menuItems.length > 0
                ? { status: "extracted" }
                : { status: "unavailable", reason: "sayfada gerçek içerik var ama güvenilir bir menü öğesi bulunamadı" };

              const trap = scoreTouristTrapRisk(sourceText, official);
              touristTrapRisk = trap.risk;
              touristTrapReasons = trap.reasons;
              queueEstimate = estimateQueueSignal(sourceText);
            }
          }
        }
      } catch {
        // Network/extraction failure for this one candidate — it simply
        // stays at OSM-only/unverified level, exactly like the main loop's
        // per-stop try/catch; one candidate's research failure must not
        // abort researching the rest of the pool.
        menuAvailability = { status: "unavailable", reason: "araştırma sırasında bir hata oluştu" };
      }
    }
    if (excludedAsClosed) continue;

    const pricedItems = menuItems.filter((m) => m.price != null).map((m) => m.price!);
    const estimatedMealCost = median(pricedItems) ?? fallbackCost;
    const currency = menuItems.find((m) => m.currency)?.currency ?? fallbackCurrency ?? params.currency;

    // --- deterministic composite score, fully transparent breakdown -------
    const breakdown: Record<string, number> = {};
    breakdown.routeCompat = Math.max(0, 25 - detourMeters / 100); // closer = higher, tapers to 0 past ~2.5km
    breakdown.openingHoursFit = openingSource === "osm" ? 15 : openingSource === "web-research" ? 10 : 0;
    breakdown.cuisineRelevance = 0;
    const cuisine = p.tags.cuisine;
    if (params.foodPreferences && params.foodPreferences.length > 0) {
      const prefText = params.foodPreferences.join(" ").toLowerCase();
      if (cuisine && prefText.includes(cuisine.toLowerCase())) breakdown.cuisineRelevance += 15;
      if (menuItems.some((m) => m.isLocalSpecialty)) breakdown.cuisineRelevance += 5;
    }
    breakdown.priceFit = 10; // neutral default when cost is unknown — an unknown cost is not penalized, matching budget-optimizer.ts's existing discipline
    if (estimatedMealCost != null && params.remainingBudget != null) {
      breakdown.priceFit = estimatedMealCost <= params.remainingBudget ? 15 : -10;
    }
    breakdown.touristTrapAdjustment = touristTrapRisk === "HIGH" ? -25 : touristTrapRisk === "MEDIUM" ? -10 : 0;
    breakdown.notability = Math.min(10, candidate.notabilityScore * 2);
    const score = Object.values(breakdown).reduce((s, v) => s + v, 0);

    const reasonParts: string[] = [];
    reasonParts.push(`${Math.round(detourMeters)} m rota sapması`);
    if (openingSource !== "unverified") reasonParts.push(`açılış saati ${openingSource === "osm" ? "OSM'den" : "web araştırmasından"} doğrulandı`);
    if (menuItems.length > 0) reasonParts.push(`${menuItems.length} menü öğesi bulundu`);
    if (touristTrapRisk !== "UNKNOWN" && touristTrapRisk !== "LOW") reasonParts.push(`turist tuzağı riski: ${touristTrapRisk}`);

    considered.push({
      stopId: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      cuisine,
      openingHoursSource: openingSource,
      openingHoursConfidence: openingConfidence,
      mealWindow: usableWindow.name,
      menuItems,
      menuAvailability,
      estimatedMealCost,
      currency,
      touristTrapRisk,
      touristTrapReasons,
      queueEstimate,
      routeDetourMeters: Math.round(detourMeters),
      score,
      scoreBreakdown: breakdown,
      source: sourceUrl,
      selectionReason: reasonParts.join(", "),
    });
  }

  if (considered.length === 0) {
    return {
      status: "no-suitable-candidate",
      considered: [],
      consideredCount: pool.length,
      reason: "araştırılan hiçbir restoran adayı bu tarihte/öğün penceresinde uygun değildi",
      officialSourceMetrics,
    };
  }

  considered.sort((a, b) => b.score - a.score);
  const selected = considered[0];

  return {
    status: "scheduled",
    selected,
    considered,
    consideredCount: pool.length,
    officialSourceMetrics,
  };
}

/** Builds the StopInput for a selected restaurant — inserted into finalStops before the optimizer runs, same pattern as autoplan.ts's scheduleEventStop. */
export function restaurantStopInput(selected: RestaurantCandidateResult): StopInput {
  const window = MEAL_WINDOWS.find((w) => w.name === selected.mealWindow)!;
  return {
    id: selected.stopId,
    name: selected.name,
    lat: selected.lat,
    lng: selected.lng,
    category: "restaurant",
    earliestTime: window.earliest,
    latestTime: window.latest,
    estimatedCost: selected.estimatedMealCost,
  };
}
