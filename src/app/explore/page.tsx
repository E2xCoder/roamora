"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Search, Compass, Star, Loader2, Plus, CheckCircle, Gem, Sparkles } from "lucide-react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface OverpassPOI {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface WikiListing {
  name: string;
  lat?: number;
  lng?: number;
  address?: string;
  description?: string;
  type: string;
}

const POPULAR_CITIES = [
  { name: "Istanbul", lat: 41.0082, lng: 28.9784 },
  { name: "Prague", lat: 50.0755, lng: 14.4378 },
  { name: "Barcelona", lat: 41.3874, lng: 2.1686 },
  { name: "Rome", lat: 41.9028, lng: 12.4964 },
  { name: "Paris", lat: 48.8566, lng: 2.3522 },
  { name: "Amsterdam", lat: 52.3676, lng: 4.9041 },
  { name: "Vienna", lat: 48.2082, lng: 16.3738 },
  { name: "Lisbon", lat: 38.7223, lng: -9.1393 },
];

type CategoryFilter = "popular" | "hidden-gems" | "food" | "free" | "museums" | "architecture" | "photo";

const CATEGORIES: Array<{ id: CategoryFilter; label: string }> = [
  { id: "popular", label: "Popüler" },
  { id: "hidden-gems", label: "Gizli Hazineler" },
  { id: "food", label: "Yemek" },
  { id: "free", label: "Ücretsiz" },
  { id: "museums", label: "Müzeler" },
  { id: "architecture", label: "Mimari" },
  { id: "photo", label: "Fotoğraf Noktaları" },
];

/** Real client-side tag filtering over already-fetched OSM data — /api/explore has no server-side category param, so this narrows down what's already real, not a fabricated grouping. */
function matchesCategory(poi: OverpassPOI, cat: CategoryFilter): boolean {
  const t = poi.tags;
  switch (cat) {
    case "popular": return true;
    case "hidden-gems": return true; // every overpass result here already came from the same "notable but not mainstream" query getHiddenGems() runs
    case "food": return Boolean(t.amenity === "restaurant" || t.amenity === "cafe" || t.amenity === "bar" || t.cuisine);
    case "free": return t.fee === "no" || (!t.fee && !t.charge);
    case "museums": return t.tourism === "museum" || t.tourism === "gallery";
    case "architecture": return Boolean(t.historic || t.building === "cathedral" || t.building === "castle" || t.amenity === "place_of_worship");
    case "photo": return t.tourism === "viewpoint" || t.tourism === "artwork" || Boolean(t.natural);
    default: return true;
  }
}

export default function ExplorePage() {
  const [cityQuery, setCityQuery] = useState("");
  const [cityName, setCityName] = useState<string | null>(null);
  const [pois, setPois] = useState<OverpassPOI[]>([]);
  const [wikiListings, setWikiListings] = useState<WikiListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<CategoryFilter>("popular");

  async function exploreCity(name: string, coords?: { lat: number; lng: number }) {
    setLoading(true);
    setError(null);
    setCityName(name);
    setCityQuery(name);
    try {
      let lat = coords?.lat;
      let lng = coords?.lng;
      if (lat == null || lng == null) {
        const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(name)}`);
        if (!geoRes.ok) {
          const body = await geoRes.json().catch(() => null);
          setError(body?.error ?? "Şehir bulunamadı");
          setLoading(false);
          return;
        }
        const geo = await geoRes.json();
        lat = geo.lat; lng = geo.lng;
      }

      const [overpassRes, wikiRes] = await Promise.all([
        fetch(`/api/explore?source=overpass&lat=${lat}&lng=${lng}&radius=10000`),
        fetch(`/api/explore?source=wikivoyage&q=${encodeURIComponent(name)}`),
      ]);

      let overpassFailed = false;
      if (overpassRes.ok) {
        setPois(await overpassRes.json());
      } else {
        overpassFailed = true;
        setPois([]);
      }

      let wikiFailed = false;
      if (wikiRes.ok) {
        const data = await wikiRes.json();
        setWikiListings(data.listings ?? []);
      } else {
        wikiFailed = true;
        setWikiListings([]);
      }

      // Partial degradation is real and should say so honestly — a source
      // outage (e.g. the public Overpass API rate-limiting under load) is
      // not the same as "no places exist here".
      if (overpassFailed && wikiFailed) {
        setError("Şu an hiçbir kaynağa ulaşılamıyor — birazdan tekrar dene.");
      } else if (overpassFailed) {
        setError("OpenStreetMap kaynağına şu an ulaşılamıyor — Wikivoyage sonuçları gösteriliyor.");
      } else if (wikiFailed) {
        setError("Wikivoyage kaynağına şu an ulaşılamıyor — OpenStreetMap sonuçları gösteriliyor.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setLoading(false);
    }
  }

  async function savePOI(poi: OverpassPOI) {
    await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: poi.tags.name || "Unknown",
        lat: poi.lat,
        lng: poi.lon,
        category: poi.tags.tourism || poi.tags.historic || poi.tags.natural || "other",
        notes: poi.tags.description || "",
        source: "overpass",
        isHiddenGem: true,
      }),
    });
    setSavedIds((prev) => new Set([...prev, `poi-${poi.id}`]));
  }

  async function saveWikiListing(listing: WikiListing, idx: number) {
    if (!listing.lat || !listing.lng) return;
    await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: listing.name,
        lat: listing.lat,
        lng: listing.lng,
        category: listing.type === "eat" ? "restaurant" : listing.type === "see" ? "historic" : "other",
        notes: listing.description || "",
        address: listing.address,
        source: "overpass",
        isHiddenGem: true,
      }),
    });
    setSavedIds((prev) => new Set([...prev, `wiki-${idx}`]));
  }

  const filteredPois = useMemo(
    () => pois.filter((p) => p.tags.name && matchesCategory(p, category)),
    [pois, category]
  );

  const mapPlaces = [
    ...filteredPois.map((p) => ({
      id: `poi-${p.id}`, name: p.tags.name, lat: p.lat, lng: p.lon,
      category: "hidden-gem", notes: "", tags: [],
    })),
    ...wikiListings.filter((l) => l.lat && l.lng).map((l, i) => ({
      id: `wiki-${i}`, name: l.name, lat: l.lat!, lng: l.lng!,
      category: "hidden-gem", notes: l.description || "", tags: [],
    })),
  ];

  const hasResults = filteredPois.length > 0 || wikiListings.length > 0;

  return (
    <div className="min-h-screen pb-24">
      <div className="px-6 pt-6 pb-5 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold">
          {cityName ? `${cityName} Keşfet` : "Keşfet"}
        </h1>
        <p className="text-sm text-muted-fg mt-0.5">Gizli hazineler ve yerel öneriler — gerçek OSM ve Wikivoyage verisi</p>

        <div className="flex gap-2 mt-4 max-w-lg">
          <div className="flex-1 min-w-0 flex items-center bg-card border border-card-border rounded-2xl overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all">
            <Search size={16} className="ml-4 text-muted shrink-0" />
            <input
              type="text"
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && cityQuery.trim() && exploreCity(cityQuery.trim())}
              placeholder="Bir şehir ara…"
              className="flex-1 px-3 py-3 bg-transparent text-sm focus:outline-none"
            />
          </div>
          <Button onClick={() => cityQuery.trim() && exploreCity(cityQuery.trim())} disabled={loading || !cityQuery.trim()} variant="primary">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          </Button>
        </div>

        {error && <p className="text-xs text-danger mt-2">{error}</p>}

        {/* Primary bridge into the autonomous planner — discovery here should lead to a real plan, not dead-end at manual saves */}
        {cityName && (
          <Link
            href={`/?destination=${encodeURIComponent(cityName)}`}
            className="mt-4 flex items-center justify-between gap-3 px-5 py-4 rounded-2xl gradient-brand text-white shadow-[var(--shadow-md)] hover:opacity-95 transition-opacity"
          >
            <div className="flex items-center gap-3">
              <Sparkles size={18} />
              <div>
                <p className="text-sm font-semibold">{cityName} için otonom bir gezi planla</p>
                <p className="text-xs text-white/80">Roamora rota, restoran, gizli hazine ve bütçeyi kendisi araştırsın</p>
              </div>
            </div>
            <span className="text-xs font-semibold whitespace-nowrap">Planla →</span>
          </Link>
        )}

        {!cityName && (
          <div className="mt-5">
            <p className="text-xs font-semibold text-muted-fg uppercase tracking-wider mb-2">Popüler Şehirler</p>
            <div className="flex gap-2 overflow-x-auto hide-scrollbar">
              {POPULAR_CITIES.map((city) => (
                <button
                  key={city.name}
                  onClick={() => exploreCity(city.name, city)}
                  className="shrink-0 px-4 py-2.5 bg-card border border-card-border rounded-2xl text-sm font-medium hover:border-primary/50 hover:shadow-[var(--shadow-sm)] transition-all"
                >
                  {city.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {cityName && (
          <div className="mt-4 flex gap-2 overflow-x-auto hide-scrollbar">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-medium transition-all ${
                  category === c.id ? "bg-primary text-white" : "bg-surface text-muted-fg hover:text-foreground"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content — never appears empty (spec §22): popular cities above when idle, real results/empty-but-helpful state once a city is picked */}
      {cityName && (
        <div className="px-6 max-w-6xl mx-auto grid lg:grid-cols-[1fr_400px] gap-5">
          <div className="h-[360px] lg:h-[560px] rounded-3xl overflow-hidden border border-card-border shadow-[var(--shadow-md)] order-1">
            <MapView places={mapPlaces} />
          </div>

          <div className="space-y-3 max-h-[560px] overflow-y-auto hide-scrollbar order-2">
            {loading && (
              <div className="text-center py-16"><Loader2 size={20} className="animate-spin text-primary mx-auto" /></div>
            )}

            {!loading && !hasResults && (
              <Card padding="lg" className="text-center">
                <Compass size={26} className="text-muted mx-auto mb-2" />
                <p className="text-sm font-medium">Bu kategoride sonuç yok</p>
                <p className="text-xs text-muted-fg mt-1">Başka bir kategori dene</p>
              </Card>
            )}

            {filteredPois.map((poi) => {
              const isSaved = savedIds.has(`poi-${poi.id}`);
              return (
                <Card key={poi.id} padding="md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Gem size={12} className="text-accent shrink-0" />
                        <h4 className="font-semibold text-sm truncate">{poi.tags.name}</h4>
                      </div>
                      <p className="text-xs text-muted-fg mt-0.5">
                        {poi.tags.tourism || poi.tags.historic || poi.tags.natural || "POI"}
                      </p>
                      {poi.tags.description && <p className="text-[11px] text-muted-fg mt-1 line-clamp-2">{poi.tags.description}</p>}
                    </div>
                    <button
                      onClick={() => savePOI(poi)}
                      disabled={isSaved}
                      title="Haritada kişisel kaydet — otonom planlamayı etkilemez"
                      className={`shrink-0 p-2 rounded-xl border transition-all ${isSaved ? "border-success/30 text-success" : "border-card-border text-muted hover:text-foreground hover:border-muted"}`}
                      aria-label={isSaved ? "Kaydedildi" : "Haritada kaydet"}
                    >
                      {isSaved ? <CheckCircle size={14} /> : <Plus size={14} />}
                    </button>
                  </div>
                </Card>
              );
            })}

            {wikiListings.map((listing, i) => {
              const isSaved = savedIds.has(`wiki-${i}`);
              return (
                <Card key={i} padding="md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Star size={12} className="text-secondary shrink-0" />
                        <h4 className="font-semibold text-sm truncate">{listing.name}</h4>
                      </div>
                      {listing.address && <p className="text-[11px] text-muted-fg mt-0.5">{listing.address}</p>}
                      {listing.description && <p className="text-[11px] text-muted-fg mt-1 line-clamp-2">{listing.description}</p>}
                    </div>
                    {listing.lat && listing.lng && (
                      <button
                        onClick={() => saveWikiListing(listing, i)}
                        disabled={isSaved}
                        title="Haritada kişisel kaydet — otonom planlamayı etkilemez"
                        className={`shrink-0 p-2 rounded-xl border transition-all ${isSaved ? "border-success/30 text-success" : "border-card-border text-muted hover:text-foreground hover:border-muted"}`}
                        aria-label={isSaved ? "Kaydedildi" : "Haritada kaydet"}
                      >
                        {isSaved ? <CheckCircle size={14} /> : <Plus size={14} />}
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
