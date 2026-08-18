"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Search, Compass, MapPin, Star, Loader2, Plus, CheckCircle } from "lucide-react";

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

export default function ExplorePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [pois, setPois] = useState<OverpassPOI[]>([]);
  const [wikiListings, setWikiListings] = useState<WikiListing[]>([]);
  const [wikiTitle, setWikiTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  async function searchOverpass(latVal?: number, lngVal?: number) {
    const searchLat = latVal?.toString() || lat;
    const searchLng = lngVal?.toString() || lng;
    if (!searchLat || !searchLng) return;
    setLoading(true);
    const res = await fetch(
      `/api/explore?source=overpass&lat=${searchLat}&lng=${searchLng}&radius=10000`
    );
    const data = await res.json();
    setPois(data);
    setLoading(false);
  }

  async function searchWikivoyage() {
    if (!searchQuery) return;
    setLoading(true);
    const res = await fetch(
      `/api/explore?source=wikivoyage&q=${encodeURIComponent(searchQuery)}`
    );
    const data = await res.json();
    if (data.listings) {
      setWikiListings(data.listings);
      setWikiTitle(data.title);
    }
    setLoading(false);
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

  function handleCityClick(city: { name: string; lat: number; lng: number }) {
    setLat(city.lat.toString());
    setLng(city.lng.toString());
    setSearchQuery(city.name);
    searchOverpass(city.lat, city.lng);
  }

  const mapPlaces = [
    ...pois
      .filter((p) => p.tags.name)
      .map((p) => ({
        id: `poi-${p.id}`,
        name: p.tags.name,
        lat: p.lat,
        lng: p.lon,
        category: "hidden-gem",
        notes: "",
        tags: [],
      })),
    ...wikiListings
      .filter((l) => l.lat && l.lng)
      .map((l, i) => ({
        id: `wiki-${i}`,
        name: l.name,
        lat: l.lat!,
        lng: l.lng!,
        category: "hidden-gem",
        notes: l.description || "",
        tags: [],
      })),
  ];

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-2xl gradient-cool flex items-center justify-center">
            <Compass size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Kesfet</h1>
            <p className="text-xs text-muted">Hidden gems & yerel oneriler</p>
          </div>
        </div>
      </div>

      {/* Search bars */}
      <div className="px-6 space-y-3 mb-6">
        <div className="flex gap-2">
          <div className="flex-1 min-w-0 flex items-center bg-card border border-card-border rounded-2xl overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all">
            <Star size={16} className="ml-4 text-secondary shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchWikivoyage()}
              placeholder="Sehir adi (Wikivoyage)"
              className="flex-1 px-3 py-3 bg-transparent text-sm focus:outline-none"
            />
          </div>
          <button
            onClick={searchWikivoyage}
            disabled={loading || !searchQuery}
            className="px-5 py-3 gradient-primary text-white rounded-2xl text-sm font-semibold disabled:opacity-40 flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="number"
            step="any"
            placeholder="Lat"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            className="flex-1 min-w-0 px-4 py-3 bg-card border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
          />
          <input
            type="number"
            step="any"
            placeholder="Lng"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            className="flex-1 min-w-0 px-4 py-3 bg-card border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
          />
          <button
            onClick={() => searchOverpass()}
            disabled={loading || !lat || !lng}
            className="px-5 py-3 gradient-nature text-white rounded-2xl text-sm font-semibold disabled:opacity-40 flex items-center gap-2"
          >
            <MapPin size={14} />
          </button>
        </div>
      </div>

      {/* Popular cities */}
      <div className="px-6 mb-6">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Populer Sehirler</p>
        <div className="flex gap-2 overflow-x-auto hide-scrollbar">
          {POPULAR_CITIES.map((city) => (
            <button
              key={city.name}
              onClick={() => handleCityClick(city)}
              className="shrink-0 px-4 py-2.5 bg-card border border-card-border rounded-2xl text-sm font-medium hover:border-primary/50 hover:shadow-[var(--shadow-md)] transition-all"
            >
              {city.name}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="px-6 pb-24 grid lg:grid-cols-[1fr_400px] gap-6">
        {/* Map */}
        <div className="h-[400px] lg:h-[500px] rounded-3xl overflow-hidden border border-card-border shadow-[var(--shadow-md)]">
          <MapView places={mapPlaces} />
        </div>

        {/* Results */}
        <div className="space-y-3 max-h-[500px] overflow-y-auto hide-scrollbar">
          {wikiTitle && (
            <div className="flex items-center gap-2 px-1">
              <Star size={14} className="text-secondary" />
              <p className="text-sm font-semibold">{wikiTitle}</p>
            </div>
          )}

          {pois.length === 0 && wikiListings.length === 0 && !loading && (
            <div className="text-center py-16">
              <div className="w-16 h-16 rounded-3xl gradient-cool flex items-center justify-center mx-auto mb-4 opacity-50">
                <Compass size={28} className="text-white" />
              </div>
              <p className="text-sm text-muted">Sehir ya da koordinat ile arama yap</p>
            </div>
          )}

          {pois
            .filter((p) => p.tags.name)
            .map((poi) => {
              const isSaved = savedIds.has(`poi-${poi.id}`);
              return (
                <div
                  key={poi.id}
                  className="bg-card border border-card-border rounded-2xl p-4 hover:shadow-[var(--shadow-md)] transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm">{poi.tags.name}</h4>
                      <p className="text-xs text-muted mt-0.5">
                        {poi.tags.tourism || poi.tags.historic || poi.tags.natural || "POI"}
                      </p>
                      {poi.tags.description && (
                        <p className="text-[11px] text-muted mt-1 line-clamp-2">{poi.tags.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => savePOI(poi)}
                      disabled={isSaved}
                      className={`shrink-0 p-2.5 rounded-xl transition-all ${
                        isSaved
                          ? "bg-success/10 text-success"
                          : "bg-primary-light text-primary hover:bg-primary hover:text-white"
                      }`}
                    >
                      {isSaved ? <CheckCircle size={16} /> : <Plus size={16} />}
                    </button>
                  </div>
                </div>
              );
            })}

          {wikiListings.map((listing, i) => {
            const isSaved = savedIds.has(`wiki-${i}`);
            return (
              <div
                key={i}
                className="bg-card border border-card-border rounded-2xl p-4 hover:shadow-[var(--shadow-md)] transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-sm">{listing.name}</h4>
                    {listing.address && (
                      <p className="text-[11px] text-muted mt-0.5">{listing.address}</p>
                    )}
                    {listing.description && (
                      <p className="text-[11px] text-muted mt-1 line-clamp-2">{listing.description}</p>
                    )}
                  </div>
                  {listing.lat && listing.lng && (
                    <button
                      onClick={() => saveWikiListing(listing, i)}
                      disabled={isSaved}
                      className={`shrink-0 p-2.5 rounded-xl transition-all ${
                        isSaved
                          ? "bg-success/10 text-success"
                          : "bg-secondary-light text-secondary hover:bg-secondary hover:text-white"
                      }`}
                    >
                      {isSaved ? <CheckCircle size={16} /> : <Plus size={16} />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
