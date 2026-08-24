"use client";

import { useState } from "react";
import { Mountain, Search, Loader2, ExternalLink, MapPin } from "lucide-react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";

interface WaymarkedTrail {
  id: number;
  name: string;
  group: string;
  symbol_description: string;
  mapped_length: number;
  official_length: number;
}

interface TrailSearchResult {
  results?: WaymarkedTrail[];
  total?: number;
}

const GROUP_LABELS: Record<string, string> = {
  INT: "Uluslararası",
  NAT: "Ulusal",
  REG: "Bölgesel",
  LOC: "Yerel",
};

const POPULAR_TRAILS = [
  { name: "Jakobsweg", emoji: "🇩🇪" },
  { name: "Via Alpina", emoji: "🏔️" },
  { name: "Camino de Santiago", emoji: "🇪🇸" },
  { name: "E1", emoji: "🇪🇺" },
  { name: "E5", emoji: "🇪🇺" },
  { name: "Lycian Way", emoji: "🇹🇷" },
  { name: "GR20", emoji: "🇫🇷" },
  { name: "Tour du Mont Blanc", emoji: "🏔️" },
  { name: "West Highland Way", emoji: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  { name: "Kungsleden", emoji: "🇸🇪" },
  { name: "Alta Via", emoji: "🇮🇹" },
  { name: "Laugavegur", emoji: "🇮🇸" },
];

export default function HikingPage() {
  const [query, setQuery] = useState("");
  const [trails, setTrails] = useState<WaymarkedTrail[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);

  async function searchTrails(searchQuery?: string) {
    const q = searchQuery || query;
    if (!q) return;
    setLoading(true);
    if (searchQuery) setQuery(searchQuery);
    const res = await fetch(`/api/hiking?source=waymarked&q=${encodeURIComponent(q)}`);
    const data: TrailSearchResult = await res.json();
    const results = data.results ?? [];
    setTrails(results);
    setTotal(typeof data.total === "number" ? data.total : results.length);
    setLoading(false);
  }

  function formatDistance(meters: number) {
    if (!meters) return "—";
    return `${(meters / 1000).toFixed(1)} km`;
  }

  return (
    <div className="min-h-screen pb-24">
      <div className="px-6 pt-6 pb-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-2xl bg-primary flex items-center justify-center">
            <Mountain size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Doğa Yürüyüşü</h1>
            <p className="text-xs text-muted-fg">Avrupa geneli hiking rotaları — Waymarked Trails + OSM</p>
          </div>
        </div>
      </div>

      <div className="px-6 mb-6 max-w-6xl mx-auto">
        <div className="flex items-center bg-card border border-card-border rounded-2xl overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all">
          <Search size={16} className="ml-4 text-muted shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchTrails()}
            placeholder="Rota ara (or: Jakobsweg, E5, Camino...)"
            className="flex-1 px-3 py-3.5 bg-transparent text-sm focus:outline-none"
          />
          <div className="m-1.5">
            <Button onClick={() => searchTrails()} disabled={loading || !query} variant="primary">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 mb-6 max-w-6xl mx-auto">
        <p className="text-xs font-semibold text-muted-fg uppercase tracking-wider mb-3">Popüler Rotalar</p>
        <div className="flex flex-wrap gap-2">
          {POPULAR_TRAILS.map((trail) => (
            <button
              key={trail.name}
              onClick={() => searchTrails(trail.name)}
              className="flex items-center gap-2 px-4 py-2.5 bg-card border border-card-border rounded-2xl text-sm font-medium hover:border-primary/30 hover:shadow-[var(--shadow-sm)] transition-all"
            >
              <span>{trail.emoji}</span>
              {trail.name}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 max-w-6xl mx-auto">
        {trails.length > 0 && (
          <p className="text-xs text-muted-fg mb-4">
            <span className="font-semibold text-foreground">{total}</span> sonuç bulundu
          </p>
        )}

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {trails.map((trail) => (
            <Card key={trail.id} interactive padding="md">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-sm leading-tight">{trail.name || "İsimsiz rota"}</h3>
                  {trail.group && <p className="text-xs text-muted-fg mt-1">{GROUP_LABELS[trail.group] ?? trail.group}</p>}
                </div>
                <a
                  href={`https://hiking.waymarkedtrails.org/#route?id=${trail.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-xl bg-surface text-muted hover:text-primary hover:bg-primary-light transition-colors"
                  aria-label={`${trail.name} — Waymarked Trails'te aç`}
                >
                  <ExternalLink size={14} />
                </a>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {trail.mapped_length > 0 ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface rounded-xl">
                    <MapPin size={12} className="text-primary" />
                    <span className="text-xs font-medium">{formatDistance(trail.mapped_length)}</span>
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-fg">Bu aramada uzunluk bilgisi yok</span>
                )}
                {trail.official_length > 0 && (
                  <div className="text-xs text-muted-fg">Resmi: {formatDistance(trail.official_length)}</div>
                )}
              </div>

              {trail.symbol_description && <p className="text-xs text-muted-fg mt-3 line-clamp-2">{trail.symbol_description}</p>}
            </Card>
          ))}
        </div>

        {!loading && trails.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-20 h-20 rounded-3xl bg-primary-light flex items-center justify-center mb-4">
              <Mountain size={32} className="text-primary" />
            </div>
            <p className="text-muted-fg text-sm text-center">Avrupa genelinde binlerce Wanderweg ve hiking rotası ara</p>
            <p className="text-[11px] text-muted mt-1">Waymarked Trails + OpenStreetMap</p>
          </div>
        )}
      </div>
    </div>
  );
}
