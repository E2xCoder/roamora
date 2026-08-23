import "server-only";

/**
 * Real PDF-to-text extraction (production-hardening spec §3) — many
 * restaurants only publish their menu as a downloadable PDF, never as HTML
 * (real, live-confirmed case: Berlin's "Jolly" — the official-site crawler
 * already correctly finds `Jolly-Speisekarte.pdf` as the best menu link,
 * since "speisekarte" is in official-site-crawler.ts's own menu keyword
 * list, but the existing pipeline fed the raw PDF bytes straight to
 * htmlToPlainText()/Ollama as if it were HTML, producing zero usable
 * items — a real data-acquisition gap, not a guard failure).
 *
 * Uses pdfjs-dist (Mozilla's real, Apache-2.0-licensed PDF library) directly
 * rather than a thin wrapper package — text extraction via
 * `page.getTextContent()` needs no canvas/rendering and no real Worker
 * (Node has neither DOM nor Web Workers by default), so the worker is
 * disabled outright rather than pointed at a worker script that would never
 * load in this runtime.
 */

const MAX_PDF_PAGES = 15; // a menu is never this long; caps a hostile/oversized PDF's parse time

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Node has no real DOM Worker; pdfjs-dist falls back to an in-thread "fake
  // worker" automatically, but only once workerSrc resolves to a real,
  // loadable module — an empty string or a bare package specifier both fail
  // live-confirmed (`Cannot find module`) — so it must be the actual
  // resolved file path, not a browser-style URL.
  pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useSystemFonts: true,
  });

  try {
    const doc = await loadingTask.promise;
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pageTexts: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pageTexts.push(pageText);
    }
    return pageTexts.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export function isPdfContentType(contentType: string | null): boolean {
  return !!contentType && contentType.toLowerCase().includes("application/pdf");
}
