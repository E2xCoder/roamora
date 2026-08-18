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
import { CATEGORIES as TAXONOMY } from "@/lib/taxonomy";
import {
  MapPin, Search, ChevronUp, ChevronDown, X, Route as RouteIcon,
  Crosshair, Check, Loader2, ImageIcon,
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
  /** Personal saves vs. the bulk reference corpus — never mixed silently. */
  const [pool, setPool] = useState<"personal" | "reference">("personal");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** True totals from SQL, not counts of the loaded page. */
  const [stats, setStats] = useState<{ total: number; counts: Record<string, number> }>({
    total: 0,
    counts: {},
  });
  /** Whether more rows matched than the map could load. */
  const [truncated, setTruncated] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<string | null>(null);

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

  /**
   * Search and category filtering happen in SQL.
   *
   * They used to run in the browser over whatever page had been loaded, so
   * with 2000 rows fetched out of 9320 a search for "Poznań" matched nothing
   * and the chips read "Tumu (2000)".
   */
  const buildQuery = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ pool, limit: "2000", ...extra });
      const q = searchQuery.trim();
      if (q) params.set("search", q);
      if (selectedCategory !== "all") params.set("category", selectedCategory);
      return params.toString();
    },
    [pool, searchQuery, selectedCategory]
  );

  const loadPlaces = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const [placesRes, statsRes] = await Promise.all([
        fetch(`/api/places?${buildQuery()}`),
        // Stats ignore the category filter so every chip keeps its own total.
        fetch(
          `/api/places/stats?${new URLSearchParams({
            pool,
            ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
          })}`
        ),
      ]);

      if (!placesRes.ok) {
        const body = await placesRes.json().catch(() => null);
        setLoadError(body?.error ?? `Yerler yüklenemedi (${placesRes.status})`);
        return;
      }

      const data = await placesRes.json();
      setPlaces(data.places ?? []);
      setTruncated(Boolean(data.hasMore));

      if (statsRes.ok) setStats(await statsRes.json());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setLoading(false);
    }
  }, [buildQuery, pool, searchQuery]);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(loadPlaces, searchQuery ? 350 : 0);
    return () => clearTimeout(timer);
  }, [loadPlaces, searchQuery]);

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

  /**
   * Photo backfill runs on demand, in batches, rather than on page load — a
   * free community API should not be hit implicitly (spec §8).
   */
  async function enrichPhotos() {
    setEnriching(true);
    setEnrichResult(null);
    try {
      const res = await fetch("/api/places/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20, pool }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setEnrichResult(body?.error ?? "Görseller alınamadı");
        return;
      }
      const data = await res.json();
      setEnrichResult(
        data.unavailable > 0
          ? `${data.found} bulundu · Wikipedia yanıt vermiyor, sonra tekrar dene`
          : `${data.found}/${data.attempted} görsel bulundu · ${data.remaining} yer kaldı`
      );
      loadPlaces();
    } catch (err) {
      setEnrichResult(
        err instanceof Error ? err.message : "Sunucuya ulaşılamadı"
      );
    } finally {
      setEnriching(false);
    }
  }

  /* --------------------------------- derived -------------------------------- */

  // The server already applied the search and category filter.
  const filteredPlaces = places;
  const categoryCounts = stats.counts;

  // Reset the incremental list when the filter changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    listRef.current?.scrollTo({ top: 0 });
  }, [selectedCategory, searchQuery, pool]);

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
        linkToDetail
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
          {/* Knowledge pool: what I saved vs. the discovery corpus */}
          <button
            onClick={() =>
              setPool((p) => (p === "personal" ? "reference" : "personal"))
            }
            className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold shadow-[var(--shadow-sm)] transition-all flex items-center gap-1.5 ${
              pool === "personal"
                ? "gradient-cool text-white"
                : "glass-panel text-foreground"
            }`}
            title={
              pool === "personal"
                ? "Kaydettiklerim gösteriliyor — keşif havuzuna geç"
                : "Keşif havuzu (Wikivoyage) gösteriliyor — kendi yerlerime dön"
            }
          >
            {pool === "personal" ? "★ Kaydettiklerim" : "🌍 Keşif havuzu"}
          </button>

          <button
            onClick={() => setSelectedCategory("all")}
            className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-medium shadow-[var(--shadow-sm)] transition-all ${
              selectedCategory === "all"
                ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                : "glass-panel text-foreground hover:shadow-[var(--shadow-md)]"
            }`}
          >
            Tümü {stats.total > 0 && `(${stats.total})`}
          </button>
          {TAXONOMY.filter((c) => categoryCounts[c.id]).map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCategory(c.id)}
              className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-medium shadow-[var(--shadow-sm)] transition-all flex items-center gap-1.5 ${
                selectedCategory === c.id
                  ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                  : "glass-panel text-foreground hover:shadow-[var(--shadow-md)]"
              }`}
            >
              <span>{c.icon}</span>
              {c.label} ({categoryCounts[c.id]})
            </button>
          ))}
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
                  {/* Photo backfill — only offered when photos are missing */}
                  {!loading &&
                    filteredPlaces.length > 0 &&
                    filteredPlaces.some((p) => !p.imageUrl) && (
                      <div className="flex items-center gap-2.5 p-3 bg-surface rounded-2xl">
                        <ImageIcon size={14} className="text-muted shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-medium">
                            {enrichResult ?? "Bazı yerlerin görseli yok"}
                          </p>
                          <p className="text-[10px] text-muted">
                            Wikipedia&apos;dan 20&apos;şer çekilir
                          </p>
                        </div>
                        <button
                          onClick={enrichPhotos}
                          disabled={enriching}
                          className="shrink-0 px-3 py-1.5 gradient-primary text-white rounded-lg text-[10px] font-bold disabled:opacity-40 flex items-center gap-1.5"
                        >
                          {enriching && (
                            <Loader2 size={10} className="animate-spin" />
                          )}
                          {enriching ? "Çekiliyor" : "Görsel çek"}
                        </button>
                      </div>
                    )}

                  {loadError ? (
                    <div className="text-center py-12">
                      <div className="w-16 h-16 rounded-3xl bg-danger/10 flex items-center justify-center mx-auto mb-4">
                        <X size={24} className="text-danger" />
                      </div>
                      <p className="font-medium text-sm">Yerler yüklenemedi</p>
                      <p className="text-xs text-muted mt-1">{loadError}</p>
                      <button
                        onClick={loadPlaces}
                        className="mt-4 px-4 py-2 bg-surface border border-card-border rounded-xl text-xs font-medium hover:bg-card-hover"
                      >
                        Tekrar dene
                      </button>
                    </div>
                  ) : loading ? (
                    <div className="text-center py-12">
                      <Loader2 size={20} className="animate-spin text-primary mx-auto" />
                    </div>
                  ) : filteredPlaces.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="w-16 h-16 rounded-3xl bg-primary-light flex items-center justify-center mx-auto mb-4">
                        {searchQuery ? (
                          <Search size={24} className="text-primary" />
                        ) : (
                          <MapPin size={24} className="text-primary" />
                        )}
                      </div>
                      {searchQuery ? (
                        <>
                          <p className="font-medium text-sm">
                            &ldquo;{searchQuery}&rdquo; için sonuç yok
                          </p>
                          <p className="text-xs text-muted mt-1">
                            {pool === "personal"
                              ? "Keşif havuzunda aramayı dene"
                              : "Farklı bir yazım dene"}
                          </p>
                          {pool === "personal" && (
                            <button
                              onClick={() => setPool("reference")}
                              className="mt-3 px-4 py-2 bg-surface border border-card-border rounded-xl text-xs font-medium hover:bg-card-hover"
                            >
                              Keşif havuzunda ara
                            </button>
                          )}
                        </>
                      ) : pool === "personal" ? (
                        <>
                          <p className="font-medium text-sm">
                            Henüz kaydettiğin yer yok
                          </p>
                          <p className="text-xs text-muted mt-1">
                            Link sekmesinden bir bağlantı yapıştır, ya da
                            yukarıdan keşif havuzuna geç
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-medium text-sm">Sonuç yok</p>
                          <p className="text-xs text-muted mt-1">
                            Filtreyi değiştir
                          </p>
                        </>
                      )}
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
                      {truncated && visibleCount >= filteredPlaces.length && (
                        <p className="text-center text-[11px] text-muted py-3">
                          {stats.total.toLocaleString("tr-TR")} sonuçtan ilk{" "}
                          {filteredPlaces.length.toLocaleString("tr-TR")} tanesi
                          — daraltmak için ara veya kategori seç
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
