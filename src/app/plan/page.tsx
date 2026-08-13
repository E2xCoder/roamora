"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { CalendarDays, Plus, Trash2, Loader2, MapPin, Clock } from "lucide-react";
import { TRIP_PREFERENCES } from "@/types";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface TripActivity {
  id: string;
  placeName: string;
  lat: number;
  lng: number;
  timeSlot: string;
  order: number;
  notes: string;
}

interface TripDay {
  id: string;
  dayNumber: number;
  date: string;
  activities: TripActivity[];
}

interface Trip {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  preferences: string[];
  status: string;
  days: TripDay[];
}

export default function PlanPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [selectedDay, setSelectedDay] = useState<number>(1);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);

  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [preferences, setPreferences] = useState<string[]>([]);

  useEffect(() => {
    loadTrips();
  }, []);

  async function loadTrips() {
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) return;
      const data = await res.json();
      setTrips(data);
    } catch {
      // ignore fetch errors
    }
  }

  async function createTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!destination || !startDate || !endDate) return;
    setLoading(true);
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination, startDate, endDate, preferences }),
    });
    const trip = await res.json();
    setTrips([trip, ...trips]);
    setSelectedTrip(trip);
    setCreating(false);
    setLoading(false);
    setDestination("");
    setStartDate("");
    setEndDate("");
    setPreferences([]);
  }

  async function deleteTrip(id: string) {
    await fetch(`/api/trips/${id}`, { method: "DELETE" });
    setTrips(trips.filter((t) => t.id !== id));
    if (selectedTrip?.id === id) setSelectedTrip(null);
  }

  function togglePreference(pref: string) {
    setPreferences((prev) =>
      prev.includes(pref) ? prev.filter((p) => p !== pref) : [...prev, pref]
    );
  }

  const dayActivities = selectedTrip?.days.find((d) => d.dayNumber === selectedDay)?.activities || [];
  const mapPlaces = dayActivities
    .filter((a) => a.lat && a.lng)
    .map((a) => ({
      id: a.id,
      name: a.placeName,
      lat: a.lat,
      lng: a.lng,
      category: "other",
      notes: a.notes,
      tags: [],
    }));

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CalendarDays size={24} className="text-primary" />
          <h1 className="text-2xl font-bold">Gezi Planı</h1>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover"
        >
          <Plus size={16} />
          Yeni Plan
        </button>
      </div>

      {creating && (
        <form
          onSubmit={createTrip}
          className="bg-card border border-card-border rounded-xl p-4"
        >
          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium mb-1">Şehir</label>
              <input
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="ör: Prague"
                className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Başlangıç
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Bitiş</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-sm"
                required
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Tercihler</label>
            <div className="flex flex-wrap gap-2">
              {TRIP_PREFERENCES.map((pref) => (
                <button
                  key={pref}
                  type="button"
                  onClick={() => togglePreference(pref)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                    preferences.includes(pref)
                      ? "bg-primary text-white"
                      : "bg-background border border-card-border"
                  }`}
                >
                  {pref}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? "AI plan oluşturuyor..." : "Plan Oluştur"}
          </button>
        </form>
      )}

      <div className="flex-1 grid lg:grid-cols-[300px_1fr] gap-4 min-h-0">
        <div className="bg-card border border-card-border rounded-xl p-4 overflow-y-auto">
          <h3 className="font-bold text-sm mb-3">Planlarım</h3>

          {trips.length === 0 && (
            <p className="text-sm text-muted text-center py-8">
              Henüz plan yok. Yeni bir plan oluştur!
            </p>
          )}

          <div className="space-y-2">
            {trips.map((trip) => (
              <div
                key={trip.id}
                onClick={() => {
                  setSelectedTrip(trip);
                  setSelectedDay(1);
                }}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedTrip?.id === trip.id
                    ? "border-primary bg-primary-light"
                    : "border-card-border bg-background hover:border-primary/50"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-medium text-sm">{trip.destination}</h4>
                    <p className="text-xs text-muted mt-0.5">
                      {trip.startDate} → {trip.endDate}
                    </p>
                    <p className="text-xs text-muted">
                      {trip.days.length} gün
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTrip(trip.id);
                    }}
                    className="text-muted hover:text-danger p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4 min-h-0">
          {selectedTrip ? (
            <>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {selectedTrip.days.map((day) => (
                  <button
                    key={day.dayNumber}
                    onClick={() => setSelectedDay(day.dayNumber)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${
                      selectedDay === day.dayNumber
                        ? "bg-primary text-white"
                        : "bg-card border border-card-border"
                    }`}
                  >
                    Gün {day.dayNumber}
                    <span className="block text-[10px] opacity-80">
                      {day.date}
                    </span>
                  </button>
                ))}
              </div>

              <div className="grid lg:grid-cols-2 gap-4 flex-1 min-h-0">
                <div className="bg-card border border-card-border rounded-xl p-4 overflow-y-auto">
                  <h3 className="font-bold text-sm mb-3">Program</h3>
                  <div className="space-y-3">
                    {dayActivities.map((activity, i) => (
                      <div
                        key={activity.id}
                        className="flex gap-3 p-3 bg-background rounded-lg border border-card-border"
                      >
                        <div className="flex flex-col items-center">
                          <div className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-xs font-bold">
                            {i + 1}
                          </div>
                          {i < dayActivities.length - 1 && (
                            <div className="w-0.5 flex-1 bg-card-border mt-1" />
                          )}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Clock size={12} className="text-muted" />
                            <span className="text-xs text-muted">
                              {activity.timeSlot}
                            </span>
                          </div>
                          <h4 className="font-medium text-sm mt-1">
                            {activity.placeName}
                          </h4>
                          {activity.notes && (
                            <p className="text-xs text-muted mt-1">
                              {activity.notes}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="min-h-[300px]">
                  <MapView places={mapPlaces} />
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-card border border-card-border rounded-xl">
              <div className="text-center">
                <CalendarDays size={48} className="text-muted mx-auto mb-3" />
                <p className="text-muted">
                  Bir plan seç veya yeni plan oluştur
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
