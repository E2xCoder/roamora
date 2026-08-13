export interface PlaceFormData {
  name: string;
  lat: number;
  lng: number;
  category: string;
  tags: string[];
  notes: string;
  source: "google" | "instagram" | "manual" | "overpass";
  imageUrl?: string;
  address?: string;
  rating?: number;
  isHiddenGem?: boolean;
}

export interface TripFormData {
  destination: string;
  startDate: string;
  endDate: string;
  preferences: string[];
}

export interface OverpassNode {
  type: string;
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface OverpassWay {
  type: string;
  id: number;
  geometry: Array<{ lat: number; lon: number }>;
  tags: Record<string, string>;
}

export interface OverpassRelation {
  type: string;
  id: number;
  members: Array<{
    type: string;
    ref: number;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
  tags: Record<string, string>;
}

export type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

export interface HikingTrailData {
  osmId: string;
  name: string;
  country?: string;
  distanceKm?: number;
  difficulty?: string;
  elevationGain?: number;
  description?: string;
  geometry: string;
  trailType: string;
}

export interface WikivoyageSection {
  title: string;
  content: string;
}

export interface TripPlanDay {
  dayNumber: number;
  date: string;
  activities: TripPlanActivity[];
}

export interface TripPlanActivity {
  placeName: string;
  lat: number;
  lng: number;
  timeSlot: string;
  notes: string;
  order: number;
}

export const CATEGORIES = [
  "restaurant",
  "cafe",
  "nature",
  "historic",
  "museum",
  "beach",
  "viewpoint",
  "hiking",
  "nightlife",
  "shopping",
  "accommodation",
  "hidden-gem",
  "other",
] as const;

export const TRIP_PREFERENCES = [
  "foodie",
  "nature",
  "culture",
  "history",
  "adventure",
  "relaxation",
  "nightlife",
  "shopping",
  "photography",
  "hiking",
] as const;
