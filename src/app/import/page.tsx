"use client";

import { useState, useRef } from "react";
import { Upload, FileJson, FileSpreadsheet, CheckCircle, AlertCircle, Loader2, Info } from "lucide-react";

export default function ImportPage() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    total: number;
    geocoded?: number;
    skipped?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const csvFileRef = useRef<HTMLInputElement>(null);

  async function handleJsonUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);
    setError(null);
    setProgress("JSON dosyası okunuyor...");

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
      setProgress("");
      if (jsonFileRef.current) jsonFileRef.current.value = "";
    }
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);
    setError(null);

    try {
      const text = await file.text();
      let totalImported = 0;
      let totalPlaces = 0;
      let batchStart: number | null = 0;
      const batchSize = 50;

      while (batchStart !== null) {
        setProgress(
          `Yerler import ediliyor... ${batchStart}/${totalPlaces || "?"} (50'lik gruplar halinde, her yer ~1 saniye)`
        );

        const res: Response = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonContent: text,
            source: "google",
            format: "csv",
            batchStart,
            batchSize,
          }),
        });

        if (!res.ok) {
          const errData: { error?: string } = await res.json();
          throw new Error(errData.error || "Import failed");
        }

        const data: { imported: number; total: number; nextBatch: number | null; processed: number } = await res.json();
        totalImported += data.imported;
        totalPlaces = data.total;
        batchStart = data.nextBatch;

        setProgress(
          `Import ediliyor... ${data.processed}/${totalPlaces} yer işlendi (${totalImported} başarılı)`
        );
      }

      setResult({
        imported: totalImported,
        total: totalPlaces,
        geocoded: totalImported,
        skipped: totalPlaces - totalImported,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import hatası");
    } finally {
      setImporting(false);
      setProgress("");
      if (csvFileRef.current) csvFileRef.current.value = "";
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="flex items-center gap-3 mb-6">
        <Upload size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Veri Import</h1>
      </div>

      {/* CSV Import */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-6">
        <h2 className="font-bold text-lg mb-2 flex items-center gap-2">
          <FileSpreadsheet size={20} className="text-secondary" />
          Google Maps CSV Import
        </h2>
        <p className="text-sm text-muted mb-4">
          Google Takeout'tan indirdiğin CSV dosyasını yükle. Her yer için koordinatlar
          Nominatim (OpenStreetMap) ile otomatik çekilir.
        </p>

        <div className="bg-secondary-light border border-card-border rounded-lg p-4 mb-4">
          <h3 className="font-medium text-sm mb-2 flex items-center gap-2">
            <Info size={14} className="text-secondary" />
            Bilgi
          </h3>
          <ul className="text-xs text-muted space-y-1 list-disc list-inside">
            <li>CSV dosyasındaki yer adları ile koordinat aranır</li>
            <li>50'lik gruplar halinde işlenir — büyük dosyalar uzun sürer</li>
            <li>Bulunamayan yerler atlanır</li>
          </ul>
        </div>

        <label className="block">
          <input
            ref={csvFileRef}
            type="file"
            accept=".csv"
            onChange={handleCsvUpload}
            disabled={importing}
            className="hidden"
          />
          <div className="flex items-center justify-center w-full h-32 border-2 border-dashed border-card-border rounded-xl hover:border-secondary/50 cursor-pointer transition-colors">
            {importing ? (
              <div className="flex flex-col items-center gap-2 text-muted px-4">
                <Loader2 size={20} className="animate-spin" />
                <p className="text-sm text-center">{progress}</p>
              </div>
            ) : (
              <div className="text-center">
                <FileSpreadsheet size={24} className="text-muted mx-auto mb-2" />
                <p className="text-sm text-muted">CSV dosyasını tıkla veya sürükle</p>
              </div>
            )}
          </div>
        </label>
      </div>

      {/* JSON Import */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-6">
        <h2 className="font-bold text-lg mb-2 flex items-center gap-2">
          <FileJson size={20} className="text-primary" />
          Google Maps JSON Import
        </h2>
        <p className="text-sm text-muted mb-4">
          Google Takeout'tan GeoJSON formatında export.
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
            ref={jsonFileRef}
            type="file"
            accept=".json,.geojson"
            onChange={handleJsonUpload}
            disabled={importing}
            className="hidden"
          />
          <div className="flex items-center justify-center w-full h-32 border-2 border-dashed border-card-border rounded-xl hover:border-primary/50 cursor-pointer transition-colors">
            <div className="text-center">
              <FileJson size={24} className="text-muted mx-auto mb-2" />
              <p className="text-sm text-muted">JSON dosyasını tıkla veya sürükle</p>
            </div>
          </div>
        </label>
      </div>

      {/* Results */}
      {result && (
        <div className="p-4 bg-primary-light rounded-xl flex items-center gap-3 mb-6">
          <CheckCircle size={20} className="text-primary shrink-0" />
          <div>
            <p className="font-medium text-sm">Import tamamlandı!</p>
            <p className="text-xs text-muted">
              {result.imported} yer eklendi (toplam: {result.total})
              {result.geocoded != null && (
                <> — {result.geocoded} koordinat bulundu, {result.skipped} atlandı</>
              )}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-950 rounded-xl flex items-center gap-3 mb-6">
          <AlertCircle size={20} className="text-danger shrink-0" />
          <div>
            <p className="font-medium text-sm text-danger">Hata!</p>
            <p className="text-xs text-muted">{error}</p>
          </div>
        </div>
      )}

      {/* Manual */}
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
