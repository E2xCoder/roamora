"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Search, Compass, MapPin, Star, Loader2 } from "lucide-react";

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

export default function ExplorePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [pois, setPois] = useState<OverpassPOI[]>([]);
  const [wikiListings, setWikiListings] = useState<WikiListing[]>([]);
  const [wikiTitle, setWikiTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  async function searchOverpass() {
    if (!lat || !lng) return;
    setLoading(true);
    const res = await fetch(
      `/api/explore?source=overpass&lat=${lat}&lng=${lng}&radius=10000`
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
  }

  async function saveWikiListing(listing: WikiListing) {
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
    <div className="h-[calc(100vh-3rem)] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Compass size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Hidden Gems Keşfet</h1>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-card border border-card-border rounded-xl p-4">
          <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
            <MapPin size={16} />
            Koordinat ile Ara (Overpass)
          </h3>
          <div className="flex gap-2">
            <input
              type="number"
              step="any"
              placeholder="Enlem (ör: 50.075)"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
            />
            <input
              type="number"
              step="any"
              placeholder="Boylam (ör: 14.437)"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
            />
            <button
              onClick={searchOverpass}
              disabled={loading}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>
        </div>

        <div className="bg-card border border-card-border rounded-xl p-4">
          <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
            <Star size={16} />
            Şehir ile Ara (Wikivoyage)
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Şehir adı (ör: Prague)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchWikivoyage()}
              className="flex-1 px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
            />
            <button
              onClick={searchWikivoyage}
              disabled={loading}
              className="px-4 py-2 bg-secondary text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 grid lg:grid-cols-[1fr_350px] gap-4 min-h-0">
        <div className="min-h-[300px]">
          <MapView places={mapPlaces} />
        </div>

        <div className="bg-card border border-card-border rounded-xl p-4 overflow-y-auto">
          <h3 className="font-bold text-sm mb-3">
            Sonuçlar ({pois.filter((p) => p.tags.name).length + wikiListings.length})
          </h3>

          {wikiTitle && (
            <p className="text-xs text-muted mb-3">Wikivoyage: {wikiTitle}</p>
          )}

          <div className="space-y-2">
            {pois
              .filter((p) => p.tags.name)
              .map((poi) => (
                <div
                  key={poi.id}
                  className="p-3 bg-background rounded-lg border border-card-border"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-medium text-sm">{poi.tags.name}</h4>
                      <p className="text-xs text-muted mt-0.5">
                        {poi.tags.tourism || poi.tags.historic || poi.tags.natural || "POI"}
                      </p>
                    </div>
                    <button
                      onClick={() => savePOI(poi)}
                      className="text-xs px-2 py-1 bg-primary text-white rounded"
                    >
                      Kaydet
                    </button>
                  </div>
                </div>
              ))}

            {wikiListings.map((listing, i) => (
              <div
                key={i}
                className="p-3 bg-background rounded-lg border border-card-border"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-medium text-sm">{listing.name}</h4>
                    {listing.address && (
                      <p className="text-xs text-muted mt-0.5">
                        {listing.address}
                      </p>
                    )}
                    {listing.description && (
                      <p className="text-xs text-muted mt-1 line-clamp-2">
                        {listing.description}
                      </p>
                    )}
                  </div>
                  {listing.lat && listing.lng && (
                    <button
                      onClick={() => saveWikiListing(listing)}
                      className="text-xs px-2 py-1 bg-secondary text-white rounded shrink-0"
                    >
                      Kaydet
                    </button>
                  )}
                </div>
              </div>
            ))}

            {pois.length === 0 && wikiListings.length === 0 && (
              <p className="text-sm text-muted text-center py-8">
                Koordinat veya şehir adı ile arama yap
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
