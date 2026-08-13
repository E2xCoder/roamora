"use client";

import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const CATEGORY_COLORS: Record<string, string> = {
  restaurant: "#ef4444",
  cafe: "#f59e0b",
  nature: "#22c55e",
  historic: "#8b5cf6",
  museum: "#6366f1",
  beach: "#06b6d4",
  viewpoint: "#ec4899",
  hiking: "#059669",
  nightlife: "#a855f7",
  shopping: "#f97316",
  accommodation: "#3b82f6",
  "hidden-gem": "#eab308",
  other: "#78716c",
};

function createIcon(category: string) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};width:28px;height:28px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  notes: string;
  address?: string;
  tags: string[];
}

interface MapViewProps {
  places: Place[];
  center?: [number, number];
  zoom?: number;
  onMapClick?: (lat: number, lng: number) => void;
  onPlaceDelete?: (id: string) => void;
  selectedCategory?: string;
}

function MapClickHandler({
  onClick,
}: {
  onClick?: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitBounds({ places }: { places: Place[] }) {
  const map = useMap();
  useEffect(() => {
    if (places.length === 0) return;
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }, [places, map]);
  return null;
}

export default function MapView({
  places,
  center = [48.2082, 16.3738],
  zoom = 5,
  onMapClick,
  onPlaceDelete,
  selectedCategory = "all",
}: MapViewProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="w-full h-full bg-card rounded-xl flex items-center justify-center">
        <p className="text-muted">Harita yükleniyor...</p>
      </div>
    );
  }

  const filtered =
    selectedCategory === "all"
      ? places
      : places.filter((p) => p.category === selectedCategory);

  return (
    <MapContainer center={center} zoom={zoom} className="rounded-xl">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickHandler onClick={onMapClick} />
      {filtered.length > 0 && <FitBounds places={filtered} />}
      {filtered.map((place) => (
        <Marker
          key={place.id}
          position={[place.lat, place.lng]}
          icon={createIcon(place.category)}
        >
          <Popup>
            <div className="min-w-[180px]">
              <h3 className="font-bold text-sm">{place.name}</h3>
              {place.address && (
                <p className="text-xs text-gray-500 mt-1">{place.address}</p>
              )}
              <p className="text-xs mt-1">
                <span
                  className="inline-block px-2 py-0.5 rounded-full text-white text-[10px]"
                  style={{
                    background:
                      CATEGORY_COLORS[place.category] || CATEGORY_COLORS.other,
                  }}
                >
                  {place.category}
                </span>
              </p>
              {place.notes && (
                <p className="text-xs mt-2 text-gray-600">{place.notes}</p>
              )}
              {onPlaceDelete && (
                <button
                  onClick={() => onPlaceDelete(place.id)}
                  className="mt-2 text-xs text-red-500 hover:text-red-700"
                >
                  Sil
                </button>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
