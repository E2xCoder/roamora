"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import AddPlaceModal from "@/components/AddPlaceModal";
import PlaceCard from "@/components/PlaceCard";
import ExtractPanel from "@/components/ExtractPanel";
import RoutePanel, { type Profile, type RouteLeg } from "@/components/RoutePanel";
import {
  CATEGORY_EMOJI,
  haversine,
  type Place,
  type UserPosition,
} from "@/lib/place-meta";
import { CATEGORIES } from "@/types";
import {
  MapPin, Search, ChevronUp, ChevronDown, X, Route as RouteIcon,
  Sparkles, Crosshair, Check,
} from "lucide-react";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const PAGE_SIZE = 40;
const ARRIVAL_RADIUS_M = 40;

type PanelView = "places" | "route" | "extract";

export default function HomePage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [clickedPos, setClickedPos] = useState<{ lat: number; lng: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPanel, setShowPanel] = useState(true);
  const [panelView, setPanelView] = useState<PanelView>("places");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // --- route state ---
  const [routeMode, setRouteMode] = useState(false);
  const [stops, setStops] = useState<Place[]>([]);
  const [geometry, setGeometry] = useState<[number, number][] | null>(null);
  const [legs, setLegs] = useState<RouteLeg[]>([]);
  const [totalDistance, setTotalDistance] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeFallback, setRouteFallback] = useState(false);
  const [profile, setProfile] = useState<Profile>("foot");

  // --- live state ---
  const [live, setLive] = useState(false);
  const [activeStop, setActiveStop] = useState(0);
  const [userPos, setUserPos] = useState<UserPosition | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  const loadPlaces = useCallback(async () => {
    try {
      const res = await fetch("/api/places");
      if (!res.ok) return;
      const data = await res.json();
      setPlaces(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadPlaces();
  }, [loadPlaces]);

  /* ------------------------------ route fetching ----------------------------- */

  useEffect(() => {
    if (stops.length < 2) {
      setGeometry(null);
      setLegs([]);
      setTotalDistance(0);
      setTotalDuration(0);
      setRouteFallback(false);
      return;
    }

    let cancelled = false;
    setRouteLoading(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            waypoints: stops.map((s) => ({ lat: s.lat, lng: s.lng })),
            profile,
          }),
        });
        if (!res.ok) throw new Error("route failed");
        const data = await res.json();
        if (cancelled) return;

        setGeometry(data.coordinates);
        setLegs(data.legs || []);
        setTotalDistance(data.distance || 0);
        setTotalDuration(data.duration || 0);
        setRouteFallback(!!data.fallback);
      } catch {
        if (!cancelled) {
          setGeometry(null);
          setRouteFallback(true);
        }
      } finally {
        if (!cancelled) setRouteLoading(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stops, profile]);

  /* -------------------------------- live logic ------------------------------- */

  const distanceToNext = useMemo(() => {
    if (!userPos || !stops[activeStop]) return null;
    return haversine(userPos, stops[activeStop]);
  }, [userPos, stops, activeStop]);

  // Auto-advance to the next stop on arrival.
  useEffect(() => {
    if (!live || distanceToNext == null) return;
    if (distanceToNext < ARRIVAL_RADIUS_M && activeStop < stops.length - 1) {
      setActiveStop((s) => s + 1);
    }
  }, [live, distanceToNext, activeStop, stops.length]);

  /* --------------------------------- actions -------------------------------- */

  function togglePlaceInRoute(place: Place) {
    setStops((prev) => {
      const exists = prev.some((s) => s.id === place.id);
      return exists ? prev.filter((s) => s.id !== place.id) : [...prev, place];
    });
    setPanelView("route");
    setShowPanel(true);
  }

  function moveStop(index: number, dir: -1 | 1) {
    setStops((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function clearRoute() {
    setStops([]);
    setLive(false);
    setActiveStop(0);
  }

  function toggleLive() {
    setLive((v) => {
      if (!v) setActiveStop(0);
      return !v;
    });
  }

  async function handleSave(data: {
    name: string; lat: number; lng: number;
    category: string; notes: string; tags: string[];
  }) {
    await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setClickedPos(null);
    loadPlaces();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/places/${id}`, { method: "DELETE" });
    setStops((prev) => prev.filter((s) => s.id !== id));
    loadPlaces();
  }

  /* --------------------------------- derived -------------------------------- */

  const filteredPlaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return places.filter((p) => {
      const catMatch = selectedCategory === "all" || p.category === selectedCategory;
      const searchMatch = !q || p.name.toLowerCase().includes(q);
      return catMatch && searchMatch;
    });
  }, [places, selectedCategory, searchQuery]);

  const categoryCounts = useMemo(
    () =>
      places.reduce<Record<string, number>>((acc, p) => {
        acc[p.category] = (acc[p.category] || 0) + 1;
        return acc;
      }, {}),
    [places]
  );

  // Reset the incremental list when the filter changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    listRef.current?.scrollTo({ top: 0 });
  }, [selectedCategory, searchQuery]);

  function handleListScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredPlaces.length));
    }
  }

  const stopIds = useMemo(() => new Set(stops.map((s) => s.id)), [stops]);

  return (
    <div className="h-dvh relative overflow-hidden">
      <MapView
        places={places}
        selectedCategory={selectedCategory}
        onMapClick={routeMode ? undefined : (lat, lng) => setClickedPos({ lat, lng })}
        onPlaceDelete={handleDelete}
        routeMode={routeMode}
        routeStops={stops}
        routeGeometry={geometry}
        activeStop={activeStop}
        onPlaceToggle={togglePlaceInRoute}
        liveTracking={live}
        followUser={live}
        onUserPosition={setUserPos}
      />

      {/* Top bar */}
      <div className="absolute top-4 left-4 right-4 z-[1000] flex items-center gap-3">
        <div className="glass-panel rounded-2xl px-4 py-2.5 flex items-center gap-2 shadow-[var(--shadow-md)]">
          <div className="w-8 h-8 rounded-xl gradient-primary flex items-center justify-center">
            <span className="text-white font-bold text-sm">R</span>
          </div>
          <span className="font-bold text-sm hidden sm:block">Roamora</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="glass-panel rounded-2xl shadow-[var(--shadow-md)] flex items-center">
            <Search size={16} className="ml-4 text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Yer ara..."
              className="flex-1 px-3 py-3 bg-transparent text-sm focus:outline-none min-w-0"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="pr-4 text-muted hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Route mode toggle */}
        <button
          onClick={() => {
            setRouteMode((v) => !v);
            setPanelView("route");
            setShowPanel(true);
          }}
          className={`rounded-2xl px-4 py-3 shadow-[var(--shadow-md)] flex items-center gap-2 text-sm font-semibold transition-all shrink-0 ${
            routeMode
              ? "gradient-warm text-white"
              : "glass-panel text-foreground hover:shadow-[var(--shadow-lg)]"
          }`}
        >
          <RouteIcon size={16} />
          <span className="hidden sm:block">
            {routeMode ? "Rota Modu" : "Rota"}
          </span>
          {stops.length > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                routeMode ? "bg-white/25" : "bg-amber-500 text-white"
              }`}
            >
              {stops.length}
            </span>
          )}
        </button>
      </div>

      {/* Category chips */}
      <div className="absolute top-[76px] left-4 right-4 z-[1000]">
        <div className="flex gap-2 overflow-x-auto hide-scrollbar py-1">
          <button
            onClick={() => setSelectedCategory("all")}
            className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-medium shadow-[var(--shadow-sm)] transition-all ${
              selectedCategory === "all"
                ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                : "glass-panel text-foreground hover:shadow-[var(--shadow-md)]"
            }`}
          >
            Tumu {places.length > 0 && `(${places.length})`}
          </button>
          {CATEGORIES.map((c) =>
            categoryCounts[c] ? (
              <button
                key={c}
                onClick={() => setSelectedCategory(c)}
                className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-medium shadow-[var(--shadow-sm)] transition-all flex items-center gap-1.5 ${
                  selectedCategory === c
                    ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                    : "glass-panel text-foreground hover:shadow-[var(--shadow-md)]"
                }`}
              >
                <span>{CATEGORY_EMOJI[c] || "📍"}</span>
                {c} ({categoryCounts[c]})
              </button>
            ) : null
          )}
        </div>
      </div>

      {/* Route-mode hint */}
      {routeMode && stops.length === 0 && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none animate-fade-in">
          <div className="glass-panel rounded-2xl px-5 py-4 shadow-[var(--shadow-lg)] text-center max-w-[260px]">
            <Crosshair size={22} className="text-amber-500 mx-auto mb-2" />
            <p className="text-sm font-semibold">Pinlere dokun</p>
            <p className="text-xs text-muted mt-1">
              Sectigin sirayla rota olusturulur
            </p>
          </div>
        </div>
      )}

      {/* Bottom panel */}
      <div className="absolute bottom-[66px] md:bottom-4 left-0 right-0 md:left-auto md:right-4 md:w-[420px] z-[1000]">
        <div className="flex items-center justify-center md:justify-end mb-2 px-4 md:px-0">
          <button
            onClick={() => setShowPanel(!showPanel)}
            className="glass-panel rounded-full px-4 py-2 shadow-[var(--shadow-md)] flex items-center gap-2 text-sm font-medium hover:shadow-[var(--shadow-lg)] transition-all"
          >
            {showPanel ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            {showPanel ? "Gizle" : `${filteredPlaces.length} yer`}
          </button>
        </div>

        {showPanel && (
          <div className="glass-panel rounded-t-3xl md:rounded-3xl shadow-[var(--shadow-xl)] animate-slide-up max-h-[58vh] md:max-h-[72vh] flex flex-col overflow-hidden">
            {/* Tabs */}
            <div className="flex items-center border-b border-glass-border px-2 pt-3">
              <Tab
                active={panelView === "places"}
                onClick={() => setPanelView("places")}
                label={`Yerlerim (${filteredPlaces.length})`}
              />
              <Tab
                active={panelView === "route"}
                onClick={() => setPanelView("route")}
                label="Rota"
                badge={stops.length || undefined}
              />
              <Tab
                active={panelView === "extract"}
                onClick={() => setPanelView("extract")}
                label="Link"
              />
            </div>

            {/* Content */}
            <div
              ref={listRef}
              onScroll={panelView === "places" ? handleListScroll : undefined}
              className="flex-1 overflow-y-auto hide-scrollbar"
            >
              {panelView === "places" && (
                <div className="p-4 space-y-3">
                  {filteredPlaces.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="w-16 h-16 rounded-3xl bg-primary-light flex items-center justify-center mx-auto mb-4">
                        <MapPin size={24} className="text-primary" />
                      </div>
                      <p className="font-medium text-sm">Henuz yer yok</p>
                      <p className="text-xs text-muted mt-1">
                        Link sekmesinden TikTok/Instagram linki yapistir
                      </p>
                    </div>
                  ) : (
                    <>
                      {filteredPlaces.slice(0, visibleCount).map((place) => (
                        <div key={place.id} className="relative">
                          <PlaceCard
                            place={place}
                            categoryIcon={CATEGORY_EMOJI[place.category] || "📍"}
                            onDelete={handleDelete}
                          />
                          <button
                            onClick={() => togglePlaceInRoute(place)}
                            className={`absolute bottom-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[10px] font-bold transition-all ${
                              stopIds.has(place.id)
                                ? "bg-amber-500 text-white"
                                : "bg-surface text-muted hover:bg-amber-500 hover:text-white"
                            }`}
                          >
                            {stopIds.has(place.id) ? (
                              <>
                                <Check size={11} /> Rotada
                              </>
                            ) : (
                              <>
                                <RouteIcon size={11} /> Rotaya ekle
                              </>
                            )}
                          </button>
                        </div>
                      ))}
                      {visibleCount < filteredPlaces.length && (
                        <p className="text-center text-[11px] text-muted py-3">
                          {filteredPlaces.length - visibleCount} yer daha…
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {panelView === "route" && (
                <RoutePanel
                  stops={stops}
                  legs={legs}
                  totalDistance={totalDistance}
                  totalDuration={totalDuration}
                  loading={routeLoading}
                  fallback={routeFallback}
                  profile={profile}
                  live={live}
                  activeStop={activeStop}
                  distanceToNext={distanceToNext}
                  onProfileChange={setProfile}
                  onMove={moveStop}
                  onRemove={(id) =>
                    setStops((prev) => prev.filter((s) => s.id !== id))
                  }
                  onClear={clearRoute}
                  onToggleLive={toggleLive}
                  onSetActiveStop={setActiveStop}
                />
              )}

              {panelView === "extract" && (
                <ExtractPanel onPlaceSaved={loadPlaces} />
              )}
            </div>
          </div>
        )}
      </div>

      {clickedPos && (
        <AddPlaceModal
          lat={clickedPos.lat}
          lng={clickedPos.lng}
          onClose={() => setClickedPos(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 pb-3 pt-1 text-sm font-semibold border-b-2 transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {label}
      {badge != null && (
        <span className="px-1.5 py-0.5 rounded-md bg-amber-500 text-white text-[10px] font-bold">
          {badge}
        </span>
      )}
    </button>
  );
}
