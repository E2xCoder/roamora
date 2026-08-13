"use client";

import { useState } from "react";
import { Mountain, Search, Loader2, ExternalLink, MapPin } from "lucide-react";

interface WaymarkedTrail {
  id: number;
  name: string;
  group: string;
  symbol_description: string;
  mapped_length: number;
  official_length: number;
}

interface TrailSearchResult {
  results: WaymarkedTrail[];
  total: number;
}

export default function HikingPage() {
  const [query, setQuery] = useState("");
  const [trails, setTrails] = useState<WaymarkedTrail[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);

  async function searchTrails() {
    if (!query) return;
    setLoading(true);
    const res = await fetch(
      `/api/hiking?source=waymarked&q=${encodeURIComponent(query)}`
    );
    const data: TrailSearchResult = await res.json();
    setTrails(data.results || []);
    setTotal(data.total || 0);
    setLoading(false);
  }

  async function searchPopular(term: string) {
    setQuery(term);
    setLoading(true);
    const res = await fetch(
      `/api/hiking?source=waymarked&q=${encodeURIComponent(term)}`
    );
    const data: TrailSearchResult = await res.json();
    setTrails(data.results || []);
    setTotal(data.total || 0);
    setLoading(false);
  }

  function formatDistance(meters: number) {
    if (!meters) return "—";
    return `${(meters / 1000).toFixed(1)} km`;
  }

  const popularSearches = [
    "Jakobsweg",
    "Via Alpina",
    "Camino de Santiago",
    "E1",
    "E5",
    "Lycian Way",
    "GR20",
    "Tour du Mont Blanc",
    "West Highland Way",
    "Kungsleden",
    "Alta Via",
    "Laugavegur",
  ];

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Mountain size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Wanderwege & Hiking</h1>
      </div>

      <div className="bg-card border border-card-border rounded-xl p-4">
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchTrails()}
            placeholder="Rota ara (ör: Jakobsweg, E5, Camino...)"
            className="flex-1 px-4 py-2.5 rounded-lg border border-card-border bg-background text-sm"
          />
          <button
            onClick={searchTrails}
            disabled={loading}
            className="px-6 py-2.5 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Search size={16} />
            )}
            Ara
          </button>
        </div>

        <div>
          <p className="text-xs text-muted mb-2">Popüler Rotalar:</p>
          <div className="flex flex-wrap gap-2">
            {popularSearches.map((term) => (
              <button
                key={term}
                onClick={() => searchPopular(term)}
                className="px-3 py-1.5 bg-background border border-card-border rounded-full text-xs hover:border-primary/50 transition-colors"
              >
                {term}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {trails.length > 0 && (
          <p className="text-sm text-muted mb-3">
            {total} sonuç bulundu
          </p>
        )}

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {trails.map((trail) => (
            <div
              key={trail.id}
              className="bg-card border border-card-border rounded-xl p-4 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-bold text-sm">{trail.name || "Unnamed Trail"}</h3>
                  {trail.group && (
                    <p className="text-xs text-muted mt-0.5">{trail.group}</p>
                  )}
                </div>
                <a
                  href={`https://hiking.waymarkedtrails.org/#route?id=${trail.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary-hover"
                >
                  <ExternalLink size={14} />
                </a>
              </div>

              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1 text-xs text-muted">
                  <MapPin size={12} />
                  {formatDistance(trail.mapped_length)}
                </div>
                {trail.official_length > 0 && (
                  <div className="text-xs text-muted">
                    Resmi: {formatDistance(trail.official_length)}
                  </div>
                )}
              </div>

              {trail.symbol_description && (
                <p className="text-xs text-muted mt-2 line-clamp-2">
                  {trail.symbol_description}
                </p>
              )}
            </div>
          ))}
        </div>

        {!loading && trails.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Mountain size={64} className="text-muted mb-4" />
            <p className="text-muted text-center">
              Avrupa genelinde binlerce Wanderweg ve hiking rotası ara.
              <br />
              <span className="text-xs">
                Veriler: Waymarked Trails + OpenStreetMap
              </span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
