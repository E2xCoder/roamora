/**
 * Source provider contract.
 *
 * Each implementation knows how to recognise one family of URLs and pull
 * whatever metadata that platform exposes. Providers never throw for an
 * expected failure — they return `ok: false` with a reason, so the pipeline
 * can report which stage failed instead of collapsing into "something went
 * wrong" (spec §55, §62).
 */

export type Platform =
  | "tiktok"
  | "instagram"
  | "youtube"
  | "komoot"
  | "googlemaps"
  | "web";

export interface SourceMetadata {
  platform: Platform;
  url: string;
  /** Canonical form used for deduplication. */
  normalizedUrl: string;
  title?: string;
  description?: string;
  creator?: string;
  thumbnailUrl?: string;
  /** Platform-native identifier (video id, place id). */
  externalId?: string;
  /** Coordinates when the source states them outright. */
  lat?: number;
  lng?: number;
  /** Free-text place names the source names explicitly. */
  placeHints?: string[];
  /** Raw payload, retained so a place can be reprocessed without refetching. */
  raw?: unknown;
  /** How this metadata was obtained, for the UI's stage report. */
  strategy: string;
}

export type SourceResult =
  | { ok: true; data: SourceMetadata }
  | { ok: false; reason: string; platform: Platform };

export interface SourceProvider {
  readonly id: string;
  /** Whether this provider handles the given URL. */
  matches(url: URL): boolean;
  fetchMetadata(url: URL): Promise<SourceResult>;
}

/** Strips tracking parameters so the same link saved twice dedupes. */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "igshid",
  "igsh",
  "fbclid",
  "gclid",
  "si",
  "_r",
  "_t",
  "is_from_webapp",
  "sender_device",
  "web_id",
];

export function normalizeUrl(url: URL): string {
  const clean = new URL(url.href);
  for (const p of TRACKING_PARAMS) clean.searchParams.delete(p);
  clean.hash = "";
  // Trailing slashes are not meaningful for these platforms.
  clean.pathname = clean.pathname.replace(/\/+$/, "") || "/";
  clean.hostname = clean.hostname.replace(/^www\./, "").toLowerCase();
  return clean.href;
}
