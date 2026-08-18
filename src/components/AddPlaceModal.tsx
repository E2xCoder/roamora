"use client";

import { useState } from "react";
import { X, MapPin } from "lucide-react";
import { CATEGORIES } from "@/types";

interface AddPlaceModalProps {
  lat: number;
  lng: number;
  onClose: () => void;
  onSave: (data: {
    name: string;
    lat: number;
    lng: number;
    category: string;
    notes: string;
    tags: string[];
  }) => void;
}

export default function AddPlaceModal({
  lat,
  lng,
  onClose,
  onSave,
}: AddPlaceModalProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [notes, setNotes] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
      setTagInput("");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({ name, lat, lng, category, notes, tags });
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-end md:items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-card-border rounded-t-3xl md:rounded-3xl p-6 w-full max-w-md mx-0 md:mx-4 shadow-[var(--shadow-xl)] animate-slide-up">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl gradient-primary flex items-center justify-center">
              <MapPin size={18} className="text-white" />
            </div>
            <h2 className="text-base font-bold">Yeni Yer Ekle</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-surface text-muted hover:text-foreground transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Isim</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary-glow"
              placeholder="Yer adi"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Enlem</label>
              <input
                type="number"
                value={lat}
                readOnly
                className="w-full mt-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-muted text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Boylam</label>
              <input
                type="number"
                value={lng}
                readOnly
                className="w-full mt-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-muted text-sm"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Kategori</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full mt-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-sm focus:outline-none focus:border-primary/50"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1).replace("-", " ")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Notlar</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full mt-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-sm focus:outline-none focus:border-primary/50"
              rows={2}
              placeholder="Kisisel notlarin..."
            />
          </div>

          <div>
            <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Etiketler</label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                className="flex-1 px-4 py-3 rounded-2xl border border-card-border bg-surface text-sm focus:outline-none focus:border-primary/50"
                placeholder="Etiket ekle..."
              />
              <button
                type="button"
                onClick={addTag}
                className="px-4 py-3 gradient-primary text-white rounded-2xl text-sm font-semibold"
              >
                +
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="px-3 py-1 bg-primary-light text-primary text-xs rounded-xl font-medium cursor-pointer hover:bg-primary hover:text-white transition-colors"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                  >
                    {t} ×
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 border border-card-border rounded-2xl text-sm font-medium hover:bg-surface transition-colors"
            >
              Iptal
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-3 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Kaydet
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
