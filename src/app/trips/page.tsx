"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays, Trash2, ChevronRight, Sparkles, MapPin } from "lucide-react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Skeleton from "@/components/ui/Skeleton";

interface TripSummary {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  preferences: string[];
  days: Array<{ dayNumber: number }>;
}

export default function TripsPage() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/trips")
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.error ?? `Planlar yüklenemedi (${res.status})`);
          return;
        }
        setTrips(await res.json());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı"));
  }, []);

  async function deleteTrip(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/trips/${id}`, { method: "DELETE" });
    setTrips((prev) => prev?.filter((t) => t.id !== id) ?? null);
  }

  return (
    <div className="min-h-screen px-6 py-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Gezilerim</h1>
          <p className="text-sm text-muted-fg mt-0.5">Otonom motorun senin için oluşturduğu gerçek geziler</p>
        </div>
        <Link href="/">
          <Button variant="accent">
            <Sparkles size={16} />
            Yeni Gezi
          </Button>
        </Link>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-danger-light text-danger text-sm mb-4">{error}</div>
      )}

      {trips === null && !error && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      )}

      {trips?.length === 0 && (
        <Card padding="lg" className="text-center py-16">
          <div className="w-16 h-16 rounded-3xl bg-primary-light flex items-center justify-center mx-auto mb-4">
            <MapPin size={26} className="text-primary" />
          </div>
          <p className="font-semibold text-base">Henüz bir gezin yok</p>
          <p className="text-sm text-muted-fg mt-1.5 max-w-sm mx-auto">
            Bir hedef ve tarih söyle, otonom motor gerçek yer araştırması yaparak senin için ilk gezini oluştursun.
          </p>
          <Link href="/" className="inline-block mt-5">
            <Button variant="accent">
              <Sparkles size={16} />
              İlk Gezini Oluştur
            </Button>
          </Link>
        </Card>
      )}

      {trips && trips.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {trips.map((trip) => (
            <Link key={trip.id} href={`/trips/${trip.id}`}>
              <Card interactive padding="md" className="h-full relative group">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{trip.destination}</h3>
                    <p className="text-xs text-muted-fg mt-0.5">{trip.startDate} → {trip.endDate}</p>
                  </div>
                  <ChevronRight size={16} className="text-muted shrink-0 mt-0.5" />
                </div>
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  <span className="px-2 py-0.5 bg-surface rounded-lg text-[10px] font-medium flex items-center gap-1">
                    <CalendarDays size={10} /> {trip.days.length} gün
                  </span>
                  {trip.preferences?.slice(0, 2).map((p) => (
                    <span key={p} className="px-2 py-0.5 bg-primary-light text-primary rounded-lg text-[10px] font-medium">{p}</span>
                  ))}
                </div>
                <button
                  onClick={(e) => deleteTrip(trip.id, e)}
                  aria-label={`${trip.destination} gezisini sil`}
                  className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-muted hover:text-danger p-1.5 rounded-xl hover:bg-surface transition-all"
                >
                  <Trash2 size={13} />
                </button>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
