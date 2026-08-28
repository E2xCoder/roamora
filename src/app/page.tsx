"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Sparkles, MapPin, Calendar, Wand2, Loader2, ChevronDown, AlertCircle,
  Wallet, Footprints, TrainFront, Home as HomeIcon, UtensilsCrossed, Gauge, Check,
} from "lucide-react";
import { TRIP_PREFERENCES } from "@/types";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import {
  dateRange, runSingleDay, runOptions, persistDays,
  humanizeProgressLabel, resolveProgressStage, PLANNING_STAGES,
  MAX_TRIP_DAYS, type TripOption, type AutoplanResult, type PlanRequestBase,
} from "@/lib/autoplan-client";

const PREFERENCE_LABELS: Record<string, string> = {
  foodie: "Yemek",
  nature: "Doğa",
  culture: "Kültür",
  history: "Tarih",
  adventure: "Macera",
  relaxation: "Dinlence",
  nightlife: "Gece hayatı",
  shopping: "Alışveriş",
  photography: "Fotoğraf",
  hiking: "Doğa yürüyüşü",
};

const PACE_PRESETS = {
  relaxed: { label: "Rahat", maxStops: 5, realismFactor: 1.4 },
  balanced: { label: "Dengeli", maxStops: 8, realismFactor: 1.2 },
  packed: { label: "Yoğun", maxStops: 12, realismFactor: 1.05 },
} as const;
type Pace = keyof typeof PACE_PRESETS;

/** A/B/C's three real, fixed presets (see trip-options.ts) — a short, honest "what this feels like" line so the choice reads as a real trade-off, not three unlabeled technical presets. */
const PACE_FEEL: Record<TripOption["pace"], string> = {
  max_experience: "Hızlı tempo, en çok yer",
  balanced: "Dengeli tempo",
  relaxed: "Rahat tempo, daha çok boş zaman",
};

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Structured fields
  const [destination, setDestination] = useState("");
  const [resolvedDestination, setResolvedDestination] = useState<string | null>(null);
  const [destinationChecking, setDestinationChecking] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [preferences, setPreferences] = useState<string[]>([]);

  // Advanced (collapsed by default — real fields, real defaults)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [arrivalTime, setArrivalTime] = useState("09:00");
  const [departureTime, setDepartureTime] = useState("19:00");
  const [accommodation, setAccommodation] = useState("");
  const [accommodationResolved, setAccommodationResolved] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [accommodationChecking, setAccommodationChecking] = useState(false);
  const [accommodationError, setAccommodationError] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [profile, setProfile] = useState<"foot" | "transit">("foot");
  const [pace, setPace] = useState<Pace>("balanced");
  const [foodPreferences, setFoodPreferences] = useState("");
  const [planMode, setPlanMode] = useState<"single" | "options">("single");

  // Natural language — a secondary, collapsed-by-default way in; the
  // structured form below is the primary path (spec: it must not visually
  // overpower the normal planning form).
  const [nlOpen, setNlOpen] = useState(false);
  const [nlText, setNlText] = useState("");
  const [nlLoading, setNlLoading] = useState(false);

  // Creation flow
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [seenStages, setSeenStages] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pendingOptions, setPendingOptions] = useState<TripOption[] | null>(null);
  const [pendingRequest, setPendingRequest] = useState<{
    destination: string; startDate: string; endDate: string; preferences: string[];
  } | null>(null);

  // Recent trips (idle-state discovery content, spec §30 — real data, not a blank landing)
  const [recentTrips, setRecentTrips] = useState<Array<{ id: string; destination: string; startDate: string; endDate: string; days: unknown[] }>>([]);

  useEffect(() => {
    fetch("/api/trips")
      .then((r) => (r.ok ? r.json() : []))
      .then((trips) => setRecentTrips(Array.isArray(trips) ? trips.slice(0, 3) : []))
      .catch(() => {});
  }, []);

  // Bridge from Explore's "Bu şehri planla" CTA — pre-fills, never auto-submits, stays editable.
  useEffect(() => {
    const fromExplore = searchParams.get("destination");
    if (fromExplore) setDestination(fromExplore);
  }, [searchParams]);

  // --- destination resolution (debounced, single-match confirmation) ---
  const destTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setResolvedDestination(null);
    if (destTimer.current) clearTimeout(destTimer.current);
    const q = destination.trim();
    if (q.length < 3) return;
    destTimer.current = setTimeout(async () => {
      setDestinationChecking(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const body = await res.json();
          setResolvedDestination(body.displayName);
        }
      } catch {
        // Silent — geocoding confirmation is a nicety; autoplan() will resolve it for real regardless.
      } finally {
        setDestinationChecking(false);
      }
    }, 600);
    return () => { if (destTimer.current) clearTimeout(destTimer.current); };
  }, [destination]);

  // --- accommodation resolution (advanced) ---
  async function resolveAccommodation() {
    const q = accommodation.trim();
    if (!q) { setAccommodationResolved(null); return; }
    setAccommodationChecking(true);
    setAccommodationError(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(`${q}, ${destination}`)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setAccommodationError(body?.error ?? "Adres bulunamadı");
        setAccommodationResolved(null);
        return;
      }
      setAccommodationResolved({ lat: body.lat, lng: body.lng, name: body.displayName });
    } catch (err) {
      setAccommodationError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setAccommodationChecking(false);
    }
  }

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
      if (body.destination) setDestination(body.destination);
      if (body.startDate) {
        setStartDate(body.startDate);
        if (body.endDate) setEndDate(body.endDate);
        else if (body.durationDays) {
          const s = new Date(`${body.startDate}T12:00:00`);
          s.setDate(s.getDate() + body.durationDays - 1);
          setEndDate(s.toISOString().slice(0, 10));
        }
      }
      if (Array.isArray(body.interests) && body.interests.length > 0) {
        const matched = body.interests
          .map((raw: string) => TRIP_PREFERENCES.find((p) => p === raw || PREFERENCE_LABELS[p]?.toLowerCase() === raw.toLowerCase()))
          .filter(Boolean) as string[];
        setPreferences((prev) => Array.from(new Set([...prev, ...matched])));
      }
      if (body.budget) setBudget(String(body.budget));
      // The structured form below now shows what was understood — hand focus back to it.
      setNlOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setNlLoading(false);
    }
  }

  function trackProgress(rawLabel: string) {
    setProgress(humanizeProgressLabel(rawLabel));
    const stage = resolveProgressStage(rawLabel);
    if (stage) setSeenStages((prev) => new Set(prev).add(stage.key));
  }

  function togglePreference(pref: string) {
    setPreferences((prev) => (prev.includes(pref) ? prev.filter((p) => p !== pref) : [...prev, pref]));
  }

  function buildBase(): PlanRequestBase {
    const preset = PACE_PRESETS[pace];
    const base: PlanRequestBase = {
      destination,
      arrivalTime,
      departureTime,
      profile,
      interests: preferences,
      maxStops: preset.maxStops,
      realismFactor: preset.realismFactor,
    };
    if (budget) base.budget = Number(budget);
    if (foodPreferences.trim()) {
      base.foodPreferences = foodPreferences.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (accommodationResolved) {
      base.startLocation = { lat: accommodationResolved.lat, lng: accommodationResolved.lng, name: accommodationResolved.name };
    }
    return base;
  }

  const dates = startDate && endDate ? dateRange(startDate, endDate) : [];
  const isSingleDay = dates.length === 1;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!destination || !startDate || !endDate) return;
    setCreating(true);
    setError(null);
    setProgress(null);
    setSeenStages(new Set());
    setPendingOptions(null);

    if (dates.length === 0) {
      setError("Tarih aralığı geçersiz");
      setCreating(false);
      return;
    }
    if (dates.length > MAX_TRIP_DAYS) {
      setError(`En fazla ${MAX_TRIP_DAYS} günlük bir plan oluşturulabilir`);
      setCreating(false);
      return;
    }

    const base = buildBase();

    try {
      if (isSingleDay && planMode === "options") {
        const polled = await runOptions(base, dates[0], trackProgress);
        if (!polled.ok) { setError(polled.error); return; }
        setPendingOptions(polled.result.options);
        setPendingRequest({ destination, startDate, endDate, preferences });
        return;
      }

      const days: Array<{ date: string; result: AutoplanResult }> = [];
      const excludePlaceIds: string[] = [];
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const dayPrefix = dates.length > 1 ? `Gün ${i + 1}/${dates.length}: ` : "";
        const polled = await runSingleDay(base, date, excludePlaceIds, (label) => trackProgress(`${dayPrefix}${label}`));
        if (!polled.ok) { setError(dates.length > 1 ? `Gün ${i + 1}: ${polled.error}` : polled.error); return; }
        days.push({ date, result: polled.result });
        for (const s of polled.result.itinerary.stops) excludePlaceIds.push(s.id);
        if (polled.result.restaurant?.selected?.stopId) excludePlaceIds.push(polled.result.restaurant.selected.stopId);
      }

      setProgress("Plan kaydediliyor...");
      const persisted = await persistDays(destination, startDate, endDate, preferences, profile, days, base.budget);
      if (!persisted.ok) { setError(persisted.error); return; }
      router.push(`/trips/${persisted.trip.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setCreating(false);
      setProgress(null);
    }
  }

  async function selectOption(option: TripOption) {
    if (!pendingRequest) return;
    setCreating(true);
    setError(null);
    const persisted = await persistDays(
      pendingRequest.destination, pendingRequest.startDate, pendingRequest.endDate, pendingRequest.preferences,
      profile,
      [{ date: pendingRequest.startDate, result: option.result }],
      budget ? Number(budget) : undefined
    );
    setCreating(false);
    if (!persisted.ok) { setError(persisted.error); return; }
    router.push(`/trips/${persisted.trip.id}`);
  }

  return (
    <div className="min-h-screen pb-24">
      {/* Hero */}
      <div className="px-6 pt-10 pb-6 max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-primary-light text-primary text-xs font-semibold mb-4">
          <Sparkles size={13} />
          Otonom seyahat planlayıcı
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-balance">
          Nereye, ne zaman? Gerisini biz halledelim.
        </h1>
        <p className="text-muted-fg text-sm md:text-base mt-3">
          Gerçek yer araştırması, gerçek açılış saatleri, gerçek rota optimizasyonu — hiçbir yeri elle eklemene gerek yok.
        </p>
      </div>

      <div className="px-6 max-w-3xl mx-auto space-y-5">
        {/* Structured form is the primary path — large inputs, obvious CTA, few decisions at once */}
        <Card padding="lg">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="destination" className="flex items-center gap-1.5 text-xs font-semibold text-muted-fg uppercase tracking-wide mb-1.5">
                <MapPin size={13} /> Nereye gidiyorsun?
              </label>
              <input
                id="destination"
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="or: Prag, Çekya"
                className="w-full px-4 py-3.5 bg-surface border border-card-border rounded-2xl text-base font-medium focus:outline-none focus:border-primary/50"
                required
                aria-describedby="destination-status"
              />
              <p id="destination-status" className="text-[11px] mt-1.5 min-h-[16px]" aria-live="polite">
                {destinationChecking && <span className="text-muted-fg">Konum aranıyor…</span>}
                {!destinationChecking && resolvedDestination && (
                  <span className="text-success flex items-center gap-1"><Check size={11} /> {resolvedDestination}</span>
                )}
              </p>
            </div>

            {/* Natural language — secondary, collapsed by default so it never outweighs the form itself */}
            <div>
              <button
                type="button"
                onClick={() => setNlOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-fg hover:text-primary transition-colors"
                aria-expanded={nlOpen}
              >
                <Wand2 size={13} />
                Kendi cümlelerinle de anlatabilirsin
                <ChevronDown size={13} className={`transition-transform ${nlOpen ? "rotate-180" : ""}`} />
              </button>
              {nlOpen && (
                <div className="mt-2.5 animate-fade-in">
                  <textarea
                    id="nl-input"
                    value={nlText}
                    onChange={(e) => setNlText(e.target.value)}
                    rows={2}
                    placeholder={"or: “Paris, 3 gün. 10 Eylül saat 12:00’de CDG’ye iniyorum, 13 Eylül 18:00’de ayrılıyorum. Montmartre’da kalıyorum, 250€ bütçem var ve yürümeyi tercih ederim.”"}
                    className="w-full px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50 resize-none"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-[11px] text-muted-fg">Aşağıdaki alanları doldurur — hiçbir şey otomatik gönderilmez.</p>
                    <Button type="button" variant="outline" size="sm" onClick={parseNaturalLanguage} disabled={nlLoading || !nlText.trim()}>
                      {nlLoading ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                      Anla
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-fg uppercase tracking-wide mb-1.5">
                <Calendar size={13} /> Ne zaman?
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="px-4 py-3 bg-surface border border-card-border rounded-2xl">
                  <span className="text-[10px] text-muted-fg block">Gidiş</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-transparent text-sm font-medium focus:outline-none mt-0.5"
                    required
                  />
                </div>
                <div className="px-4 py-3 bg-surface border border-card-border rounded-2xl">
                  <span className="text-[10px] text-muted-fg block">Dönüş</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-transparent text-sm font-medium focus:outline-none mt-0.5"
                    required
                  />
                </div>
              </div>
              {dates.length > 0 && (
                <p className="text-[11px] text-primary font-medium mt-1.5">
                  {dates.length} {dates.length === 1 ? "gün" : "gün"}
                  {dates.length > MAX_TRIP_DAYS && <span className="text-danger"> — en fazla {MAX_TRIP_DAYS} gün desteklenir</span>}
                </p>
              )}
            </div>

            {isSingleDay && (
              <div>
                <span className="text-xs font-semibold text-muted-fg uppercase tracking-wide mb-1.5 block">Plan modu</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPlanMode("single")}
                    className={`flex-1 px-4 py-2.5 rounded-2xl text-sm font-medium border transition-all ${planMode === "single" ? "bg-primary-light border-primary text-primary" : "bg-surface border-card-border hover:border-primary/30"}`}>
                    Tek plan
                  </button>
                  <button type="button" onClick={() => setPlanMode("options")}
                    className={`flex-1 px-4 py-2.5 rounded-2xl text-sm font-medium border transition-all ${planMode === "options" ? "bg-primary-light border-primary text-primary" : "bg-surface border-card-border hover:border-primary/30"}`}>
                    3 gerçek seçenek sun
                  </button>
                </div>
              </div>
            )}

            {/* Compact trip preferences — low visual weight, not dominating */}
            <div>
              <span className="text-xs font-semibold text-muted-fg uppercase tracking-wide mb-1.5 block">Gezi tercihleri</span>
              <div className="flex flex-wrap gap-1.5">
                {TRIP_PREFERENCES.map((pref) => (
                  <button
                    key={pref}
                    type="button"
                    onClick={() => togglePreference(pref)}
                    aria-pressed={preferences.includes(pref)}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-all ${
                      preferences.includes(pref)
                        ? "bg-primary text-white border-primary"
                        : "bg-surface border-card-border text-muted-fg hover:border-primary/30 hover:text-foreground"
                    }`}
                  >
                    {PREFERENCE_LABELS[pref] ?? pref}
                  </button>
                ))}
              </div>
            </div>

            {/* Budget / pace / transport — real decisions a traveller makes up front, not implementation details, so they stay visible rather than hidden behind "advanced" */}
            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide flex items-center gap-1.5 mb-1">
                  <Wallet size={12} /> Bütçe
                </label>
                <input
                  type="number"
                  min="0"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="opsiyonel"
                  className="w-full px-3.5 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide flex items-center gap-1.5 mb-1">
                  <Gauge size={12} /> Tempo
                </label>
                <div className="flex gap-1.5">
                  {(Object.keys(PACE_PRESETS) as Pace[]).map((p) => (
                    <button key={p} type="button" onClick={() => setPace(p)} aria-pressed={pace === p}
                      className={`flex-1 px-2 py-2.5 rounded-xl text-xs font-medium border transition-all ${pace === p ? "bg-primary-light border-primary text-primary" : "bg-surface border-card-border"}`}>
                      {PACE_PRESETS[p].label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide flex items-center gap-1.5 mb-1">
                  <TrainFront size={12} /> Ulaşım
                </label>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setProfile("foot")} aria-pressed={profile === "foot"}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl text-xs font-medium border transition-all ${profile === "foot" ? "bg-primary-light border-primary text-primary" : "bg-surface border-card-border"}`}>
                    <Footprints size={13} /> Yürü
                  </button>
                  <button type="button" onClick={() => setProfile("transit")} aria-pressed={profile === "transit"}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl text-xs font-medium border transition-all ${profile === "transit" ? "bg-primary-light border-primary text-primary" : "bg-surface border-card-border"}`}>
                    <TrainFront size={13} /> Toplu
                  </button>
                </div>
              </div>
            </div>

            {/* Advanced — collapsed by default, real fields only */}
            <div className="border-t border-card-border pt-4">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex items-center justify-between w-full text-sm font-semibold"
                aria-expanded={advancedOpen}
              >
                Gelişmiş seçenekler
                <ChevronDown size={16} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>

              {advancedOpen && (
                <div className="mt-4 space-y-4 animate-fade-in">
                  <div>
                    <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide flex items-center gap-1.5 mb-1">
                      <HomeIcon size={12} /> Konaklama (opsiyonel)
                    </label>
                    <input
                      type="text"
                      value={accommodation}
                      onChange={(e) => { setAccommodation(e.target.value); setAccommodationResolved(null); }}
                      onBlur={resolveAccommodation}
                      placeholder="or: Montmartre, otel adı"
                      className="w-full px-3.5 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                    />
                    <p className="text-[11px] mt-1 min-h-[14px]" aria-live="polite">
                      {accommodationChecking && <span className="text-muted-fg">Adres aranıyor…</span>}
                      {!accommodationChecking && accommodationResolved && (
                        <span className="text-success flex items-center gap-1"><Check size={11} /> {accommodationResolved.name}</span>
                      )}
                      {!accommodationChecking && accommodationError && <span className="text-danger">{accommodationError}</span>}
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide mb-1 block">Günlük başlangıç / bitiş</label>
                      <div className="flex gap-2">
                        <input type="time" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)}
                          className="flex-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50" />
                        <input type="time" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)}
                          className="flex-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50" />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-muted-fg uppercase tracking-wide flex items-center gap-1.5 mb-1">
                        <UtensilsCrossed size={12} /> Yemek tercihleri / diyet
                      </label>
                      <input
                        type="text"
                        value={foodPreferences}
                        onChange={(e) => setFoodPreferences(e.target.value)}
                        placeholder="or: vejetaryen, deniz mahsulleri"
                        className="w-full px-3.5 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {progress && (
              <div className="rounded-2xl bg-primary-light/60 p-4 space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Loader2 size={14} className="animate-spin text-primary shrink-0" />
                  <span>{progress}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PLANNING_STAGES.map((s) => (
                    <span key={s.key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                      seenStages.has(s.key) ? "bg-primary text-white" : "bg-surface text-muted"
                    }`}>
                      {seenStages.has(s.key) && <Check size={9} />}
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 p-4 rounded-2xl bg-danger-light border border-danger/20">
                <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-danger">Bu plan şu an oluşturulamadı</p>
                  <p className="text-xs text-muted-fg mt-0.5">{error}</p>
                </div>
              </div>
            )}

            {!pendingOptions && (
              <Button type="submit" variant="accent" size="lg" disabled={creating} className="w-full">
                {creating ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                {creating ? "Otonom motor plan oluşturuyor…" : "Gezimi Planla"}
              </Button>
            )}
          </form>

          {pendingOptions && (
            <div className="mt-5 pt-5 border-t border-card-border">
              <p className="text-sm font-semibold mb-3">Hangisini kaydetmek istersin?</p>
              <div className="grid sm:grid-cols-3 gap-3">
                {pendingOptions.map((opt) => (
                  <button
                    key={opt.pace}
                    type="button"
                    onClick={() => selectOption(opt)}
                    disabled={creating}
                    className="text-left p-4 rounded-2xl border-2 border-card-border bg-surface hover:border-primary/50 hover:shadow-[var(--shadow-md)] transition-all disabled:opacity-40 flex flex-col"
                  >
                    <p className="font-bold text-base">{opt.label}</p>
                    <p className="text-xs text-primary font-medium mt-0.5">{PACE_FEEL[opt.pace]}</p>
                    <p className="text-xs text-muted-fg mt-2">
                      {opt.result.itinerary.stops.length} durak · {(opt.result.itinerary.totalDistanceMeters / 1000).toFixed(1)} km yürüyüş
                    </p>
                    {/* Real place names, not just a count — three numbers alone don't tell a traveller what's actually different between options. */}
                    <p className="text-[11px] text-muted-fg mt-1.5 line-clamp-2">
                      {opt.result.itinerary.stops.slice(0, 3).map((s) => s.name).join(" · ")}
                      {opt.result.itinerary.stops.length > 3 && " · ..."}
                    </p>
                    <div className="mt-auto pt-2.5">
                      {opt.result.hiddenGems.found.length > 0 && (
                        <p className="text-[11px] text-accent">{opt.result.hiddenGems.found.length} gizli hazine</p>
                      )}
                      {opt.result.restaurant?.status === "scheduled" && (
                        <p className="text-[11px] text-muted-fg mt-0.5">Restoran dahil</p>
                      )}
                      {!opt.result.itinerary.feasible && (
                        <p className="text-[11px] text-warning mt-1">Plan {opt.result.itinerary.conflicts.length} yerde düzenleme gerektiriyor</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Idle-state discovery content, not a blank landing */}
        {!creating && !pendingOptions && recentTrips.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-fg uppercase tracking-wide mb-2 px-1">Son planların</p>
            <div className="grid sm:grid-cols-3 gap-3">
              {recentTrips.map((t) => (
                <button key={t.id} onClick={() => router.push(`/trips/${t.id}`)} className="text-left">
                  <Card interactive padding="sm">
                    <p className="font-semibold text-sm">{t.destination}</p>
                    <p className="text-xs text-muted-fg mt-0.5">{t.startDate} → {t.endDate}</p>
                  </Card>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center">
          <Loader2 size={22} className="animate-spin text-primary" />
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
