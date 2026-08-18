"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { CalendarDays, Plus, Trash2, Loader2, Clock, ChevronRight, Sparkles } from "lucide-react";
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
      // ignore
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
      category: "attraction",
      notes: a.notes,
      tags: [],
    }));

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl gradient-warm flex items-center justify-center">
            <CalendarDays size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Gezi Planlari</h1>
            <p className="text-xs text-muted">AI ile gun bazli plan olustur</p>
          </div>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="flex items-center gap-2 px-5 py-2.5 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          Yeni Plan
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="mx-6 mb-6 bg-card border border-card-border rounded-3xl p-6 animate-slide-up">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={16} className="text-primary" />
            <h3 className="font-bold text-sm">AI Trip Planner</h3>
          </div>

          <form onSubmit={createTrip} className="space-y-4">
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Sehir</label>
                <input
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="or: Prague"
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Baslangic</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Bitis</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full mt-1 px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Tercihler</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {TRIP_PREFERENCES.map((pref) => (
                  <button
                    key={pref}
                    type="button"
                    onClick={() => togglePreference(pref)}
                    className={`px-4 py-2 rounded-2xl text-xs font-medium transition-all ${
                      preferences.includes(pref)
                        ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                        : "bg-surface border border-card-border hover:border-primary/30"
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
              className="w-full px-6 py-3.5 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2 transition-opacity"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {loading ? "AI plan olusturuyor..." : "Plan Olustur"}
            </button>
          </form>
        </div>
      )}

      {/* Content */}
      <div className="px-6 grid lg:grid-cols-[340px_1fr] gap-6 pb-24">
        {/* Trip list */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Planlarim</p>

          {trips.length === 0 && (
            <div className="text-center py-16 bg-card border border-card-border rounded-3xl">
              <div className="w-14 h-14 rounded-3xl gradient-warm flex items-center justify-center mx-auto mb-3 opacity-50">
                <CalendarDays size={24} className="text-white" />
              </div>
              <p className="text-sm text-muted">Henuz plan yok</p>
              <p className="text-xs text-muted mt-1">Yeni bir plan olustur!</p>
            </div>
          )}

          {trips.map((trip) => (
            <div
              key={trip.id}
              onClick={() => { setSelectedTrip(trip); setSelectedDay(1); }}
              className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                selectedTrip?.id === trip.id
                  ? "border-primary bg-primary-light shadow-[var(--shadow-md)]"
                  : "border-card-border bg-card hover:border-primary/30 hover:shadow-[var(--shadow-sm)]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-sm">{trip.destination}</h4>
                  <p className="text-xs text-muted mt-0.5">
                    {trip.startDate} → {trip.endDate}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="px-2 py-0.5 bg-surface rounded-lg text-[10px] font-medium">
                      {trip.days.length} gun
                    </span>
                    {trip.preferences?.slice(0, 2).map((p) => (
                      <span key={p} className="px-2 py-0.5 bg-primary-light text-primary rounded-lg text-[10px] font-medium">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTrip(trip.id); }}
                    className="text-muted hover:text-danger p-1.5 rounded-xl hover:bg-surface transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                  <ChevronRight size={16} className="text-muted" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Trip detail */}
        <div>
          {selectedTrip ? (
            <div className="space-y-4">
              {/* Day tabs */}
              <div className="flex gap-2 overflow-x-auto hide-scrollbar">
                {selectedTrip.days.map((day) => (
                  <button
                    key={day.dayNumber}
                    onClick={() => setSelectedDay(day.dayNumber)}
                    className={`shrink-0 px-5 py-3 rounded-2xl text-sm font-medium transition-all ${
                      selectedDay === day.dayNumber
                        ? "gradient-primary text-white shadow-[var(--shadow-md)]"
                        : "bg-card border border-card-border hover:border-primary/30"
                    }`}
                  >
                    Gun {day.dayNumber}
                    <span className="block text-[10px] opacity-80">{day.date}</span>
                  </button>
                ))}
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                {/* Activities */}
                <div className="bg-card border border-card-border rounded-3xl p-5">
                  <h3 className="font-bold text-sm mb-4">Program</h3>
                  <div className="space-y-4">
                    {dayActivities.map((activity, i) => (
                      <div key={activity.id} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className="w-9 h-9 rounded-xl gradient-primary text-white flex items-center justify-center text-xs font-bold">
                            {i + 1}
                          </div>
                          {i < dayActivities.length - 1 && (
                            <div className="w-0.5 flex-1 bg-card-border mt-2" />
                          )}
                        </div>
                        <div className="flex-1 pb-4">
                          <div className="flex items-center gap-2 text-muted">
                            <Clock size={12} />
                            <span className="text-xs">{activity.timeSlot}</span>
                          </div>
                          <h4 className="font-semibold text-sm mt-1">{activity.placeName}</h4>
                          {activity.notes && (
                            <p className="text-xs text-muted mt-1">{activity.notes}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {dayActivities.length === 0 && (
                      <p className="text-sm text-muted text-center py-8">Bu gun icin aktivite yok</p>
                    )}
                  </div>
                </div>

                {/* Map */}
                <div className="h-[400px] rounded-3xl overflow-hidden border border-card-border shadow-[var(--shadow-md)]">
                  <MapView places={mapPlaces} />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[400px] bg-card border border-card-border rounded-3xl">
              <div className="text-center">
                <div className="w-16 h-16 rounded-3xl gradient-warm flex items-center justify-center mx-auto mb-4 opacity-50">
                  <CalendarDays size={28} className="text-white" />
                </div>
                <p className="text-muted text-sm">Bir plan sec veya yeni plan olustur</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
