"use client";

import { useState } from "react";
import {
  Footprints, Bike, Car, Clock, Route as RouteIcon, Trash2,
  ChevronUp, ChevronDown, ChevronRight, Navigation, Square, X, Loader2, MapPin,
  Sparkles, AlertTriangle, Lock, Unlock, Crosshair, Timer, Wallet,
} from "lucide-react";
import {
  CATEGORY_EMOJI,
  formatDistance,
  formatDuration,
  type Place,
} from "@/lib/place-meta";

export type Profile = "foot" | "bike" | "car";

export interface RouteLeg {
  distance: number;
  duration: number;
}

/** Per-stop scheduling input, entered by the user — never inferred or guessed. */
export interface StopConstraint {
  earliestTime?: string;
  latestTime?: string;
  fixedTime?: string;
  visitMinutes?: number;
  estimatedCost?: number;
  locked?: boolean;
}

export interface ScheduledStop {
  id: string;
  arrivalTime: string;
  departureTime: string;
  waitMinutes: number;
  travelFromPrevMeters: number;
  travelFromPrevSeconds: number;
}

export interface OptimizeConflict {
  stopId: string;
  stopName: string;
  kind: string;
  detail: string;
}

interface RoutePanelProps {
  stops: Place[];
  legs: RouteLeg[];
  totalDistance: number;
  totalDuration: number;
  loading: boolean;
  fallback: boolean;
  profile: Profile;
  live: boolean;
  activeStop: number;
  distanceToNext: number | null;
  onProfileChange: (p: Profile) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onToggleLive: () => void;
  onSetActiveStop: (i: number) => void;

  // --- scheduling / optimization ---
  constraints: Record<string, StopConstraint>;
  onConstraintChange: (stopId: string, patch: StopConstraint) => void;
  dayStart: string;
  dayEnd: string;
  onDayStartChange: (v: string) => void;
  onDayEndChange: (v: string) => void;
  startLocation: { lat: number; lng: number; name?: string } | null;
  onUseCurrentLocation: () => void;
  onUseFirstStopAsStart: () => void;
  onOptimize: () => void;
  optimizing: boolean;
  optimizeError: string | null;
  schedule: ScheduledStop[] | null;
  conflicts: OptimizeConflict[];
  totalCost: number;
  costKnown: boolean;
  matrixSource: "osrm" | "fallback" | null;
}

const PROFILES: { id: Profile; icon: typeof Footprints; label: string }[] = [
  { id: "foot", icon: Footprints, label: "Yuru" },
  { id: "bike", icon: Bike, label: "Bisiklet" },
  { id: "car", icon: Car, label: "Araba" },
];

export default function RoutePanel({
  stops,
  legs,
  totalDistance,
  totalDuration,
  loading,
  fallback,
  profile,
  live,
  activeStop,
  distanceToNext,
  onProfileChange,
  onMove,
  onRemove,
  onClear,
  onToggleLive,
  onSetActiveStop,
  constraints,
  onConstraintChange,
  dayStart,
  dayEnd,
  onDayStartChange,
  onDayEndChange,
  startLocation,
  onUseCurrentLocation,
  onUseFirstStopAsStart,
  onOptimize,
  optimizing,
  optimizeError,
  schedule,
  conflicts,
  totalCost,
  costKnown,
  matrixSource,
}: RoutePanelProps) {
  const [expandedStop, setExpandedStop] = useState<string | null>(null);
  const [showScheduling, setShowScheduling] = useState(false);

  if (stops.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="w-16 h-16 rounded-3xl bg-accent flex items-center justify-center mx-auto mb-4">
          <RouteIcon size={26} className="text-white" />
        </div>
        <p className="font-semibold text-sm">Rota olustur</p>
        <p className="text-xs text-muted mt-1.5 leading-relaxed">
          Haritadaki pinlere dokun, sirayla rotana eklensin.
          <br />
          Gercek yurume yolu cizilir, sure ve mesafe hesaplanir.
        </p>
      </div>
    );
  }

  const scheduleFor = (id: string) => schedule?.find((s) => s.id === id);

  return (
    <div className="p-4">
      {/* Overview card */}
      <div className="rounded-2xl overflow-hidden mb-4 bg-gradient-to-br from-amber-500/15 to-orange-500/10 border border-amber-500/25">
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600">
              Rota Ozeti
            </span>
            <button
              onClick={onClear}
              className="text-muted hover:text-danger p-1 rounded-lg hover:bg-card transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Stat icon={<MapPin size={13} />} label="Durak" value={String(stops.length)} />
            <Stat
              icon={<RouteIcon size={13} />}
              label="Mesafe"
              value={loading ? "…" : formatDistance(totalDistance)}
            />
            <Stat
              icon={<Clock size={13} />}
              label="Sure"
              value={loading ? "…" : formatDuration(totalDuration)}
            />
          </div>

          {/* Profile switch */}
          <div className="flex gap-1.5 mt-3 p-1 bg-card/60 rounded-xl">
            {PROFILES.map((p) => {
              const Icon = p.icon;
              const active = profile === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onProfileChange(p.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-all ${
                    active
                      ? "bg-card shadow-[var(--shadow-sm)] text-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <Icon size={13} />
                  {p.label}
                </button>
              );
            })}
          </div>

          {fallback && !loading && (
            <p className="text-[10px] text-muted mt-2.5 leading-relaxed">
              Yol servisi yanit vermedi — kus ucusu mesafe gosteriliyor.
            </p>
          )}
        </div>

        {/* Live button */}
        <button
          onClick={onToggleLive}
          className={`w-full flex items-center justify-center gap-2 py-3.5 text-sm font-semibold transition-all ${
            live
              ? "bg-danger text-white"
              : "bg-accent text-white hover:opacity-90"
          }`}
        >
          {live ? <Square size={14} /> : <Navigation size={14} />}
          {live ? "Canli Takibi Durdur" : "Canli Basla"}
        </button>
      </div>

      {/* Live banner */}
      {live && (
        <div className="mb-4 p-3.5 rounded-2xl bg-primary-light border border-primary/25 animate-fade-in">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
              Canli — Durak {activeStop + 1}
            </span>
          </div>
          <p className="font-semibold text-sm">{stops[activeStop]?.name}</p>
          {distanceToNext != null && (
            <p className="text-xs text-muted mt-0.5">
              {formatDistance(distanceToNext)} kaldi
            </p>
          )}
        </div>
      )}

      {/* Scheduling & optimize */}
      {!live && (
        <div className="mb-4 rounded-2xl border border-card-border bg-card overflow-hidden">
          <button
            onClick={() => setShowScheduling((v) => !v)}
            className="w-full flex items-center justify-between px-3.5 py-3"
          >
            <span className="flex items-center gap-2 text-xs font-semibold">
              <Sparkles size={13} className="text-primary" />
              Zamanlama ve Optimizasyon
            </span>
            <ChevronRight
              size={14}
              className={`text-muted transition-transform ${showScheduling ? "rotate-90" : ""}`}
            />
          </button>

          {showScheduling && (
            <div className="px-3.5 pb-3.5 space-y-3 animate-fade-in">
              {/* Start location */}
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Baslangic noktasi
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 min-w-0 px-3 py-2 bg-surface rounded-xl text-xs truncate">
                    {startLocation
                      ? startLocation.name ??
                        `${startLocation.lat.toFixed(4)}, ${startLocation.lng.toFixed(4)}`
                      : "Henuz secilmedi"}
                  </div>
                  <button
                    onClick={onUseCurrentLocation}
                    title="Konumumu kullan"
                    className="p-2 bg-primary-light text-primary rounded-xl shrink-0"
                  >
                    <Crosshair size={14} />
                  </button>
                  <button
                    onClick={onUseFirstStopAsStart}
                    title="Ilk duragi baslangic yap"
                    className="p-2 bg-surface rounded-xl shrink-0"
                  >
                    <MapPin size={14} />
                  </button>
                </div>
              </div>

              {/* Day window */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                    Gun baslangici
                  </label>
                  <input
                    type="time"
                    value={dayStart}
                    onChange={(e) => onDayStartChange(e.target.value)}
                    className="w-full mt-1 px-3 py-2 bg-surface border border-card-border rounded-xl text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                    Gun bitisi
                  </label>
                  <input
                    type="time"
                    value={dayEnd}
                    onChange={(e) => onDayEndChange(e.target.value)}
                    className="w-full mt-1 px-3 py-2 bg-surface border border-card-border rounded-xl text-xs"
                  />
                </div>
              </div>

              <p className="text-[10px] text-muted leading-relaxed">
                Her durak icin acilis/kapanis ya da sabit saat gireceksen
                altta o duragin yanindaki ok isaretine dokun.
              </p>

              <button
                onClick={onOptimize}
                disabled={optimizing || !startLocation}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-white rounded-xl text-sm font-semibold disabled:opacity-40"
              >
                {optimizing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {optimizing ? "Hesaplaniyor..." : "Rotayi Optimize Et"}
              </button>
              {!startLocation && (
                <p className="text-[10px] text-danger">
                  Once bir baslangic noktasi sec.
                </p>
              )}
              {optimizeError && (
                <p className="text-[10px] text-danger">{optimizeError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Conflicts — named explicitly, never hidden */}
      {conflicts.length > 0 && (
        <div className="mb-4 rounded-2xl border border-danger/25 bg-danger/10 p-3.5 space-y-2 animate-fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-danger shrink-0" />
            <span className="text-xs font-bold text-danger">
              Bu plan calismiyor ({conflicts.length})
            </span>
          </div>
          {conflicts.map((c, i) => (
            <p key={i} className="text-[11px] text-muted leading-snug pl-6">
              <span className="font-semibold text-foreground">{c.stopName}:</span>{" "}
              {c.detail}
            </p>
          ))}
        </div>
      )}

      {/* Cost summary */}
      {schedule && (
        <div className="mb-4 flex items-center gap-2.5 px-3.5 py-2.5 bg-surface rounded-2xl">
          <Wallet size={14} className="text-muted shrink-0" />
          <p className="text-xs">
            {costKnown ? (
              <>
                <span className="font-semibold">
                  {totalCost.toLocaleString("tr-TR")}
                </span>{" "}
                <span className="text-muted">tahmini toplam maliyet</span>
              </>
            ) : (
              <span className="text-muted">
                Maliyet bilgisi eksik — bazi duraklarda fiyat girilmemis
              </span>
            )}
          </p>
        </div>
      )}

      {matrixSource === "fallback" && schedule && (
        <p className="text-[10px] text-muted mb-3 px-1">
          Yol servisi yanit vermedi, kus ucusu mesafe kullanildi — sureler
          gercekte farkli olabilir.
        </p>
      )}

      {/* Stop list */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/60 backdrop-blur-sm rounded-2xl">
            <Loader2 size={20} className="animate-spin text-primary" />
          </div>
        )}

        {stops.map((stop, i) => {
          const leg = legs[i];
          const isActive = live && i === activeStop;
          const constraint = constraints[stop.id] ?? {};
          const sched = scheduleFor(stop.id);
          const isExpanded = expandedStop === stop.id;
          const conflict = conflicts.find((c) => c.stopId === stop.id);

          return (
            <div key={stop.id}>
              <div
                className={`group relative rounded-2xl border transition-all ${
                  isActive
                    ? "border-primary bg-primary-light shadow-[var(--shadow-md)]"
                    : conflict
                      ? "border-danger/40 bg-danger/5"
                      : "border-card-border bg-card hover:border-amber-500/40"
                }`}
              >
                <div
                  onClick={() => onSetActiveStop(i)}
                  className="flex gap-3 p-3 cursor-pointer"
                >
                  {/* Number badge */}
                  <div className="shrink-0">
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-extrabold text-stone-900"
                      style={{
                        background: "linear-gradient(135deg,#fbbf24,#f59e0b)",
                        boxShadow: isActive
                          ? "0 0 0 4px rgba(251,191,36,.25)"
                          : undefined,
                      }}
                    >
                      {i + 1}
                    </div>
                  </div>

                  {/* Body */}
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-sm leading-tight truncate">
                      {stop.name}
                    </h4>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface text-[10px] rounded-lg font-medium">
                        {CATEGORY_EMOJI[stop.category] || "📍"} {stop.category}
                      </span>
                      {sched && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/15 text-amber-600 text-[10px] rounded-lg font-semibold">
                          <Clock size={9} />
                          {sched.arrivalTime}–{sched.departureTime}
                        </span>
                      )}
                      {sched && sched.waitMinutes > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface text-muted text-[10px] rounded-lg">
                          <Timer size={9} />
                          {sched.waitMinutes} dk bekleme
                        </span>
                      )}
                      {constraint.fixedTime && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-light text-primary text-[10px] rounded-lg font-semibold">
                          Sabit {constraint.fixedTime}
                        </span>
                      )}
                      {constraint.locked && (
                        <Lock size={11} className="text-muted" />
                      )}
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedStop(isExpanded ? null : stop.id);
                      }}
                      className={`p-1 rounded-md transition-colors ${
                        isExpanded ? "text-primary" : "text-muted hover:text-foreground"
                      }`}
                      title="Saat ve sure ayarla"
                    >
                      <Timer size={13} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemove(stop.id); }}
                      className="p-1 rounded-md text-muted hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  <div className="flex flex-col gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); onMove(i, -1); }}
                      disabled={i === 0}
                      className="p-1 rounded-md text-muted hover:text-foreground hover:bg-surface disabled:opacity-20 disabled:hover:bg-transparent"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onMove(i, 1); }}
                      disabled={i === stops.length - 1}
                      className="p-1 rounded-md text-muted hover:text-foreground hover:bg-surface disabled:opacity-20 disabled:hover:bg-transparent"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>
                </div>

                {/* Constraint editor */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-card-border/60 animate-fade-in">
                    <div className="grid grid-cols-3 gap-2">
                      <TimeField
                        label="Acilis"
                        value={constraint.earliestTime}
                        onChange={(v) => onConstraintChange(stop.id, { earliestTime: v })}
                      />
                      <TimeField
                        label="Son giris"
                        value={constraint.latestTime}
                        onChange={(v) => onConstraintChange(stop.id, { latestTime: v })}
                      />
                      <TimeField
                        label="Sabit saat"
                        value={constraint.fixedTime}
                        onChange={(v) => onConstraintChange(stop.id, { fixedTime: v })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] font-semibold text-muted uppercase tracking-wider">
                          Sure (dk)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={600}
                          placeholder="tahmin"
                          value={constraint.visitMinutes ?? ""}
                          onChange={(e) =>
                            onConstraintChange(stop.id, {
                              visitMinutes: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          className="w-full mt-1 px-2.5 py-1.5 bg-surface border border-card-border rounded-lg text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] font-semibold text-muted uppercase tracking-wider">
                          Maliyet
                        </label>
                        <input
                          type="number"
                          min={0}
                          placeholder="opsiyonel"
                          value={constraint.estimatedCost ?? ""}
                          onChange={(e) =>
                            onConstraintChange(stop.id, {
                              estimatedCost: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          className="w-full mt-1 px-2.5 py-1.5 bg-surface border border-card-border rounded-lg text-xs"
                        />
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        onConstraintChange(stop.id, { locked: !constraint.locked })
                      }
                      className="w-full flex items-center justify-center gap-1.5 py-2 bg-surface rounded-lg text-[10px] font-medium"
                    >
                      {constraint.locked ? <Lock size={11} /> : <Unlock size={11} />}
                      {constraint.locked
                        ? "Sirasi sabitlendi — optimize etmez"
                        : "Sirayi sabitle"}
                    </button>
                  </div>
                )}
              </div>

              {/* Leg connector */}
              {i < stops.length - 1 && (
                <div className="flex items-center gap-2 pl-[30px] py-1.5">
                  <div className="w-0.5 h-6 bg-gradient-to-b from-amber-400 to-amber-500/40 rounded-full" />
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface rounded-lg">
                    {profile === "foot" ? (
                      <Footprints size={11} className="text-amber-600" />
                    ) : profile === "bike" ? (
                      <Bike size={11} className="text-amber-600" />
                    ) : (
                      <Car size={11} className="text-amber-600" />
                    )}
                    <span className="text-[10px] font-medium">
                      {leg ? formatDuration(leg.duration) : "…"}
                    </span>
                    <span className="text-[10px] text-muted">
                      · {leg ? formatDistance(leg.distance) : "…"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div>
      <label className="text-[9px] font-semibold text-muted uppercase tracking-wider">
        {label}
      </label>
      <input
        type="time"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full mt-1 px-1.5 py-1.5 bg-surface border border-card-border rounded-lg text-[11px]"
      />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card/60 rounded-xl p-2.5">
      <div className="flex items-center gap-1 text-muted mb-0.5">
        {icon}
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-sm font-bold leading-none">{value}</p>
    </div>
  );
}
