"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeft, MapPin, ExternalLink, Trash2, Loader2, Check, X,
  Calendar, Clock, Tag as TagIcon, ShieldQuestion,
} from "lucide-react";
import { categoryOf } from "@/lib/taxonomy";
import type { Place } from "@/lib/place-meta";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface PlaceSource {
  id: string;
  platform: string;
  url: string | null;
  title: string | null;
  creator: string | null;
  savedAt: string;
  thumbnailUrl: string | null;
}

interface MediaItem {
  id: string;
  type: string;
  storagePath: string | null;
  originalUrl: string | null;
  thumbnailPath: string | null;
}

interface PlaceDetail extends Place {
  categoryId: string | null;
  subcategory: string | null;
  sourceType: string;
  locationSource: string | null;
  locationConfidence: number | null;
  hiddenGemScore: number | null;
  estimatedVisitMinutes: number | null;
  website: string | null;
  aiDescription: string | null;
  createdAt: string;
  sources: PlaceSource[];
  media: MediaItem[];
  nearby: Place[];
}

const SOURCE_TYPE_LABELS: Record<string, { label: string; hint: string }> = {
  PERSONAL: { label: "Kaydettiğim", hint: "Bir paylaşımdan sen kaydettin" },
  IMPORTED: { label: "İçe aktarıldı", hint: "Google Takeout gibi bir dışa aktarımdan geldi" },
  MANUAL: { label: "Elle eklendi", hint: "Haritaya tıklayarak sen ekledin" },
  DISCOVERED: { label: "Keşfedildi", hint: "Keşfet ekranından kaydedildi" },
  RESEARCHED: { label: "Araştırmadan", hint: "Destinasyon araştırması sırasında bulundu" },
  REFERENCE: { label: "Keşif havuzu", hint: "Toplu açık veri — senin kaydın değil" },
};

export default function PlaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [place, setPlace] = useState<PlaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/places/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Yer yüklenemedi (${res.status})`);
        return;
      }
      const data = await res.json();
      setPlace(data);
      setNotesDraft(data.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveNotes() {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/places/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesDraft }),
      });
      if (res.ok) {
        setEditingNotes(false);
        load();
      }
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleDelete() {
    if (!place || !window.confirm(`${place.name} yerini sil? Bu işlem geri alınamaz.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/places/${id}`, { method: "DELETE" });
      if (res.ok) router.push("/");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-primary" />
      </div>
    );
  }

  if (error || !place) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-6">
        <div className="text-center">
          <div className="w-14 h-14 rounded-3xl bg-danger/10 flex items-center justify-center mx-auto mb-4">
            <X size={22} className="text-danger" />
          </div>
          <p className="font-semibold text-sm">Yer açılamadı</p>
          <p className="text-xs text-muted mt-1">{error}</p>
          <Link
            href="/"
            className="inline-block mt-4 px-4 py-2 bg-surface border border-card-border rounded-xl text-xs font-medium"
          >
            Haritaya dön
          </Link>
        </div>
      </div>
    );
  }

  const cat = categoryOf(place.categoryId);
  const provenance = SOURCE_TYPE_LABELS[place.sourceType] ?? SOURCE_TYPE_LABELS.MANUAL;
  const heroImage =
    place.media.find((m) => m.thumbnailPath || m.storagePath || m.originalUrl) ??
    null;
  const heroSrc =
    heroImage?.storagePath ??
    heroImage?.thumbnailPath ??
    heroImage?.originalUrl ??
    place.imageUrl ??
    null;

  return (
    <div className="min-h-dvh pb-24">
      {/* Hero */}
      <div className="relative h-56 md:h-72 bg-surface">
        {heroSrc ? (
          <img src={heroSrc} alt="" className="w-full h-full object-cover" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-6xl"
            style={{ background: `${cat.color}18` }}
          >
            {cat.icon}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/30" />

        <button
          onClick={() => router.back()}
          className="absolute top-4 left-4 glass-panel rounded-2xl p-2.5 shadow-[var(--shadow-md)]"
          aria-label="Geri"
        >
          <ArrowLeft size={18} />
        </button>

        <div className="absolute bottom-4 left-4 right-4">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="px-2.5 py-1 rounded-lg text-[10px] font-bold text-white"
              style={{ background: cat.color }}
            >
              {cat.icon} {cat.label}
            </span>
            <span className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-white/20 text-white backdrop-blur-sm">
              {provenance.label}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-white leading-tight">
            {place.name}
          </h1>
          {(place.address || place.city) && (
            <p className="text-xs text-white/80 mt-1">
              {[place.address, place.city, place.country].filter(Boolean).join(", ")}
            </p>
          )}
        </div>
      </div>

      <div className="px-5 md:px-8 max-w-3xl mx-auto -mt-4 relative space-y-5">
        {/* Provenance — where this came from and how sure we are */}
        <section className="bg-card border border-card-border rounded-3xl p-5">
          <h2 className="text-[10px] font-bold uppercase tracking-wider text-muted mb-3">
            Bu yer nereden geldi
          </h2>

          <p className="text-xs text-muted mb-3">{provenance.hint}</p>

          {place.locationConfidence != null && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <ShieldQuestion size={12} className="text-muted" />
                  Konum güveni
                </span>
                <span className="text-xs font-semibold">
                  {Math.round(place.locationConfidence * 100)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-surface overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(place.locationConfidence * 100)}%`,
                    background:
                      place.locationConfidence >= 0.85
                        ? "var(--success)"
                        : place.locationConfidence >= 0.5
                          ? "var(--secondary)"
                          : "var(--danger)",
                  }}
                />
              </div>
              {place.locationSource && (
                <p className="text-[10px] text-muted mt-1.5">
                  Kaynak: {place.locationSource}
                </p>
              )}
            </div>
          )}

          {place.sources.length > 0 ? (
            <div className="space-y-2">
              {place.sources.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 p-3 bg-surface rounded-2xl"
                >
                  {s.thumbnailUrl ? (
                    <img
                      src={s.thumbnailUrl}
                      alt=""
                      className="w-11 h-11 rounded-xl object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-card flex items-center justify-center shrink-0 text-lg">
                      {s.platform === "tiktok" ? "🎵" : s.platform === "instagram" ? "📸" : "🔗"}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold capitalize">{s.platform}</p>
                    {s.creator && (
                      <p className="text-[10px] text-muted truncate">{s.creator}</p>
                    )}
                    <p className="text-[10px] text-muted">
                      {new Date(s.savedAt).toLocaleDateString("tr-TR")}
                    </p>
                  </div>
                  {s.url && (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-xl bg-card text-muted hover:text-primary transition-colors shrink-0"
                      aria-label="Kaynağı aç"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Kayıtlı kaynak yok.</p>
          )}
        </section>

        {/* Notes */}
        <section className="bg-card border border-card-border rounded-3xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-muted">
              Notlarım
            </h2>
            {!editingNotes && (
              <button
                onClick={() => setEditingNotes(true)}
                className="text-[10px] font-semibold text-primary"
              >
                Düzenle
              </button>
            )}
          </div>

          {editingNotes ? (
            <div className="space-y-2">
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={4}
                className="w-full px-4 py-3 bg-surface border border-card-border rounded-2xl text-sm focus:outline-none focus:border-primary/50"
                placeholder="Buraya neden gitmek istediğini yaz..."
              />
              <div className="flex gap-2">
                <button
                  onClick={saveNotes}
                  disabled={savingNotes}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-primary text-white rounded-xl text-xs font-semibold disabled:opacity-40"
                >
                  {savingNotes ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                  Kaydet
                </button>
                <button
                  onClick={() => {
                    setEditingNotes(false);
                    setNotesDraft(place.notes ?? "");
                  }}
                  className="px-4 py-2.5 bg-surface border border-card-border rounded-xl text-xs"
                >
                  İptal
                </button>
              </div>
            </div>
          ) : place.notes ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {place.notes}
            </p>
          ) : (
            <p className="text-xs text-muted">Henüz not yok.</p>
          )}
        </section>

        {/* Facts */}
        <section className="grid grid-cols-2 gap-3">
          <Fact
            icon={<MapPin size={13} />}
            label="Koordinat"
            value={`${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`}
          />
          <Fact
            icon={<Calendar size={13} />}
            label="Kaydedildi"
            value={new Date(place.createdAt).toLocaleDateString("tr-TR")}
          />
          {place.estimatedVisitMinutes != null && (
            <Fact
              icon={<Clock size={13} />}
              label="Tahmini süre"
              value={`${place.estimatedVisitMinutes} dk`}
            />
          )}
          {place.tags.length > 0 && (
            <Fact
              icon={<TagIcon size={13} />}
              label="Etiketler"
              value={place.tags.slice(0, 3).join(", ")}
            />
          )}
        </section>

        {/* Map */}
        <section className="h-64 rounded-3xl overflow-hidden border border-card-border">
          <MapView
            places={[place, ...place.nearby]}
            center={[place.lat, place.lng]}
            zoom={15}
            linkToDetail
          />
        </section>

        {/* Nearby */}
        {place.nearby.length > 0 && (
          <section>
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-muted mb-3">
              Yakındaki yerler ({place.nearby.length})
            </h2>
            <div className="space-y-2">
              {place.nearby.slice(0, 6).map((n) => {
                const nc = categoryOf(
                  (n as Place & { categoryId?: string }).categoryId
                );
                return (
                  <Link
                    key={n.id}
                    href={`/place/${n.id}`}
                    className="flex items-center gap-3 p-3 bg-card border border-card-border rounded-2xl hover:border-primary/30 transition-colors"
                  >
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: `${nc.color}22` }}
                    >
                      {nc.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{n.name}</p>
                      <p className="text-[10px] text-muted">{nc.label}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Danger zone */}
        <section className="pt-2">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border border-danger/25 text-danger text-xs font-semibold hover:bg-danger/10 transition-colors disabled:opacity-40"
          >
            {deleting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            Bu yeri sil
          </button>
          <p className="text-[10px] text-muted text-center mt-2">
            Silinen yer arşivlenir, kaynak bilgisi korunur.
          </p>
        </section>
      </div>
    </div>
  );
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-2xl p-3.5">
      <div className="flex items-center gap-1.5 text-muted mb-1">
        {icon}
        <span className="text-[9px] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-xs font-medium break-words">{value}</p>
    </div>
  );
}
