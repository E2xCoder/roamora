/**
 * Client-side shapes + helpers for driving the real autoplan() pipeline
 * from the browser — shared between the Plan (creation) screen and the
 * trip result screen so both talk to /api/itinerary/autoplan(/options) and
 * /api/trips/from-autoplan the same way. Mirrors
 * src/server/services/autoplan.ts / trip-options.ts / job-runner.ts; only
 * the fields the UI actually renders are declared.
 */

export interface AutoplanStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  order: number;
  arrivalTime: string;
  departureTime: string;
  visitMinutes: number;
  waitMinutes: number;
  travelFromPrevMeters: number;
  travelFromPrevSeconds: number;
}

export interface AutoplanConflict {
  stopId: string;
  stopName: string;
  kind: "fixed-time-missed" | "latest-time-missed" | "unplaceable" | "day-overrun";
  detail: string;
}

export interface StopProvenance {
  stopId: string;
  name: string;
  category: string;
  openingHoursSource: "osm" | "web-research" | "unverified";
  openingHoursConfidence: "high" | "medium" | "low" | "unknown";
  priceSource: "osm" | "web-research" | "unverified";
  priceConfidence: "high" | "medium" | "low" | "unknown";
  priceType?: "standard" | "minimum" | "reduced";
  priceCurrency?: string;
  sourceType?: "official" | "secondary" | "unverified";
  officialDomain?: string;
  summarySource: "wikipedia" | "none";
  summaryText?: string;
  summaryUrl?: string;
  estimatedCost?: number;
  earliestTime?: string;
  latestTime?: string;
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
  source: "web-research" | "unverified";
}

export interface RestaurantCandidateResult {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  cuisine?: string;
  mealWindow: "lunch" | "dinner";
  menuItems: MenuItemResult[];
  menuAvailability: { status: "extracted" | "no-source" | "unavailable"; reason?: string };
  estimatedMealCost?: number;
  currency?: string;
  touristTrapRisk: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  queueEstimate: { level: string; reason: string } | null;
  routeDetourMeters: number;
  selectionReason: string;
}

export interface RestaurantResearchResult {
  status: "scheduled" | "no-meal-window" | "no-candidates" | "research-unavailable" | "no-suitable-candidate";
  selected?: RestaurantCandidateResult;
  reason?: string;
}

export interface HiddenGemFound {
  stopId: string;
  name: string;
  category: string;
  distanceMeters: number;
  description?: string;
  sourceUrl?: string;
}

export interface WeatherForecast {
  condition: "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm";
  temperatureMinC?: number;
  temperatureMaxC?: number;
  precipitationProbability?: number;
}

export interface WeatherResult {
  status: "found" | "unavailable";
  forecast?: WeatherForecast;
  badWeatherDay: boolean;
  categoriesAdjusted: boolean;
  reason?: string;
}

export interface DepartureSafetyResult {
  hasDeparturePoint: boolean;
  bufferMinutes: number;
  requestedDepartureTime: string;
  latestSafeArrivalTime: string;
  safe: boolean;
  overrunMinutes: number;
}

export interface BudgetOptimizationResult {
  originalCost: number;
  optimizedCost: number;
  savedAmount: number;
  removedStops: string[];
  replacedStops: Array<{ from: string; to: string }>;
}

export interface EventResearchResult {
  query: string;
  status: "scheduled" | "not-matching-trip-date" | "not-found" | "research-unavailable";
  eventName?: string;
  startTime?: string;
  reason?: string;
}

export interface AutoplanResult {
  destination: { name: string; lat: number; lng: number };
  itinerary: {
    feasible: boolean;
    stops: AutoplanStop[];
    conflicts: AutoplanConflict[];
    totalDistanceMeters: number;
    totalCost: number;
    costKnown: boolean;
    dayEndTime: string;
    overrunMinutes: number;
  };
  provenance: StopProvenance[];
  restaurant: RestaurantResearchResult;
  hiddenGems: { status: "found" | "none" | "skipped"; found: HiddenGemFound[] };
  weather: WeatherResult;
  departureSafety: DepartureSafetyResult;
  budgetOptimization: BudgetOptimizationResult | null;
  budgetWarning: string | null;
  events: EventResearchResult[];
  researchMetadata: {
    transitRouting: { totalPairs: number; fallbackUsed: boolean; cacheHits: number } | null;
  };
}

export interface TripOption {
  pace: "max_experience" | "balanced" | "relaxed";
  label: string;
  result: AutoplanResult;
}

export interface TripOptionsResult {
  options: TripOption[];
}

interface JobView<T> {
  status: "pending" | "running" | "done" | "failed";
  stepLabel: string | null;
  result: T | null;
  error: string | null;
}

/** Polls a job created by /api/itinerary/autoplan(/options) until it settles, reporting real progress as it goes. */
export async function pollJob<T>(
  statusUrl: string,
  onProgress: (label: string) => void
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  for (;;) {
    const res = await fetch(statusUrl);
    const body = (await res.json().catch(() => null)) as (JobView<T> & { error?: string }) | null;
    if (!res.ok || !body) {
      return { ok: false, error: body?.error ?? `İş sorgulanamadı (${res.status})` };
    }
    if (body.stepLabel) onProgress(body.stepLabel);
    if (body.status === "done") {
      if (!body.result) return { ok: false, error: "İş tamamlandı ama sonuç boş döndü" };
      return { ok: true, result: body.result };
    }
    if (body.status === "failed") {
      return { ok: false, error: body.error ?? "İş başarısız oldu" };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Every real calendar date from start to end, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime())) return out;
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export const MAX_TRIP_DAYS = 14;

export interface PlanRequestBase {
  destination: string;
  arrivalTime: string;
  departureTime: string;
  profile: "foot" | "bike" | "car" | "transit";
  interests: string[];
  budget?: number;
  foodPreferences?: string[];
  startLocation?: { lat: number; lng: number; name?: string };
  maxStops?: number;
  realismFactor?: number;
}

/** Creates one real autoplan() job for a single date and polls it to completion. */
export async function runSingleDay(
  base: PlanRequestBase,
  date: string,
  excludePlaceIds: string[],
  onProgress: (label: string) => void
): Promise<{ ok: true; result: AutoplanResult } | { ok: false; error: string }> {
  const createRes = await fetch("/api/itinerary/autoplan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, date, excludePlaceIds }),
  });
  const createBody = await createRes.json().catch(() => null);
  if (!createRes.ok || !createBody?.statusUrl) {
    return { ok: false, error: createBody?.error ?? `Plan başlatılamadı (${createRes.status})` };
  }
  return pollJob<AutoplanResult>(createBody.statusUrl, onProgress);
}

/** Creates a real /api/itinerary/autoplan/options job (3 real independently-computed plans) for a single date. */
export async function runOptions(
  base: PlanRequestBase,
  date: string,
  onProgress: (label: string) => void
): Promise<{ ok: true; result: TripOptionsResult } | { ok: false; error: string }> {
  const createRes = await fetch("/api/itinerary/autoplan/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, date }),
  });
  const createBody = await createRes.json().catch(() => null);
  if (!createRes.ok || !createBody?.statusUrl) {
    return { ok: false, error: createBody?.error ?? `Plan başlatılamadı (${createRes.status})` };
  }
  return pollJob<TripOptionsResult>(createBody.statusUrl, onProgress);
}

/** The real, display-relevant subset of one day's AutoplanResult, persisted alongside its stops so revisiting a saved trip shows the same real research, not just a bare stop list. */
export interface DayResearchSummary {
  restaurant: RestaurantResearchResult;
  hiddenGems: { status: "found" | "none" | "skipped"; found: HiddenGemFound[] };
  weather: WeatherResult;
  departureSafety: DepartureSafetyResult;
  budgetOptimization: BudgetOptimizationResult | null;
  budgetWarning: string | null;
  conflicts: AutoplanConflict[];
  totalCost: number;
  costKnown: boolean;
  totalDistanceMeters: number;
  events: EventResearchResult[];
  /** The user's own requested budget for this day, if any — carried alongside totalCost so a revisited trip can still show Budget / Expected / Remaining, not just the expected side. */
  requestedBudget?: number;
  currency?: string;
  /** Per-stop opening-hours/price/source facts — kept alongside the itinerary so a revisited trip can still show "why this place was scheduled", not just its name and time slot. Matched to a TripActivity by name (TripActivity has no persisted stopId). */
  provenance: StopProvenance[];
}

export function toDayResearchSummary(result: AutoplanResult, requestedBudget?: number, currency?: string): DayResearchSummary {
  return {
    restaurant: result.restaurant,
    hiddenGems: result.hiddenGems,
    weather: result.weather,
    departureSafety: result.departureSafety,
    budgetOptimization: result.budgetOptimization,
    budgetWarning: result.budgetWarning,
    conflicts: result.itinerary.conflicts,
    totalCost: result.itinerary.totalCost,
    costKnown: result.itinerary.costKnown,
    totalDistanceMeters: result.itinerary.totalDistanceMeters,
    events: result.events,
    requestedBudget,
    currency,
    provenance: result.provenance,
  };
}

export interface PersistedTrip {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  preferences: string[];
  status: string;
  days: Array<{
    id: string;
    dayNumber: number;
    date: string;
    research: DayResearchSummary | null;
    activities: Array<{
      id: string;
      placeName: string;
      lat: number;
      lng: number;
      timeSlot: string;
      order: number;
      notes: string;
      arrivalTime?: string | null;
      departureTime?: string | null;
      travelSeconds?: number | null;
      travelMeters?: number | null;
    }>;
  }>;
}

/** Persists already-computed real day results (see runSingleDay/runOptions above) into an actual Trip. The only write in the whole creation flow. */
export async function persistDays(
  dest: string,
  start: string,
  end: string,
  prefs: string[],
  profile: string,
  days: Array<{ date: string; result: AutoplanResult }>,
  requestedBudget?: number,
  currency?: string
): Promise<{ ok: true; trip: PersistedTrip } | { ok: false; error: string }> {
  const res = await fetch("/api/trips/from-autoplan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      destination: dest,
      startDate: start,
      endDate: end,
      preferences: prefs,
      profile,
      days: days.map((d) => ({
        date: d.date,
        stops: d.result.itinerary.stops,
        provenance: d.result.provenance,
        research: toDayResearchSummary(d.result, requestedBudget, currency),
      })),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: body?.error ?? `Plan kaydedilemedi (${res.status})` };
  }
  return { ok: true, trip: body as PersistedTrip };
}
