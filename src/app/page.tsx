"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import AddPlaceModal from "@/components/AddPlaceModal";
import { CATEGORIES } from "@/types";
import { MapPin, Filter, Plus, Trash2 } from "lucide-react";

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
}

export default function HomePage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [clickedPos, setClickedPos] = useState<{ lat: number; lng: number } | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);

  const loadPlaces = useCallback(async () => {
    try {
      const res = await fetch("/api/places");
      if (!res.ok) return;
      const data = await res.json();
      setPlaces(data);
    } catch {
      // ignore fetch errors
    }
  }, []);

  useEffect(() => {
    loadPlaces();
  }, [loadPlaces]);

  async function handleSave(data: {
    name: string;
    lat: number;
    lng: number;
    category: string;
    notes: string;
    tags: string[];
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

  const categoryCounts = places.reduce<Record<string, number>>((acc, p) => {
    acc[p.category] = (acc[p.category] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="h-[calc(100vh-3rem)] flex gap-4">
      {showSidebar && (
        <div className="hidden lg:flex flex-col w-80 bg-card border border-card-border rounded-xl p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <MapPin size={18} className="text-primary" />
              Yerlerim ({places.length})
            </h2>
          </div>

          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2 text-sm text-muted">
              <Filter size={14} />
              Filtre
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setSelectedCategory("all")}
                className={`px-2 py-1 rounded-full text-xs ${
                  selectedCategory === "all"
                    ? "bg-primary text-white"
                    : "bg-background border border-card-border"
                }`}
              >
                Tümü ({places.length})
              </button>
              {CATEGORIES.map((c) =>
                categoryCounts[c] ? (
                  <button
                    key={c}
                    onClick={() => setSelectedCategory(c)}
                    className={`px-2 py-1 rounded-full text-xs ${
                      selectedCategory === c
                        ? "bg-primary text-white"
                        : "bg-background border border-card-border"
                    }`}
                  >
                    {c} ({categoryCounts[c]})
                  </button>
                ) : null
              )}
            </div>
          </div>

          <div className="space-y-2 flex-1">
            {places
              .filter(
                (p) =>
                  selectedCategory === "all" || p.category === selectedCategory
              )
              .map((place) => (
                <div
                  key={place.id}
                  className="p-3 bg-background rounded-lg border border-card-border hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-medium text-sm">{place.name}</h3>
                      {place.address && (
                        <p className="text-xs text-muted mt-0.5">
                          {place.address}
                        </p>
                      )}
                      <span className="inline-block mt-1 px-2 py-0.5 bg-primary-light text-primary text-[10px] rounded-full">
                        {place.category}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDelete(place.id)}
                      className="text-muted hover:text-danger p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {place.notes && (
                    <p className="text-xs text-muted mt-2">{place.notes}</p>
                  )}
                </div>
              ))}
          </div>

          <p className="text-xs text-muted text-center mt-4">
            Haritaya tıklayarak yeni yer ekle
          </p>
        </div>
      )}

      <div className="flex-1 relative">
        <button
          onClick={() => setShowSidebar(!showSidebar)}
          className="hidden lg:flex absolute top-3 left-3 z-[1000] bg-card border border-card-border rounded-lg px-3 py-2 text-sm items-center gap-2 hover:bg-background"
        >
          <Filter size={14} />
          {showSidebar ? "Gizle" : "Göster"}
        </button>

        <MapView
          places={places}
          selectedCategory={selectedCategory}
          onMapClick={(lat, lng) => setClickedPos({ lat, lng })}
          onPlaceDelete={handleDelete}
        />

        <button
          onClick={() => setClickedPos({ lat: 48.2082, lng: 16.3738 })}
          className="lg:hidden absolute bottom-6 right-6 z-[1000] bg-primary text-white rounded-full p-4 shadow-lg"
        >
          <Plus size={24} />
        </button>
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
