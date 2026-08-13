"use client";

import { useState, useRef } from "react";
import { Upload, FileJson, CheckCircle, AlertCircle, Loader2, Info } from "lucide-react";

export default function ImportPage() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);
    setError(null);

    try {
      const text = await file.text();
      JSON.parse(text);

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonContent: text, source: "google" }),
      });

      if (!res.ok) throw new Error("Import failed");
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import hatası");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="flex items-center gap-3 mb-6">
        <Upload size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Veri Import</h1>
      </div>

      <div className="bg-card border border-card-border rounded-xl p-6 mb-6">
        <h2 className="font-bold text-lg mb-2 flex items-center gap-2">
          <FileJson size={20} className="text-primary" />
          Google Maps Import
        </h2>
        <p className="text-sm text-muted mb-4">
          Google Takeout'tan indirdiğin Saved Places dosyasını yükle.
        </p>

        <div className="bg-background border border-card-border rounded-lg p-4 mb-4">
          <h3 className="font-medium text-sm mb-2 flex items-center gap-2">
            <Info size={14} className="text-primary" />
            Nasıl yapılır?
          </h3>
          <ol className="text-xs text-muted space-y-1.5 list-decimal list-inside">
            <li>
              <a
                href="https://takeout.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                takeout.google.com
              </a>
              {" "}adresine git
            </li>
            <li>Sadece &quot;Saved&quot; veya &quot;Maps (your places)&quot; seç</li>
            <li>Export'u indir ve ZIP'i aç</li>
            <li>
              <code className="bg-card px-1 rounded">Saved Places.json</code> veya{" "}
              <code className="bg-card px-1 rounded">GeoJSON</code> dosyasını buraya yükle
            </li>
          </ol>
        </div>

        <label className="block">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.geojson"
            onChange={handleFileUpload}
            className="hidden"
          />
          <div className="flex items-center justify-center w-full h-32 border-2 border-dashed border-card-border rounded-xl hover:border-primary/50 cursor-pointer transition-colors">
            {importing ? (
              <div className="flex items-center gap-2 text-muted">
                <Loader2 size={20} className="animate-spin" />
                Import ediliyor...
              </div>
            ) : (
              <div className="text-center">
                <Upload size={24} className="text-muted mx-auto mb-2" />
                <p className="text-sm text-muted">
                  JSON dosyasını tıkla veya sürükle
                </p>
              </div>
            )}
          </div>
        </label>

        {result && (
          <div className="mt-4 p-4 bg-primary-light rounded-lg flex items-center gap-3">
            <CheckCircle size={20} className="text-primary" />
            <div>
              <p className="font-medium text-sm">Import tamamlandı!</p>
              <p className="text-xs text-muted">
                {result.imported} / {result.total} yer başarıyla eklendi
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 p-4 bg-red-50 dark:bg-red-950 rounded-lg flex items-center gap-3">
            <AlertCircle size={20} className="text-danger" />
            <div>
              <p className="font-medium text-sm text-danger">Hata!</p>
              <p className="text-xs text-muted">{error}</p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-card border border-card-border rounded-xl p-6">
        <h2 className="font-bold text-lg mb-2">Manuel Ekleme</h2>
        <p className="text-sm text-muted mb-2">
          Instagram kayıtlıların veya başka yerler için harita sayfasına git ve
          haritaya tıklayarak yer ekle.
        </p>
        <a
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover"
        >
          Haritaya Git
        </a>
      </div>
    </div>
  );
}
