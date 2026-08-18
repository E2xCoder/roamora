"use client";

import {
  Footprints, Bike, Car, Clock, Route as RouteIcon, Trash2,
  ChevronUp, ChevronDown, Navigation, Square, X, Loader2, MapPin,
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
}: RoutePanelProps) {
  if (stops.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="w-16 h-16 rounded-3xl gradient-warm flex items-center justify-center mx-auto mb-4">
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
              : "gradient-warm text-white hover:opacity-90"
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

          return (
            <div key={stop.id}>
              <div
                onClick={() => onSetActiveStop(i)}
                className={`group relative flex gap-3 p-3 rounded-2xl border transition-all cursor-pointer ${
                  isActive
                    ? "border-primary bg-primary-light shadow-[var(--shadow-md)]"
                    : "border-card-border bg-card hover:border-amber-500/40"
                }`}
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
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface text-[10px] rounded-lg font-medium">
                      {CATEGORY_EMOJI[stop.category] || "📍"} {stop.category}
                    </span>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex flex-col gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); onMove(i, -1); }}
                    disabled={i === 0}
                    className="p-1 rounded-md text-muted hover:text-foreground hover:bg-surface disabled:opacity-20 disabled:hover:bg-transparent"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemove(stop.id); }}
                    className="p-1 rounded-md text-muted hover:text-danger hover:bg-surface"
                  >
                    <Trash2 size={12} />
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
