"use client";

import { useState } from "react";
import { X } from "lucide-react";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-card-border rounded-xl p-6 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Yeni Yer Ekle</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">İsim</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-foreground text-sm"
              placeholder="Yer adı"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Enlem</label>
              <input
                type="number"
                value={lat}
                readOnly
                className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-muted text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Boylam</label>
              <input
                type="number"
                value={lng}
                readOnly
                className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-muted text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Kategori</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-foreground text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1).replace("-", " ")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Notlar</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-card-border bg-background text-foreground text-sm"
              rows={2}
              placeholder="Kişisel notların..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Etiketler</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                className="flex-1 px-3 py-2 rounded-lg border border-card-border bg-background text-foreground text-sm"
                placeholder="Etiket ekle..."
              />
              <button
                type="button"
                onClick={addTag}
                className="px-3 py-2 bg-primary text-white rounded-lg text-sm"
              >
                +
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 bg-primary-light text-primary text-xs rounded-full cursor-pointer"
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
              className="flex-1 px-4 py-2 border border-card-border rounded-lg text-sm"
            >
              İptal
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover"
            >
              Kaydet
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
