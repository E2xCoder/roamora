"use client";

import { useState, useRef } from "react";
import { Upload, FileJson, FileSpreadsheet, CheckCircle, AlertCircle, Loader2, Info, ArrowRight } from "lucide-react";

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
    setProgress("JSON dosyasi okunuyor...");

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
      setError(err instanceof Error ? err.message : "Import hatasi");
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
          `Import ediliyor... ${batchStart}/${totalPlaces || "?"}`
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
          `${data.processed}/${totalPlaces} islendi (${totalImported} basarili)`
        );
      }

      setResult({
        imported: totalImported,
        total: totalPlaces,
        geocoded: totalImported,
        skipped: totalPlaces - totalImported,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import hatasi");
    } finally {
      setImporting(false);
      setProgress("");
      if (csvFileRef.current) csvFileRef.current.value = "";
    }
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-2xl gradient-primary flex items-center justify-center">
            <Upload size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Veri Import</h1>
            <p className="text-xs text-muted">Google Maps verilerini ice aktar</p>
          </div>
        </div>
      </div>

      <div className="px-6 max-w-2xl pb-24 space-y-6">
        {/* Results */}
        {result && (
          <div className="p-5 bg-success/10 border border-success/20 rounded-3xl flex items-center gap-4 animate-slide-up">
            <div className="w-10 h-10 rounded-2xl bg-success/20 flex items-center justify-center shrink-0">
              <CheckCircle size={20} className="text-success" />
            </div>
            <div>
              <p className="font-semibold text-sm">Import tamamlandi!</p>
              <p className="text-xs text-muted">
                {result.imported} yer eklendi (toplam: {result.total})
                {result.geocoded != null && (
                  <> — {result.geocoded} koordinat bulundu, {result.skipped} atlandi</>
                )}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="p-5 bg-danger/10 border border-danger/20 rounded-3xl flex items-center gap-4 animate-slide-up">
            <div className="w-10 h-10 rounded-2xl bg-danger/20 flex items-center justify-center shrink-0">
              <AlertCircle size={20} className="text-danger" />
            </div>
            <div>
              <p className="font-semibold text-sm text-danger">Hata!</p>
              <p className="text-xs text-muted">{error}</p>
            </div>
          </div>
        )}

        {/* CSV Import */}
        <div className="bg-card border border-card-border rounded-3xl overflow-hidden">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-secondary-light flex items-center justify-center">
                <FileSpreadsheet size={20} className="text-secondary" />
              </div>
              <div>
                <h2 className="font-bold text-sm">Google Maps CSV</h2>
                <p className="text-xs text-muted">Takeout'tan CSV dosyasi yukle</p>
              </div>
            </div>

            <div className="bg-surface rounded-2xl p-4 mb-4">
              <div className="flex items-start gap-2">
                <Info size={14} className="text-muted shrink-0 mt-0.5" />
                <ul className="text-[11px] text-muted space-y-1">
                  <li>CSV dosyasindaki yer adlari ile koordinat aranir</li>
                  <li>50'lik gruplar halinde islenir</li>
                  <li>Bulunamayan yerler atlanir</li>
                </ul>
              </div>
            </div>

            <label className="block cursor-pointer">
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                disabled={importing}
                className="hidden"
              />
              <div className="flex items-center justify-center h-28 border-2 border-dashed border-card-border rounded-2xl hover:border-primary/50 hover:bg-primary-light/30 transition-all">
                {importing ? (
                  <div className="flex flex-col items-center gap-2 px-4">
                    <Loader2 size={20} className="text-primary animate-spin" />
                    <p className="text-xs text-muted text-center">{progress}</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <FileSpreadsheet size={24} className="text-muted mx-auto mb-2" />
                    <p className="text-xs text-muted">CSV dosyasini tikla veya surukle</p>
                  </div>
                )}
              </div>
            </label>
          </div>
        </div>

        {/* JSON Import */}
        <div className="bg-card border border-card-border rounded-3xl overflow-hidden">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-light flex items-center justify-center">
                <FileJson size={20} className="text-primary" />
              </div>
              <div>
                <h2 className="font-bold text-sm">Google Maps JSON</h2>
                <p className="text-xs text-muted">GeoJSON formatinda export</p>
              </div>
            </div>

            <div className="bg-surface rounded-2xl p-4 mb-4">
              <div className="flex items-start gap-2">
                <Info size={14} className="text-muted shrink-0 mt-0.5" />
                <ol className="text-[11px] text-muted space-y-1 list-decimal list-inside">
                  <li>takeout.google.com adresine git</li>
                  <li>Sadece "Saved" veya "Maps" sec</li>
                  <li>Export'u indir ve ZIP'i ac</li>
                  <li>Saved Places.json dosyasini yukle</li>
                </ol>
              </div>
            </div>

            <label className="block cursor-pointer">
              <input
                ref={jsonFileRef}
                type="file"
                accept=".json,.geojson"
                onChange={handleJsonUpload}
                disabled={importing}
                className="hidden"
              />
              <div className="flex items-center justify-center h-28 border-2 border-dashed border-card-border rounded-2xl hover:border-primary/50 hover:bg-primary-light/30 transition-all">
                <div className="text-center">
                  <FileJson size={24} className="text-muted mx-auto mb-2" />
                  <p className="text-xs text-muted">JSON dosyasini tikla veya surukle</p>
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Manual */}
        <div className="bg-card border border-card-border rounded-3xl p-6">
          <h2 className="font-bold text-sm mb-2">Manuel Ekleme</h2>
          <p className="text-xs text-muted mb-4">
            Harita sayfasinda haritaya tiklayarak veya link yapistirarak yer ekle
          </p>
          <a
            href="/"
            className="inline-flex items-center gap-2 px-5 py-3 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Haritaya Git
            <ArrowRight size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}
