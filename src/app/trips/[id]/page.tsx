"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowLeft, Clock, Footprints, Wallet, Cloud, CloudRain, Sun, CloudFog, CloudSnow, Zap,
  ShieldCheck, ShieldAlert, Sparkles, UtensilsCrossed, Gem, Star, AlertTriangle, Trash2, MapPin,
} from "lucide-react";
import type { Place } from "@/lib/place-meta";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Skeleton from "@/components/ui/Skeleton";
import type { DayResearchSummary, PersistedTrip } from "@/lib/autoplan-client";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const WEATHER_ICON: Record<string, typeof Sun> = {
  clear: Sun, cloudy: Cloud, fog: CloudFog, rain: CloudRain, snow: CloudSnow, storm: Zap,
};

function formatKm(meters: number) {
  return `${(meters / 1000).toFixed(1)} km`;
}
function formatWalk(seconds: number) {
  const m = Math.round(seconds / 60);
  return m < 1 ? "<1 dk" : `${m} dk`;
}

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [trip, setTrip] = useState<PersistedTrip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(1);
  const [activeStopIdx, setActiveStopIdx] = useState<number | null>(null);
  const [routeGeometry, setRouteGeometry] = useState<[number, number][] | null>(null);

  const loadTrip = useCallback(async () => {
    const res = await fetch(`/api/trips/${params.id}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `Gezi yüklenemedi (${res.status})`);
      return;
    }
    setTrip(await res.json());
  }, [params.id]);

  useEffect(() => { loadTrip(); }, [loadTrip]);

  const day = trip?.days.find((d) => d.dayNumber === selectedDay) ?? trip?.days[0] ?? null;
  const research = (day?.research ?? null) as DayResearchSummary | null;
  const activities = useMemo(() => day?.activities ?? [], [day]);

  // Real walking/transit geometry for this day's actual stop sequence (existing /api/route, unchanged).
  useEffect(() => {
    setRouteGeometry(null);
    if (activities.length < 2) return;
    let cancelled = false;
    fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypoints: activities.map((a) => ({ lat: a.lat, lng: a.lng })),
        profile: "foot",
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data?.coordinates) setRouteGeometry(data.coordinates); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activities]);

  async function deleteTrip() {
    await fetch(`/api/trips/${params.id}`, { method: "DELETE" });
    router.push("/trips");
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <Card padding="lg" className="text-center max-w-sm">
          <AlertTriangle size={28} className="text-danger mx-auto mb-3" />
          <p className="font-semibold text-sm">{error}</p>
          <Link href="/trips" className="inline-block mt-4"><Button variant="outline">Gezilere dön</Button></Link>
        </Card>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="min-h-screen px-6 py-8 max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const mapPlaces: Place[] = activities.map((a, i) => ({
    id: a.id, name: a.placeName, lat: a.lat, lng: a.lng,
    category: matchCategory(research, a.placeName), notes: a.notes, tags: [],
    address: undefined, city: undefined, country: undefined,
    // real ordinal marker label
    source: String(i + 1),
  }));

  const totalDays = trip.days.length;
  const WeatherIcon = research?.weather?.forecast ? WEATHER_ICON[research.weather.forecast.condition] ?? Cloud : null;

  return (
    <div className="min-h-screen pb-24">
      {/* Plan header — spec §11 */}
      <div className="px-6 pt-6 pb-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-3">
          <Link href="/trips" className="p-2 -ml-2 rounded-xl hover:bg-card-hover text-muted-fg"><ArrowLeft size={18} /></Link>
          <button onClick={deleteTrip} className="ml-auto p-2 rounded-xl hover:bg-danger-light text-muted hover:text-danger transition-colors" aria-label="Geziyi sil">
            <Trash2 size={16} />
          </button>
        </div>
        <h1 className="text-2xl md:text-3xl font-bold uppercase tracking-tight">{trip.destination}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-muted-fg">
          <span>{trip.startDate} – {trip.endDate}</span>
          <span className="text-card-border">•</span>
          <span>{totalDays} {totalDays === 1 ? "gün" : "gün"}</span>
          {trip.preferences.length > 0 && (
            <>
              <span className="text-card-border">•</span>
              <span>{trip.preferences.join(", ")}</span>
            </>
          )}
        </div>
      </div>

      {/* Day tabs */}
      {totalDays > 1 && (
        <div className="px-6 max-w-6xl mx-auto mb-4">
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {trip.days.map((d) => (
              <button
                key={d.id}
                onClick={() => { setSelectedDay(d.dayNumber); setActiveStopIdx(null); }}
                className={`shrink-0 px-4 py-2.5 rounded-2xl text-sm font-medium transition-all ${
                  selectedDay === d.dayNumber ? "bg-primary text-white shadow-[var(--shadow-sm)]" : "bg-card border border-card-border hover:border-primary/30"
                }`}
              >
                Gün {d.dayNumber}
                <span className="block text-[10px] opacity-80">{d.date}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day header stats — spec §15 */}
      {research && (
        <div className="px-6 max-w-6xl mx-auto mb-5">
          <div className="flex flex-wrap gap-2">
            {WeatherIcon && research.weather.forecast && (
              <StatChip icon={<WeatherIcon size={13} />}>
                {research.weather.forecast.temperatureMaxC != null ? `${Math.round(research.weather.forecast.temperatureMaxC)}°C` : ""} {conditionLabel(research.weather.forecast.condition)}
              </StatChip>
            )}
            <StatChip icon={<Footprints size={13} />}>{formatKm(research.totalDistanceMeters)} yürüyüş</StatChip>
            {research.costKnown && <StatChip icon={<Wallet size={13} />}>~{Math.round(research.totalCost)} beklenen harcama</StatChip>}
            <StatChip icon={<MapPin size={13} />}>{activities.length} durak</StatChip>
            {research.departureSafety.hasDeparturePoint && (
              <StatChip icon={research.departureSafety.safe ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />} tone={research.departureSafety.safe ? "success" : "warning"}>
                {research.departureSafety.safe
                  ? `${research.departureSafety.requestedDepartureTime} kalkış için güvenli`
                  : `${research.departureSafety.overrunMinutes} dk gecikme riski`}
              </StatChip>
            )}
          </div>

          {research.weather.badWeatherDay && research.weather.categoriesAdjusted && (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-primary bg-primary-light rounded-xl px-3 py-2 w-fit">
              <CloudRain size={13} />
              Kötü hava bekleniyor — Roamora kapalı mekan duraklarını önceliklendirdi.
            </div>
          )}
        </div>
      )}

      {/* Budget — spec §20 */}
      {research?.requestedBudget != null && research.costKnown && (
        <div className="px-6 max-w-6xl mx-auto mb-5">
          <BudgetCard requested={research.requestedBudget} expected={research.totalCost} currency={research.currency} />
        </div>
      )}

      {/* Split layout — timeline / map, spec §14 */}
      <div className="px-6 max-w-6xl mx-auto grid lg:grid-cols-[1fr_440px] gap-5">
        {/* Timeline */}
        <div className="space-y-3 order-2 lg:order-1">
          {activities.length === 0 && (
            <Card padding="lg" className="text-center text-sm text-muted-fg">Bu gün için durak yok</Card>
          )}
          {activities.map((activity, i) => (
            <TimelineItem
              key={activity.id}
              activity={activity}
              index={i}
              research={research}
              active={activeStopIdx === i}
              onSelect={() => setActiveStopIdx(activeStopIdx === i ? null : i)}
            />
          ))}

          {research && research.conflicts.length > 0 && <ConflictsCard conflicts={research.conflicts} />}
          {research?.budgetOptimization && <BudgetOptimizationCard opt={research.budgetOptimization} />}
        </div>

        {/* Map */}
        <div className="order-1 lg:order-2 h-[320px] lg:h-[calc(100vh-260px)] lg:sticky lg:top-6 rounded-3xl overflow-hidden border border-card-border shadow-[var(--shadow-md)]">
          <MapView
            places={mapPlaces}
            routeMode
            routeStops={mapPlaces}
            routeGeometry={routeGeometry}
            activeStop={activeStopIdx ?? 0}
            onPlaceToggle={(p) => {
              const idx = mapPlaces.findIndex((mp) => mp.id === p.id);
              setActiveStopIdx(idx === activeStopIdx ? null : idx);
            }}
            linkToDetail={false}
          />
        </div>
      </div>
    </div>
  );
}

function StatChip({ icon, children, tone }: { icon: React.ReactNode; children: React.ReactNode; tone?: "success" | "warning" }) {
  const toneClass = tone === "success" ? "bg-success-light text-success" : tone === "warning" ? "bg-warning-light text-warning" : "bg-surface text-foreground";
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${toneClass}`}>
      {icon}
      {children}
    </span>
  );
}

function conditionLabel(c: string) {
  return { clear: "Açık", cloudy: "Bulutlu", fog: "Sisli", rain: "Yağmurlu", snow: "Karlı", storm: "Fırtınalı" }[c] ?? c;
}

function matchCategory(research: DayResearchSummary | null, placeName: string): string {
  if (research?.restaurant?.selected?.name === placeName) return "restaurant";
  if (research?.hiddenGems?.found.some((g) => g.name === placeName)) return "hidden-gem";
  return "attraction";
}

/** Compact, honest "why this place was scheduled" facts — real confidence, never a fabricated fact when unverified (spec: unknown is acceptable, wrong is not). */
function AttractionFacts({ provenance }: { provenance: DayResearchSummary["provenance"][number] | undefined }) {
  if (!provenance) return null;

  const priceVerified = provenance.priceSource !== "unverified";
  const priceLabel =
    provenance.estimatedCost == null
      ? priceVerified
        ? null
        : "Fiyat doğrulanamadı"
      : provenance.estimatedCost === 0
        ? "Ücretsiz · Doğrulandı"
        : `~${provenance.estimatedCost}${provenance.priceCurrency ? ` ${provenance.priceCurrency}` : ""}${
            provenance.priceType === "reduced" ? " (indirimli)" : provenance.priceType === "minimum" ? "+ (başlangıç fiyatı)" : ""
          } · Doğrulandı`;

  const hoursVerified = provenance.openingHoursSource !== "unverified";
  const hoursLabel = hoursVerified
    ? provenance.latestTime
      ? `${provenance.latestTime}'e kadar açık`
      : "Açılış saati doğrulandı"
    : "Açılış saati doğrulanamadı";

  return (
    <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[11px]">
      <span className={hoursVerified ? "text-success" : "text-muted"}>{hoursLabel}</span>
      {priceLabel && <span className={priceVerified ? "text-success" : "text-muted-fg"}>· {priceLabel}</span>}
      {provenance.sourceType === "official" && provenance.officialDomain && (
        <span className="text-muted">· Kaynak: {provenance.officialDomain}</span>
      )}
    </div>
  );
}

interface ActivityLike {
  id: string; placeName: string; lat: number; lng: number; timeSlot: string; notes: string;
  arrivalTime?: string | null; departureTime?: string | null; travelSeconds?: number | null; travelMeters?: number | null;
}

function TimelineItem({
  activity, index, research, active, onSelect,
}: { activity: ActivityLike; index: number; research: DayResearchSummary | null; active: boolean; onSelect: () => void }) {
  const isRestaurant = research?.restaurant?.selected?.name === activity.placeName;
  const hiddenGem = research?.hiddenGems?.found.find((g) => g.name === activity.placeName);
  const fixedEvent = research?.events?.find((e) => e.status === "scheduled" && e.eventName === activity.placeName);
  const restaurant = isRestaurant ? research?.restaurant?.selected : undefined;
  const provenance = research?.provenance?.find((p) => p.name === activity.placeName);

  return (
    <button onClick={onSelect} className="w-full text-left">
      <Card
        selected={active}
        padding="md"
        className={isRestaurant ? "border-secondary/40" : hiddenGem ? "border-accent/40" : undefined}
      >
        <div className="flex gap-3">
          <div className="flex flex-col items-center pt-0.5 shrink-0">
            <div className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center text-[11px] font-bold">{index + 1}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-muted-fg">
              <Clock size={12} />
              <span className="text-xs font-medium">{activity.arrivalTime ?? activity.timeSlot.split("-")[0]}
                {activity.departureTime ? `–${activity.departureTime}` : ""}
              </span>
              {fixedEvent && <Badge variant="accent">Sabit Saat</Badge>}
              {hiddenGem && <Badge variant="accent"><Gem size={9} /> Gizli Hazine</Badge>}
              {isRestaurant && <Badge variant="warning"><UtensilsCrossed size={9} /> Restoran</Badge>}
            </div>
            <h3 className="font-semibold text-sm mt-1">{activity.placeName}</h3>

            {isRestaurant && restaurant ? (
              <RestaurantDetail restaurant={restaurant} />
            ) : hiddenGem ? (
              <div className="mt-1 space-y-1">
                {hiddenGem.description ? (
                  <p className="text-xs text-muted-fg line-clamp-2">{hiddenGem.description}</p>
                ) : (
                  <p className="text-xs text-muted italic">Bu yer için doğrulanmış bir açıklama bulunamadı</p>
                )}
                <p className="text-[11px] text-muted">
                  Rotadan {Math.round(hiddenGem.distanceMeters)} m sapma — {hiddenGem.category}
                </p>
                <AttractionFacts provenance={provenance} />
              </div>
            ) : (
              <>
                {activity.notes && <p className="text-xs text-muted-fg mt-1.5 line-clamp-2">{activity.notes}</p>}
                <AttractionFacts provenance={provenance} />
              </>
            )}

            {activity.travelSeconds != null && activity.travelSeconds > 0 && (
              <p className="text-[11px] text-muted mt-2 flex items-center gap-1">
                <Footprints size={11} /> {formatWalk(activity.travelSeconds)} · {activity.travelMeters ? formatKm(activity.travelMeters) : ""}
              </p>
            )}
          </div>
        </div>
      </Card>
    </button>
  );
}

function RestaurantDetail({ restaurant }: { restaurant: NonNullable<DayResearchSummary["restaurant"]["selected"]> }) {
  const topItem = restaurant.menuItems.find((m) => m.price != null) ?? restaurant.menuItems[0];
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-fg">
        {restaurant.cuisine && <span>{restaurant.cuisine}</span>}
        {restaurant.estimatedMealCost != null && (
          <span className="font-medium text-foreground">
            ~{restaurant.estimatedMealCost}{restaurant.currency ?? ""}
          </span>
        )}
        {restaurant.touristTrapRisk !== "UNKNOWN" && restaurant.touristTrapRisk !== "LOW" && (
          <Badge variant={restaurant.touristTrapRisk === "HIGH" ? "danger" : "warning"}>Turist yoğunluğu: {restaurant.touristTrapRisk}</Badge>
        )}
      </div>
      {topItem && (
        <p className="text-xs">
          <Star size={10} className="inline text-secondary mr-1" />
          {topItem.name}{topItem.price != null && ` — ${topItem.price}${topItem.currency ?? ""}`}
        </p>
      )}
      {restaurant.menuAvailability.status === "unavailable" && (
        <p className="text-[11px] text-muted">Menü bu kaynaktan alınamadı — {restaurant.menuAvailability.reason}</p>
      )}
      {restaurant.menuAvailability.status === "no-source" && (
        <p className="text-[11px] text-muted">Bu restoran için doğrulanmış bir kaynak bulunamadı</p>
      )}
    </div>
  );
}

function ConflictsCard({ conflicts }: { conflicts: DayResearchSummary["conflicts"] }) {
  return (
    <Card padding="md" className="border-warning/30 bg-warning-light/40">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={15} className="text-warning" />
        <p className="text-sm font-semibold">Bu gün düzenleme gerektiriyor</p>
      </div>
      <ul className="space-y-1.5">
        {conflicts.map((c, i) => (
          <li key={i} className="text-xs text-muted-fg">
            <span className="font-medium text-foreground">{c.stopName}</span> — {c.detail}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BudgetOptimizationCard({ opt }: { opt: NonNullable<DayResearchSummary["budgetOptimization"]> }) {
  if (opt.savedAmount <= 0 && opt.removedStops.length === 0 && opt.replacedStops.length === 0) return null;
  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={14} className="text-primary" />
        <p className="text-sm font-semibold">Bütçeye göre otomatik ayarlandı</p>
      </div>
      <p className="text-xs text-muted-fg">
        Tahmini maliyet {Math.round(opt.originalCost)} → {Math.round(opt.optimizedCost)} olarak ayarlandı
        {opt.savedAmount > 0 && ` (${Math.round(opt.savedAmount)} tasarruf)`}.
      </p>
      {opt.removedStops.length > 0 && (
        <p className="text-[11px] text-muted-fg mt-1">Çıkarılan: {opt.removedStops.join(", ")}</p>
      )}
    </Card>
  );
}

function BudgetCard({ requested, expected, currency }: { requested: number; expected: number; currency?: string }) {
  const remaining = requested - expected;
  const pct = requested > 0 ? Math.min(100, Math.round((expected / requested) * 100)) : 0;
  const over = remaining < 0;
  const cur = currency ?? "";
  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-3">
        <Wallet size={14} className="text-primary" />
        <p className="text-sm font-semibold">Bütçe</p>
      </div>
      <div className="flex items-end justify-between mb-2">
        <div>
          <p className="text-[10px] text-muted-fg uppercase tracking-wide">Bütçe</p>
          <p className="text-lg font-bold">{requested}{cur}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-muted-fg uppercase tracking-wide">Tahmini</p>
          <p className="text-lg font-bold">{Math.round(expected)}{cur}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-fg uppercase tracking-wide">{over ? "Aşım" : "Kalan"}</p>
          <p className={`text-lg font-bold ${over ? "text-danger" : "text-success"}`}>{Math.abs(Math.round(remaining))}{cur}</p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-surface overflow-hidden">
        <div className={`h-full rounded-full transition-all ${over ? "bg-danger" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </Card>
  );
}
