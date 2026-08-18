"use client";

import { useState } from "react";
import { Link2, Loader2, Check, X, Sparkles, ArrowRight } from "lucide-react";
import { CATEGORIES } from "@/types";

interface ExtractedData {
  title: string;
  description: string;
  thumbnailUrl?: string;
  thumbnailPath?: string;
  platform: string;
  placeName?: string;
  lat?: number;
  lng?: number;
  category?: string;
  sourceUrl: string;
}

interface ExtractPanelProps {
  onPlaceSaved: () => void;
}

export default function ExtractPanel({ onPlaceSaved }: ExtractPanelProps) {
  const [urlInput, setUrlInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editLat, setEditLat] = useState("");
  const [editLng, setEditLng] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleExtract() {
    if (!urlInput.trim()) return;
    setExtracting(true);
    setExtracted(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      if (!res.ok) throw new Error("Extract failed");
      const data = await res.json();
      setExtracted(data.extracted);
      setEditName(data.extracted.placeName || data.extracted.title || "");
      setEditCategory(data.extracted.category || "attraction");
      setEditLat(data.extracted.lat?.toString() || "");
      setEditLng(data.extracted.lng?.toString() || "");
    } catch {
      alert("Link'ten veri cekilemedi. URL'yi kontrol et.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave() {
    if (!editName || !editLat || !editLng) return;
    setSaving(true);

    try {
      const res = await fetch("/api/extract", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          lat: parseFloat(editLat),
          lng: parseFloat(editLng),
          category: editCategory,
          notes: extracted?.description?.slice(0, 200) || "",
          sourceUrl: extracted?.sourceUrl,
          thumbnailPath: extracted?.thumbnailPath,
          thumbnailUrl: extracted?.thumbnailUrl,
          platform: extracted?.platform,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      setExtracted(null);
      setUrlInput("");
      onPlaceSaved();
    } catch {
      alert("Kaydetme basarisiz.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4">
      {/* Hero section */}
      <div className="text-center mb-6">
        <div className="w-14 h-14 rounded-3xl gradient-primary flex items-center justify-center mx-auto mb-3">
          <Sparkles size={24} className="text-white" />
        </div>
        <h3 className="font-bold text-base">Sosyal Medyadan Ekle</h3>
        <p className="text-xs text-muted mt-1">
          TikTok veya Instagram linkini yapistir, yer bilgisi otomatik cekilsin
        </p>
      </div>

      {/* URL input */}
      <div className="relative mb-4">
        <div className="flex items-center bg-card border-2 border-card-border rounded-2xl focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all overflow-hidden">
          <Link2 size={16} className="ml-4 text-muted shrink-0" />
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExtract()}
            placeholder="https://tiktok.com/... veya instagram.com/..."
            className="flex-1 px-3 py-3.5 bg-transparent text-sm focus:outline-none"
          />
          <button
            onClick={handleExtract}
            disabled={extracting || !urlInput.trim()}
            className="m-1.5 px-4 py-2 gradient-primary text-white rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 flex items-center gap-2 shrink-0 transition-opacity"
          >
            {extracting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArrowRight size={14} />
            )}
            {extracting ? "Cekiliyor..." : "Cek"}
          </button>
        </div>
      </div>

      {/* Extracting animation */}
      {extracting && (
        <div className="flex flex-col items-center py-8 animate-fade-in">
          <div className="w-12 h-12 rounded-2xl gradient-primary flex items-center justify-center animate-pulse-glow mb-3">
            <Loader2 size={20} className="text-white animate-spin" />
          </div>
          <p className="text-sm font-medium">Icerik analiz ediliyor...</p>
          <p className="text-xs text-muted mt-1">yt-dlp + AI ile yer bilgisi cikariliyor</p>
        </div>
      )}

      {/* Extracted result */}
      {extracted && !extracting && (
        <div className="animate-slide-up">
          <div className="bg-card border border-card-border rounded-2xl overflow-hidden">
            {/* Thumbnail */}
            {(extracted.thumbnailUrl || extracted.thumbnailPath) && (
              <div className="relative h-40 bg-surface">
                <img
                  src={extracted.thumbnailPath || extracted.thumbnailUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                <div className="absolute bottom-3 left-3 right-3">
                  <span className={`px-2 py-1 rounded-lg text-[10px] font-bold ${
                    extracted.platform === "tiktok" ? "bg-black/80 text-white" : "gradient-warm text-white"
                  }`}>
                    {extracted.platform === "tiktok" ? "TikTok" : extracted.platform === "instagram" ? "Instagram" : extracted.platform}
                  </span>
                </div>
              </div>
            )}

            <div className="p-4 space-y-3">
              {/* Place name */}
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Yer Adi</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm font-medium focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary-glow"
                />
              </div>

              {/* Category */}
              <div>
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Kategori</label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Coordinates */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Lat</label>
                  <input
                    type="text"
                    value={editLat}
                    onChange={(e) => setEditLat(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Lng</label>
                  <input
                    type="text"
                    value={editLng}
                    onChange={(e) => setEditLng(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
              </div>

              {/* Description preview */}
              {extracted.description && (
                <p className="text-[11px] text-muted line-clamp-3 bg-surface rounded-xl p-3">
                  {extracted.description}
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving || !editName || !editLat || !editLng}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 gradient-primary text-white rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Kaydet
                </button>
                <button
                  onClick={() => { setExtracted(null); setUrlInput(""); }}
                  className="px-4 py-3 bg-surface border border-card-border rounded-xl text-sm hover:bg-card-hover transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tips */}
      {!extracted && !extracting && (
        <div className="space-y-2 mt-2">
          <div className="flex items-center gap-3 p-3 bg-surface rounded-xl">
            <span className="text-lg">🎵</span>
            <div>
              <p className="text-xs font-medium">TikTok</p>
              <p className="text-[10px] text-muted">Video linkini paylas butonundan kopyala</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-surface rounded-xl">
            <span className="text-lg">📸</span>
            <div>
              <p className="text-xs font-medium">Instagram</p>
              <p className="text-[10px] text-muted">Reel veya post linkini kopyala</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
