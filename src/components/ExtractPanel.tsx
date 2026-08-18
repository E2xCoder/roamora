"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Link2, Loader2, Check, X, Sparkles, ArrowRight, AlertTriangle, Merge,
} from "lucide-react";
import { CATEGORIES } from "@/lib/taxonomy";

interface Stage {
  stage: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

interface Duplicate {
  placeId: string;
  name: string;
  distanceMeters: number;
  reason: string;
}

interface Proposal {
  platform: string;
  sourceUrl: string;
  normalizedUrl: string;
  title?: string;
  description?: string;
  creator?: string;
  thumbnailUrl?: string;
  externalId?: string;
  placeName?: string;
  lat?: number;
  lng?: number;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  category: string;
  locationSource?: string;
  locationConfidence: number;
  alternatives: Array<{ name: string; lat: number; lng: number; label: string }>;
  duplicate?: Duplicate;
  autoSaveEligible: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  validate: "Bağlantı doğrulanıyor",
  detect: "Kaynak tespit ediliyor",
  metadata: "Üstveri okunuyor",
  media: "Görsel alınıyor",
  location: "Metinden yer aranıyor",
  "location-ai": "AI ile yer çıkarımı",
  geocode: "Koordinat bulunuyor",
  classify: "Kategori belirleniyor",
  dedupe: "Tekrar kontrolü",
};

interface ExtractPanelProps {
  onPlaceSaved: () => void;
}

export default function ExtractPanel({ onPlaceSaved }: ExtractPanelProps) {
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [saved, setSaved] = useState<{ id?: string; name: string; merged: boolean } | null>(null);

  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("attraction");
  const [editLat, setEditLat] = useState("");
  const [editLng, setEditLng] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setProposal(null);
    setStages([]);
    setFailure(null);
    setSaved(null);
  }

  async function handleAnalyze() {
    if (!urlInput.trim()) return;
    setBusy(true);
    reset();

    try {
      const res = await fetch("/api/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      const body = await res.json().catch(() => null);

      setStages(body?.stages ?? []);

      if (!res.ok) {
        setFailure(body?.error ?? `İstek başarısız (${res.status})`);
        return;
      }

      const p: Proposal = body.proposal;
      setProposal(p);
      setEditName(p.placeName ?? p.title ?? "");
      setEditCategory(p.category);
      setEditLat(p.lat?.toString() ?? "");
      setEditLng(p.lng?.toString() ?? "");
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(mergeIntoPlaceId?: string) {
    if (!proposal) return;
    setSaving(true);

    try {
      const res = await fetch("/api/import/url", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...proposal,
          name: editName,
          category: editCategory,
          lat: Number(editLat),
          lng: Number(editLng),
          mergeIntoPlaceId,
        }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setFailure(body?.error ?? `Kaydedilemedi (${res.status})`);
        return;
      }

      setSaved({
        id: body.merged ? body.placeId : body.place?.id,
        name: body.merged ? body.placeName : body.place?.name,
        merged: Boolean(body.merged),
      });
      setProposal(null);
      setUrlInput("");
      onPlaceSaved();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setSaving(false);
    }
  }

  const confidence = proposal?.locationConfidence ?? 0;
  const confidencePct = Math.round(confidence * 100);
  const confidenceColor =
    confidence >= 0.85 ? "var(--success)" : confidence >= 0.5 ? "var(--secondary)" : "var(--danger)";

  return (
    <div className="p-4">
      {/* Hero */}
      {!proposal && !saved && (
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-3xl gradient-primary flex items-center justify-center mx-auto mb-3">
            <Sparkles size={24} className="text-white" />
          </div>
          <h3 className="font-bold text-base">Bağlantıdan yer ekle</h3>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            TikTok, Instagram, YouTube, Google Maps, Komoot ya da herhangi bir
            site bağlantısı yapıştır.
          </p>
        </div>
      )}

      {/* URL input */}
      <div className="flex items-center bg-card border-2 border-card-border rounded-2xl overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all mb-4">
        <Link2 size={16} className="ml-4 text-muted shrink-0" />
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
          placeholder="https://..."
          className="flex-1 min-w-0 px-3 py-3.5 bg-transparent text-sm focus:outline-none"
        />
        <button
          onClick={handleAnalyze}
          disabled={busy || !urlInput.trim()}
          className="m-1.5 px-4 py-2 gradient-primary text-white rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 flex items-center gap-2 shrink-0 transition-opacity"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          {busy ? "Analiz" : "Çek"}
        </button>
      </div>

      {/* Saved confirmation */}
      {saved && (
        <div className="rounded-2xl border border-success/25 bg-success/10 p-4 mb-4 animate-slide-up">
          <div className="flex items-start gap-2.5">
            <Check size={15} className="text-success shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {saved.merged ? "Mevcut yere eklendi" : "Kaydedildi"}
              </p>
              <p className="text-xs text-muted mt-0.5">
                {saved.merged
                  ? `Kaynak "${saved.name}" kaydına iliştirildi.`
                  : saved.name}
              </p>
              {saved.id && (
                <Link
                  href={`/place/${saved.id}`}
                  className="inline-block mt-2 text-xs font-semibold text-primary"
                >
                  Yeri aç →
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pipeline stages */}
      {stages.length > 0 && !busy && (
        <div className="mb-4 rounded-2xl border border-card-border bg-surface p-3 space-y-1.5">
          {stages.map((s, i) => (
            <div key={`${s.stage}-${i}`} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                {s.status === "ok" ? (
                  <Check size={12} className="text-success" />
                ) : s.status === "failed" ? (
                  <X size={12} className="text-danger" />
                ) : (
                  <span className="block w-3 h-3 rounded-full border border-muted/40" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium leading-tight">
                  {STAGE_LABELS[s.stage] ?? s.stage}
                </p>
                {s.detail && (
                  <p className="text-[10px] text-muted leading-snug break-words">
                    {s.detail}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Failure */}
      {failure && !busy && (
        <div className="rounded-2xl border border-danger/20 bg-danger/10 p-4 animate-fade-in">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="text-danger shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-danger">Çözümlenemedi</p>
              <p className="text-xs text-muted mt-1 leading-relaxed">{failure}</p>
            </div>
          </div>
        </div>
      )}

      {/* Proposal */}
      {proposal && !busy && (
        <div className="animate-slide-up bg-card border border-card-border rounded-2xl overflow-hidden">
          {proposal.thumbnailUrl && (
            <div className="relative h-36 bg-surface">
              <img src={proposal.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              <span className="absolute bottom-3 left-3 px-2 py-1 rounded-lg text-[10px] font-bold bg-black/70 text-white capitalize">
                {proposal.platform}
              </span>
            </div>
          )}

          <div className="p-4 space-y-3">
            {/* Confidence */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Konum güveni
                </span>
                <span className="text-xs font-bold">{confidencePct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${confidencePct}%`, background: confidenceColor }}
                />
              </div>
              <p className="text-[10px] text-muted mt-1">
                {proposal.locationSource === "EXPLICIT_COORDINATE"
                  ? "Koordinat doğrudan kaynakta yazıyordu"
                  : `Kaynak: ${proposal.locationSource ?? "bilinmiyor"}`}
                {confidence < 0.85 && " — kaydetmeden önce kontrol et"}
              </p>
            </div>

            {/* Duplicate warning */}
            {proposal.duplicate && (
              <div className="rounded-xl border border-secondary/30 bg-secondary-light/40 p-3">
                <div className="flex items-start gap-2">
                  <Merge size={13} className="text-secondary shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">Bu yer zaten kayıtlı</p>
                    <p className="text-[10px] text-muted mt-0.5">
                      {proposal.duplicate.name} — {proposal.duplicate.reason}
                    </p>
                    <button
                      onClick={() => handleSave(proposal.duplicate!.placeId)}
                      disabled={saving}
                      className="mt-2 px-3 py-1.5 bg-secondary text-white rounded-lg text-[10px] font-bold disabled:opacity-40"
                    >
                      Kaynağı mevcut yere ekle
                    </button>
                  </div>
                </div>
              </div>
            )}

            <Field label="Yer adı">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm font-medium focus:outline-none focus:border-primary/50"
              />
            </Field>

            {/* Alternatives the geocoder also matched */}
            {proposal.alternatives.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Bunlardan biri mi?
                </p>
                <div className="space-y-1.5">
                  {proposal.alternatives.map((alt) => (
                    <button
                      key={`${alt.name}-${alt.lat}`}
                      onClick={() => {
                        setEditName(alt.name);
                        setEditLat(String(alt.lat));
                        setEditLng(String(alt.lng));
                      }}
                      className="w-full text-left p-2.5 bg-surface rounded-xl hover:bg-card-hover transition-colors"
                    >
                      <p className="text-xs font-medium">{alt.name}</p>
                      <p className="text-[10px] text-muted truncate">{alt.label}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Field label="Kategori">
              <select
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Lat">
                <input
                  type="text"
                  value={editLat}
                  onChange={(e) => setEditLat(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                />
              </Field>
              <Field label="Lng">
                <input
                  type="text"
                  value={editLng}
                  onChange={(e) => setEditLng(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-card-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
                />
              </Field>
            </div>

            {proposal.address && (
              <p className="text-[10px] text-muted bg-surface rounded-xl p-2.5 leading-snug">
                {proposal.address}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => handleSave()}
                disabled={saving || !editName || !editLat || !editLng}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 gradient-primary text-white rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {proposal.duplicate ? "Yine de yeni kayıt oluştur" : "Kaydet"}
              </button>
              <button
                onClick={reset}
                className="px-4 py-3 bg-surface border border-card-border rounded-xl text-sm hover:bg-card-hover transition-colors"
                aria-label="İptal"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hints */}
      {!proposal && !busy && !failure && stages.length === 0 && !saved && (
        <div className="space-y-2">
          {[
            ["🗺️", "Google Maps", "Koordinat doğrudan bağlantıda — en güvenilir yol"],
            ["🎵", "TikTok", "Açıklamadaki 📍 ve etiketlerden yer çıkarılır"],
            ["🥾", "Komoot", "Rota bağlantısı kaynağıyla birlikte saklanır"],
          ].map(([icon, title, hint]) => (
            <div key={title} className="flex items-center gap-3 p-3 bg-surface rounded-xl">
              <span className="text-lg">{icon}</span>
              <div>
                <p className="text-xs font-medium">{title}</p>
                <p className="text-[10px] text-muted">{hint}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
