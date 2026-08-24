"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { CalendarDays, Plus, Trash2, Loader2, Clock, ChevronRight, Sparkles, AlertCircle, Wand2 } from "lucide-react";
import { TRIP_PREFERENCES } from "@/types";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface TripActivity {
  id: string;
  placeName: string;
  lat: number;
  lng: number;
  timeSlot: string;
  order: number;
  notes: string;
}

interface TripDay {
  id: string;
  dayNumber: number;
  date: string;
  activities: TripActivity[];
}

interface Trip {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  preferences: string[];
  status: string;
  days: TripDay[];
}

// --- real autoplan job shapes — mirror src/server/services/autoplan.ts /
// trip-options.ts / job-runner.ts. Only the fields this page actually reads
// are declared; the job's real result carries much more (research trace,
// restaurant/menu intelligence, weather, hidden gems, ...) that this pass
// deliberately does not render yet — see the audit note in the PR/commit.
interface AutoplanStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  order: number;
  arrivalTime: string;
  departureTime: string;
  travelFromPrevMeters: number;
  travelFromPrevSeconds: number;
}

interface AutoplanStopProvenance {
  stopId: string;
  category: string;
  summaryText?: string;
}

interface AutoplanResult {
  itinerary: {
    feasible: boolean;
    stops: AutoplanStop[];
    conflicts: Array<{ detail: string }>;
    totalDistanceMeters: number;
  };
  provenance: AutoplanStopProvenance[];
  restaurant: { status: string; selected?: { stopId: string } };
}

interface TripOption {
  pace: "max_experience" | "balanced" | "relaxed";
  label: string;
  result: AutoplanResult;
}

interface TripOptionsResult {
  options: TripOption[];
}

interface JobView<T> {
  status: "pending" | "running" | "done" | "failed";
  stepLabel: string | null;
  result: T | null;
  error: string | null;
}

/** Polls a job created by /api/itinerary/autoplan(/options) until it settles, reporting real progress as it goes. */
async function pollJob<T>(
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
function dateRange(start: string, end: string): string[] {
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

const MAX_TRIP_DAYS = 14;

export default function PlanPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [selectedDay, setSelectedDay] = useState<number>(1);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [preferences, setPreferences] = useState<string[]>([]);
  const [arrivalTime, setArrivalTime] = useState("09:00");
  const [departureTime, setDepartureTime] = useState("19:00");
  const [budget, setBudget] = useState("");
  const [profile, setProfile] = useState<"foot" | "transit">("foot");
  const [planMode, setPlanMode] = useState<"single" | "options">("single");

  const [nlText, setNlText] = useState("");
  const [nlLoading, setNlLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pendingOptions, setPendingOptions] = useState<TripOption[] | null>(null);
  const [pendingRequest, setPendingRequest] = useState<{
    destination: string;
    startDate: string;
    endDate: string;
    preferences: string[];
  } | null>(null);

  const loadTrips = useCallback(async () => {
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Planlar yüklenemedi (${res.status})`);
        return;
      }
      setTrips(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    }
  }, []);

  useEffect(() => {
    loadTrips();
  }, [loadTrips]);

  async function parseNaturalLanguage() {
    if (!nlText.trim()) return;
    setNlLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/trip-planner/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: nlText }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? `Metin çözümlenemedi (${res.status})`);
        return;
      }
      // Pre-fills the same structured fields the form below submits — never
      // auto-submits itself, so a misparse is always caught before any real
      // planning runs.
      if (body.destination) setDestination(body.destination);
      if (body.startDate) setStartDate(body.startDate);
      if (body.endDate) {
        setEndDate(body.endDate);
      } else if (body.startDate && body.durationDays) {
        const s = new Date(`${body.startDate}T12:00:00`);
        s.setDate(s.getDate() + body.durationDays - 1);
        setEndDate(s.toISOString().slice(0, 10));
      }
      if (Array.isArray(body.interests) && body.interests.length > 0) {
        setPreferences((prev) => Array.from(new Set([...prev, ...body.interests])));
      }
      if (body.budget) setBudget(String(body.budget));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setNlLoading(false);
    }
  }

  /** Persists already-computed real day results (see pollJob above) into an actual Trip — the only write in this whole flow. */
  async function persistDays(
    dest: string,
    start: string,
    end: string,
    prefs: string[],
    days: Array<{ date: string; result: AutoplanResult }>
  ): Promise<Trip | null> {
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
        })),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error ?? `Plan kaydedilemedi (${res.status})`);
      return null;
    }
    return body as Trip;
  }

  function resetForm() {
    setCreating(false);
    setDestination("");
    setStartDate("");
    setEndDate("");
    setPreferences([]);
    setBudget("");
    setNlText("");
    setPendingOptions(null);
    setPendingRequest(null);
    setProgress(null);
  }

  /**
   * The real creation flow (spec: production-hardening follow-up — connect
   * the autonomous planner to the product UI). No attraction is ever typed
   * in by hand: destination/date(s)/preferences go straight to the real
   * autoplan() pipeline (OSM discovery, opening-hours/price research,
   * deterministic optimizer, restaurant intelligence, ...) via the same
   * async job + polling contract /api/itinerary/autoplan already exposes.
   *
   * A single day can request 3 real independently-computed options
   * (/api/itinerary/autoplan/options) for the user to choose between. A
   * multi-day range calls /api/itinerary/autoplan once per real day,
   * sequentially (never concurrently — this project's Overpass/OTP usage
   * has repeatedly shown these free public/self-hosted services degrade
   * under concurrent load), excluding every place already scheduled on an
   * earlier day so day 2 doesn't just repeat day 1's top attraction.
   */
  async function createAutonomousTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!destination || !startDate || !endDate) return;
    setLoading(true);
    setError(null);
    setProgress(null);
    setPendingOptions(null);

    const dates = dateRange(startDate, endDate);
    if (dates.length === 0) {
      setError("Tarih aralığı geçersiz");
      setLoading(false);
      return;
    }
    if (dates.length > MAX_TRIP_DAYS) {
      setError(`En fazla ${MAX_TRIP_DAYS} günlük bir plan oluşturulabilir`);
      setLoading(false);
      return;
    }

    const baseBody: Record<string, unknown> = {
      destination,
      arrivalTime,
      departureTime,
      profile,
      interests: preferences,
    };
    if (budget) baseBody.budget = Number(budget);

    try {
      if (dates.length === 1 && planMode === "options") {
        setProgress("3 gerçek seçenek hesaplanıyor...");
        const createRes = await fetch("/api/itinerary/autoplan/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...baseBody, date: dates[0] }),
        });
        const createBody = await createRes.json().catch(() => null);
        if (!createRes.ok || !createBody?.statusUrl) {
          setError(createBody?.error ?? `Plan başlatılamadı (${createRes.status})`);
          return;
        }
        const polled = await pollJob<TripOptionsResult>(createBody.statusUrl, setProgress);
        if (!polled.ok) {
          setError(polled.error);
          return;
        }
        setPendingOptions(polled.result.options);
        setPendingRequest({ destination, startDate, endDate, preferences });
        return; // wait for the user to pick a real option below
      }

      const days: Array<{ date: string; result: AutoplanResult }> = [];
      const excludePlaceIds: string[] = [];
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        setProgress(`Gün ${i + 1}/${dates.length} (${date}) planlanıyor...`);
        const createRes = await fetch("/api/itinerary/autoplan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...baseBody, date, excludePlaceIds }),
        });
        const createBody = await createRes.json().catch(() => null);
        if (!createRes.ok || !createBody?.statusUrl) {
          setError(`Gün ${i + 1}: ${createBody?.error ?? createRes.status}`);
          return;
        }
        const polled = await pollJob<AutoplanResult>(createBody.statusUrl, (label) =>
          setProgress(`Gün ${i + 1}/${dates.length}: ${label}`)
        );
        if (!polled.ok) {
          setError(`Gün ${i + 1}: ${polled.error}`);
          return;
        }
        days.push({ date, result: polled.result });
        for (const s of polled.result.itinerary.stops) excludePlaceIds.push(s.id);
        if (polled.result.restaurant?.selected?.stopId) {
          excludePlaceIds.push(polled.result.restaurant.selected.stopId);
        }
      }

      setProgress("Plan kaydediliyor...");
      const trip = await persistDays(destination, startDate, endDate, preferences, days);
      if (!trip) return;

      setTrips((prev) => [trip, ...prev]);
      setSelectedTrip(trip);
      setSelectedDay(1);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function selectOption(option: TripOption) {
    if (!pendingRequest) return;
    setLoading(true);
    setError(null);
    const trip = await persistDays(
      pendingRequest.destination,
      pendingRequest.startDate,
      pendingRequest.endDate,
      pendingRequest.preferences,
      [{ date: pendingRequest.startDate, result: option.result }]
    );
    setLoading(false);
    if (!trip) return;
    setTrips((prev) => [trip, ...prev]);
    setSelectedTrip(trip);
    setSelectedDay(1);
    resetForm();
  }

  async function deleteTrip(id: string) {
    await fetch(`/api/trips/${id}`, { method: "DELETE" });
    setTrips(trips.filter((t) => t.id !== id));
    if (selectedTrip?.id === id) setSelectedTrip(null);
  }

  function togglePreference(pref: string) {
    setPreferences((prev) =>
      prev.includes(pref) ? prev.filter((p) => p !== pref) : [...prev, pref]
    );
  }

  const dayActivities = selectedTrip?.days.find((d) => d.dayNumber === selectedDay)?.activities || [];
  const mapPlaces = dayActivities
    .filter((a) => a.lat && a.lng)
    .map((a) => ({
      id: a.id,
      name: a.placeName,
      lat: a.lat,
      lng: a.lng,
      category: "attraction",
      notes: a.notes,
      tags: [],
    }));

  const isSingleDay = startDate && endDate && startDate === endDate;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl gradient-warm flex items-center justify-center">
            <CalendarDays size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Gezi Planlari</h1>
            <p className="text-xs text-muted">Otonom keşif ile gerçek gün bazli plan olustur</p>
          </div>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="flex items-center gap-2 px-5 py-2.5 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          Yeni Plan
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="mx-6 mb-6 bg-card border border-card-border rounded-3xl p-6 animate-slide-up">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={16} className="text-primary" />
            <h3 className="font-bold text-sm">Otonom Gezi Planlayıcı</h3>
          </div>

          {/* Natural-language pre-fill */}
          <div className="mb-5">
            <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
              Doğal dille anlat (opsiyonel)
            </label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), parseNaturalLanguage())}
                placeholder="or: Roma'da 3 gün, müze ve yemek seviyorum, 600 euro bütçe"
                className="flex-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
              />
              <button
                type="button"
                onClick={parseNaturalLanguage}
                disabled={nlLoading || !nlText.trim()}
                className="px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm font-semibold disabled:opacity-40 flex items-center gap-2 hover:border-primary/30"
              >
                {nlLoading ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                Anla
              </button>
            </div>
            <p className="text-[10px] text-muted mt-1">
              Aşağıdaki alanları doldurur — hiçbir şey otomatik gönderilmez, önce kontrol et.
            </p>
          </div>

          <form onSubmit={createAutonomousTrip} className="space-y-4">
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Sehir</label>
                <input
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="or: Prague"
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Baslangic</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Bitis</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
            </div>

            <div className="grid md:grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Varış saati</label>
                <input
                  type="time"
                  value={arrivalTime}
                  onChange={(e) => setArrivalTime(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Ayrılış saati</label>
                <input
                  type="time"
                  value={departureTime}
                  onChange={(e) => setDepartureTime(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Bütçe (opsiyonel)</label>
                <input
                  type="number"
                  min="0"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="or: 500"
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Ulaşım</label>
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value as "foot" | "transit")}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                >
                  <option value="foot">Yürüyerek</option>
                  <option value="transit">Toplu taşıma</option>
                </select>
              </div>
            </div>

            {isSingleDay && (
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Plan modu</label>
                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setPlanMode("single")}
                    className={`px-4 py-2 rounded-2xl text-xs font-medium transition-all ${
                      planMode === "single"
                        ? "gradient-primary text-white"
                        : "bg-surface border border-card-border hover:border-primary/30"
                    }`}
                  >
                    Tek plan
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlanMode("options")}
                    className={`px-4 py-2 rounded-2xl text-xs font-medium transition-all ${
                      planMode === "options"
                        ? "gradient-primary text-white"
                        : "bg-surface border border-card-border hover:border-primary/30"
                    }`}
                  >
                    3 gerçek seçenek sun
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Tercihler</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {TRIP_PREFERENCES.map((pref) => (
                  <button
                    key={pref}
                    type="button"
                    onClick={() => togglePreference(pref)}
                    className={`px-4 py-2 rounded-2xl text-xs font-medium transition-all ${
                      preferences.includes(pref)
                        ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                        : "bg-surface border border-card-border hover:border-primary/30"
                    }`}
                  >
                    {pref}
                  </button>
                ))}
              </div>
            </div>

            {progress && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-primary-light/50 text-xs text-foreground">
                <Loader2 size={14} className="animate-spin text-primary shrink-0" />
                <span>{progress}</span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 p-4 rounded-2xl bg-danger/10 border border-danger/20">
                <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-danger">
                    Plan oluşturulamadı
                  </p>
                  <p className="text-xs text-muted mt-0.5">{error}</p>
                </div>
              </div>
            )}

            {!pendingOptions && (
              <button
                type="submit"
                disabled={loading}
                className="w-full px-6 py-3.5 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2 transition-opacity"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? "Otonom motor plan olusturuyor..." : "Plan Olustur"}
              </button>
            )}
          </form>

          {/* Real, independently-computed A/B/C options — user picks one to persist */}
          {pendingOptions && (
            <div className="mt-5">
              <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                Hangisini kaydetmek istersin?
              </p>
              <div className="grid md:grid-cols-3 gap-3">
                {pendingOptions.map((opt) => (
                  <button
                    key={opt.pace}
                    type="button"
                    onClick={() => selectOption(opt)}
                    disabled={loading}
                    className="text-left p-4 rounded-2xl border border-card-border bg-surface hover:border-primary/40 hover:shadow-[var(--shadow-sm)] transition-all disabled:opacity-40"
                  >
                    <p className="font-bold text-sm">{opt.label}</p>
                    <p className="text-xs text-muted mt-1">
                      {opt.result.itinerary.stops.length} durak · {(opt.result.itinerary.totalDistanceMeters / 1000).toFixed(1)} km
                    </p>
                    {opt.result.restaurant?.status === "scheduled" && (
                      <p className="text-[10px] text-muted mt-1">Restoran dahil</p>
                    )}
                    {!opt.result.itinerary.feasible && (
                      <p className="text-[10px] text-danger mt-1">
                        {opt.result.itinerary.conflicts.length} çakışma tespit edildi
                      </p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="px-6 grid lg:grid-cols-[340px_1fr] gap-6 pb-24">
        {/* Trip list */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Planlarim</p>

          {trips.length === 0 && (
            <div className="text-center py-16 bg-card border border-card-border rounded-3xl">
              <div className="w-14 h-14 rounded-3xl gradient-warm flex items-center justify-center mx-auto mb-3 opacity-50">
                <CalendarDays size={24} className="text-white" />
              </div>
              <p className="text-sm text-muted">Henuz plan yok</p>
              <p className="text-xs text-muted mt-1">Yeni bir plan olustur!</p>
            </div>
          )}

          {trips.map((trip) => (
            <div
              key={trip.id}
              onClick={() => { setSelectedTrip(trip); setSelectedDay(1); }}
              className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                selectedTrip?.id === trip.id
                  ? "border-primary bg-primary-light shadow-[var(--shadow-md)]"
                  : "border-card-border bg-card hover:border-primary/30 hover:shadow-[var(--shadow-sm)]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-sm">{trip.destination}</h4>
                  <p className="text-xs text-muted mt-0.5">
                    {trip.startDate} → {trip.endDate}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="px-2 py-0.5 bg-surface rounded-lg text-[10px] font-medium">
                      {trip.days.length} gun
                    </span>
                    {trip.preferences?.slice(0, 2).map((p) => (
                      <span key={p} className="px-2 py-0.5 bg-primary-light text-primary rounded-lg text-[10px] font-medium">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTrip(trip.id); }}
                    className="text-muted hover:text-danger p-1.5 rounded-xl hover:bg-surface transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                  <ChevronRight size={16} className="text-muted" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Trip detail */}
        <div>
          {selectedTrip ? (
            <div className="space-y-4">
              {/* Day tabs */}
              <div className="flex gap-2 overflow-x-auto hide-scrollbar">
                {selectedTrip.days.map((day) => (
                  <button
                    key={day.dayNumber}
                    onClick={() => setSelectedDay(day.dayNumber)}
                    className={`shrink-0 px-5 py-3 rounded-2xl text-sm font-medium transition-all ${
                      selectedDay === day.dayNumber
                        ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                        : "bg-card border border-card-border hover:border-primary/30"
                    }`}
                  >
                    Gun {day.dayNumber}
                    <span className="block text-[10px] opacity-80">{day.date}</span>
                  </button>
                ))}
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                {/* Activities */}
                <div className="bg-card border border-card-border rounded-3xl p-5">
                  <h3 className="font-bold text-sm mb-4">Program</h3>
                  <div className="space-y-4">
                    {dayActivities.map((activity, i) => (
                      <div key={activity.id} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className="w-9 h-9 rounded-xl gradient-primary text-white flex items-center justify-center text-xs font-bold">
                            {i + 1}
                          </div>
                          {i < dayActivities.length - 1 && (
                            <div className="w-0.5 flex-1 bg-card-border mt-2" />
                          )}
                        </div>
                        <div className="flex-1 pb-4">
                          <div className="flex items-center gap-2 text-muted">
                            <Clock size={12} />
                            <span className="text-xs">{activity.timeSlot}</span>
                          </div>
                          <h4 className="font-semibold text-sm mt-1">{activity.placeName}</h4>
                          {activity.notes && (
                            <p className="text-xs text-muted mt-1">{activity.notes}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {dayActivities.length === 0 && (
                      <p className="text-sm text-muted text-center py-8">Bu gun icin aktivite yok</p>
                    )}
                  </div>
                </div>

                {/* Map */}
                <div className="h-[400px] rounded-3xl overflow-hidden border border-card-border shadow-[var(--shadow-md)]">
                  <MapView places={mapPlaces} />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[400px] bg-card border border-card-border rounded-3xl">
              <div className="text-center">
                <div className="w-16 h-16 rounded-3xl gradient-warm flex items-center justify-center mx-auto mb-4 opacity-50">
                  <CalendarDays size={28} className="text-white" />
                </div>
                <p className="text-muted text-sm">Bir plan sec veya yeni plan olustur</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
