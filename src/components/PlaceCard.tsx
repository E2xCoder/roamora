"use client";

import { MapPin, Trash2, ExternalLink } from "lucide-react";

interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  notes: string;
  address?: string;
  tags: string[];
  source?: string;
  imageUrl?: string;
}

interface PlaceCardProps {
  place: Place;
  categoryIcon: string;
  onDelete: (id: string) => void;
}

const SOURCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  tiktok: { bg: "bg-black/80", text: "text-white", label: "TikTok" },
  instagram: { bg: "gradient-warm", text: "text-white", label: "Instagram" },
  google: { bg: "bg-blue-500", text: "text-white", label: "Google" },
  overpass: { bg: "gradient-nature", text: "text-white", label: "OSM" },
  manual: { bg: "bg-muted", text: "text-white", label: "Manuel" },
  social: { bg: "gradient-cool", text: "text-white", label: "Social" },
};

export default function PlaceCard({ place, categoryIcon, onDelete }: PlaceCardProps) {
  const source = place.source || "manual";
  const sourceStyle = SOURCE_STYLES[source] || SOURCE_STYLES.manual;

  return (
    <div className="group relative bg-card rounded-2xl border border-card-border hover:border-primary/30 hover:shadow-[var(--shadow-md)] transition-all overflow-hidden">
      <div className="flex gap-3 p-3">
        {/* Thumbnail */}
        {place.imageUrl ? (
          <div className="relative w-20 h-20 rounded-xl overflow-hidden shrink-0">
            <img
              src={place.imageUrl}
              alt=""
              className="w-full h-full object-cover"
            />
            <div className={`absolute bottom-1 left-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold ${sourceStyle.bg} ${sourceStyle.text}`}>
              {sourceStyle.label}
            </div>
          </div>
        ) : (
          <div className="w-20 h-20 rounded-xl bg-surface flex items-center justify-center shrink-0 text-2xl">
            {categoryIcon}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-sm leading-tight line-clamp-2">{place.name}</h3>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(place.id); }}
                className="text-muted hover:text-danger p-1 opacity-0 group-hover:opacity-100 transition-all shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {place.address && (
              <p className="text-[11px] text-muted truncate mt-0.5">{place.address}</p>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-light text-primary text-[10px] rounded-lg font-medium">
              {categoryIcon} {place.category}
            </span>
            {source !== "manual" && source !== "overpass" && (
              <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold ${sourceStyle.bg} ${sourceStyle.text}`}>
                {sourceStyle.label}
              </span>
            )}
          </div>
        </div>
      </div>

      {place.notes && (
        <div className="px-3 pb-3 -mt-1">
          <p className="text-[11px] text-muted line-clamp-2">{place.notes}</p>
        </div>
      )}
    </div>
  );
}
