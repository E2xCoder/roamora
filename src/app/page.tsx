"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import AddPlaceModal from "@/components/AddPlaceModal";
import { CATEGORIES } from "@/types";
import {
  MapPin, Filter, Plus, Trash2, Link2, Loader2, Search,
  ExternalLink, X, Check, ChevronDown, Sparkles
} from "lucide-react";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  notes: string;
  address?: string;
  tags: string[];
  source: string;
  imageUrl?: string;
}

interface ExtractedData {
  title: string;
  description: string;
  thumbnailUrl?: string;
  thumbnailPath?: string;
  platform: string;
  placeName?: string;
  lat?: number;
  lng?: number;
  category?: string;
  sourceUrl: string;
}

export default function HomePage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [clickedPos, setClickedPos] = useState<{ lat: number; lng: number } | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);

  // URL extraction state
  const [urlInput, setUrlInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editLat, setEditLat] = useState("");
  const [editLng, setEditLng] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

  async function handleExtract() {
    if (!urlInput.trim()) return;
    setExtracting(true);
    setExtracted(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      if (!res.ok) throw new Error("Extract failed");
      const data = await res.json();
      setExtracted(data.extracted);
      setEditName(data.extracted.placeName || data.extracted.title || "");
      setEditCategory(data.extracted.category || "attraction");
      setEditLat(data.extracted.lat?.toString() || "");
      setEditLng(data.extracted.lng?.toString() || "");
    } catch {
      alert("Link'ten veri çekilemedi. URL'yi kontrol et.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleSaveExtracted() {
    if (!editName || !editLat || !editLng) return;
    setSaving(true);

    try {
      const res = await fetch("/api/extract", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          lat: parseFloat(editLat),
          lng: parseFloat(editLng),
          category: editCategory,
          notes: extracted?.description?.slice(0, 200) || "",
          sourceUrl: extracted?.sourceUrl,
          thumbnailPath: extracted?.thumbnailPath,
          thumbnailUrl: extracted?.thumbnailUrl,
          platform: extracted?.platform,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setExtracted(null);
      setUrlInput("");
      loadPlaces();
    } catch {
      alert("Kaydetme başarısız.");
    } finally {
      setSaving(false);
    }
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
    loadPlaces();
  }

  const filteredPlaces = places.filter((p) => {
    const catMatch = selectedCategory === "all" || p.category === selectedCategory;
    const searchMatch = !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase());
    return catMatch && searchMatch;
  });

  const categoryCounts = places.reduce<Record<string, number>>((acc, p) => {
    acc[p.category] = (acc[p.category] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="h-[calc(100vh-3rem)] flex">
      {showSidebar && (
        <div className="hidden lg:flex flex-col w-96 border-r border-card-border bg-card overflow-hidden">
          {/* URL Paste Section */}
          <div className="p-4 border-b border-card-border bg-gradient-to-b from-primary/5 to-transparent">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={16} className="text-primary" />
              <span className="text-sm font-semibold">Link Yapistir</span>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleExtract()}
                  placeholder="TikTok veya Instagram linki..."
                  className="w-full pl-9 pr-3 py-2.5 bg-background border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <button
                onClick={handleExtract}
                disabled={extracting || !urlInput.trim()}
                className="px-4 py-2.5 bg-primary text-white rounded-xl text-sm font-medium hover:bg-primary-hover disabled:opacity-50 flex items-center gap-1.5 shrink-0"
              >
                {extracting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Ekle
              </button>
            </div>

            {/* Extraction Result */}
            {extracted && (
              <div className="mt-3 p-3 bg-background rounded-xl border border-card-border">
                <div className="flex gap-3">
                  {extracted.thumbnailUrl && (
                    <img
                      src={extracted.thumbnailUrl}
                      alt=""
                      className="w-16 h-16 rounded-lg object-cover shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Yer adi..."
                      className="w-full px-2 py-1 bg-card border border-card-border rounded-lg text-sm font-medium mb-1.5"
                    />
                    <div className="flex gap-1.5 mb-1.5">
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="flex-1 px-2 py-1 bg-card border border-card-border rounded-lg text-xs"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <span className="text-[10px] text-muted px-2 py-1 bg-card rounded-lg border border-card-border">
                        {extracted.platform}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={editLat}
                        onChange={(e) => setEditLat(e.target.value)}
                        placeholder="Lat"
                        className="w-20 px-2 py-1 bg-card border border-card-border rounded-lg text-xs"
                      />
                      <input
                        type="text"
                        value={editLng}
                        onChange={(e) => setEditLng(e.target.value)}
                        placeholder="Lng"
                        className="w-20 px-2 py-1 bg-card border border-card-border rounded-lg text-xs"
                      />
                    </div>
                  </div>
                </div>
                {extracted.description && (
                  <p className="text-[11px] text-muted mt-2 line-clamp-2">
                    {extracted.description}
                  </p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleSaveExtracted}
                    disabled={saving || !editName || !editLat || !editLng}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary-hover disabled:opacity-50"
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Kaydet
                  </button>
                  <button
                    onClick={() => { setExtracted(null); setUrlInput(""); }}
                    className="px-3 py-2 bg-background border border-card-border rounded-lg text-xs hover:bg-card"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Search */}
          <div className="p-3 border-b border-card-border">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Yer ara..."
                className="w-full pl-9 pr-3 py-2 bg-background border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>

          {/* Category Filter */}
          <div className="px-3 py-2 border-b border-card-border">
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSelectedCategory("all")}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedCategory === "all"
                    ? "bg-primary text-white"
                    : "bg-background border border-card-border hover:border-primary/30"
                }`}
              >
                Tumu ({places.length})
              </button>
              {CATEGORIES.map((c) =>
                categoryCounts[c] ? (
                  <button
                    key={c}
                    onClick={() => setSelectedCategory(c)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      selectedCategory === c
                        ? "bg-primary text-white"
                        : "bg-background border border-card-border hover:border-primary/30"
                    }`}
                  >
                    {c} ({categoryCounts[c]})
                  </button>
                ) : null
              )}
            </div>
          </div>

          {/* Place Cards */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {filteredPlaces.length === 0 ? (
              <div className="text-center py-12 text-muted">
                <MapPin size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">Henuz yer yok</p>
                <p className="text-xs mt-1">Yukardaki kutuya TikTok/Instagram linki yapistir</p>
              </div>
            ) : (
              filteredPlaces.map((place) => (
                <div
                  key={place.id}
                  className="group p-3 bg-background rounded-xl border border-card-border hover:border-primary/30 transition-all cursor-pointer"
                >
                  <div className="flex gap-3">
                    {place.imageUrl ? (
                      <img
                        src={place.imageUrl}
                        alt=""
                        className="w-14 h-14 rounded-lg object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-card border border-card-border flex items-center justify-center shrink-0">
                        <MapPin size={18} className="text-muted" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between">
                        <h3 className="font-medium text-sm truncate">{place.name}</h3>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(place.id); }}
                          className="text-muted hover:text-danger p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      {place.address && (
                        <p className="text-[11px] text-muted truncate">{place.address}</p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="px-2 py-0.5 bg-primary/10 text-primary text-[10px] rounded-full font-medium">
                          {place.category}
                        </span>
                        {place.source !== "manual" && (
                          <span className="text-[10px] text-muted">{place.source}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {place.notes && (
                    <p className="text-[11px] text-muted mt-2 line-clamp-2">{place.notes}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Map */}
      <div className="flex-1 relative">
        <button
          onClick={() => setShowSidebar(!showSidebar)}
          className="hidden lg:flex absolute top-3 left-3 z-[1000] bg-card/90 backdrop-blur-sm border border-card-border rounded-xl px-3 py-2 text-sm items-center gap-2 hover:bg-card shadow-sm"
        >
          <ChevronDown size={14} className={showSidebar ? "rotate-90" : "-rotate-90"} />
          {showSidebar ? "Gizle" : "Panel"}
        </button>

        {/* Mobile URL input */}
        <div className="lg:hidden absolute top-3 left-3 right-3 z-[1000] flex gap-2">
          <div className="flex-1 relative">
            <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="TikTok/Instagram linki..."
              className="w-full pl-9 pr-3 py-2.5 bg-card/90 backdrop-blur-sm border border-card-border rounded-xl text-sm shadow-sm"
            />
          </div>
          <button
            onClick={handleExtract}
            disabled={extracting || !urlInput.trim()}
            className="px-4 py-2.5 bg-primary text-white rounded-xl text-sm shadow-sm disabled:opacity-50"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </div>

        <MapView
          places={places}
          selectedCategory={selectedCategory}
          onMapClick={(lat, lng) => setClickedPos({ lat, lng })}
          onPlaceDelete={handleDelete}
        />
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
