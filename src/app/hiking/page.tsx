"use client";

import { useState } from "react";
import { Mountain, Search, Loader2, ExternalLink, MapPin, ArrowRight } from "lucide-react";

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

/** Waymarked's network codes, which are meaningless on their own. */
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
    const res = await fetch(
      `/api/hiking?source=waymarked&q=${encodeURIComponent(q)}`
    );
    const data: TrailSearchResult = await res.json();
    const results = data.results ?? [];
    setTrails(results);
    // Waymarked omits `total` on some responses; falling back to 0 produced
    // "0 sonuc bulundu" printed directly above a list of results.
    setTotal(typeof data.total === "number" ? data.total : results.length);
    setLoading(false);
  }

  function formatDistance(meters: number) {
    if (!meters) return "—";
    return `${(meters / 1000).toFixed(1)} km`;
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-2xl gradient-nature flex items-center justify-center">
            <Mountain size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Wanderwege & Hiking</h1>
            <p className="text-xs text-muted">Avrupa geneli hiking rotalari</p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-6 mb-6">
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
          <button
            onClick={() => searchTrails()}
            disabled={loading || !query}
            className="m-1.5 px-5 py-2.5 gradient-nature text-white rounded-xl text-sm font-semibold disabled:opacity-40 flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          </button>
        </div>
      </div>

      {/* Popular trails */}
      <div className="px-6 mb-6">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Populer Rotalar</p>
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

      {/* Results */}
      <div className="px-6 pb-24">
        {trails.length > 0 && (
          <p className="text-xs text-muted mb-4">
            <span className="font-semibold text-foreground">{total}</span> sonuc bulundu
          </p>
        )}

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {trails.map((trail) => (
            <div
              key={trail.id}
              className="bg-card border border-card-border rounded-3xl p-5 hover:shadow-[var(--shadow-md)] hover:border-primary/30 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-sm leading-tight">
                    {trail.name || "İsimsiz rota"}
                  </h3>
                  {trail.group && (
                    <p className="text-xs text-muted mt-1">
                      {GROUP_LABELS[trail.group] ?? trail.group}
                    </p>
                  )}
                </div>
                <a
                  href={`https://hiking.waymarkedtrails.org/#route?id=${trail.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-xl bg-surface text-muted hover:text-primary hover:bg-primary-light transition-colors"
                >
                  <ExternalLink size={14} />
                </a>
              </div>

              <div className="flex items-center gap-3">
                {trail.mapped_length > 0 ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface rounded-xl">
                    <MapPin size={12} className="text-primary" />
                    <span className="text-xs font-medium">
                      {formatDistance(trail.mapped_length)}
                    </span>
                  </div>
                ) : (
                  // Waymarked's search endpoint omits lengths; say so rather
                  // than showing a bare dash that reads like a zero.
                  <span className="text-[11px] text-muted">
                    Uzunluk bu listede yok — detayda görebilirsin
                  </span>
                )}
                {trail.official_length > 0 && (
                  <div className="text-xs text-muted">
                    Resmi: {formatDistance(trail.official_length)}
                  </div>
                )}
              </div>

              {trail.symbol_description && (
                <p className="text-xs text-muted mt-3 line-clamp-2">{trail.symbol_description}</p>
              )}
            </div>
          ))}
        </div>

        {!loading && trails.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-20 h-20 rounded-3xl gradient-nature flex items-center justify-center mb-4 opacity-40">
              <Mountain size={36} className="text-white" />
            </div>
            <p className="text-muted text-sm text-center">
              Avrupa genelinde binlerce Wanderweg ve hiking rotasi ara
            </p>
            <p className="text-[11px] text-muted mt-1">
              Waymarked Trails + OpenStreetMap
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
