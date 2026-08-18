/**
 * Shared place metadata and types.
 *
 * Kept free of Leaflet imports so both server-rendered components and the
 * client-only MapView can pull from it without dragging `window` into SSR.
 */

export const CATEGORY_COLORS: Record<string, string> = {
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
  attraction: "#6366f1",
  other: "#78716c",
};

export const CATEGORY_EMOJI: Record<string, string> = {
  restaurant: "🍽️",
  cafe: "☕",
  nature: "🌿",
  historic: "🏛️",
  museum: "🖼️",
  beach: "🏖️",
  viewpoint: "🌅",
  hiking: "🥾",
  nightlife: "🎶",
  shopping: "🛍️",
  accommodation: "🏨",
  "hidden-gem": "💎",
  attraction: "⭐",
  other: "📍",
};

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  notes: string;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  tags: string[];
  source?: string;
  imageUrl?: string | null;
}

export interface UserPosition {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
}

/** Great-circle distance in metres. */
export function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(m: number) {
  if (!m) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function formatDuration(s: number) {
  if (!s) return "—";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} dk`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}
