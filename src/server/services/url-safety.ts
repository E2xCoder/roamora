import "server-only";
import { lookup } from "node:dns/promises";

/**
 * URL validation for the import pipeline.
 *
 * The ingestion endpoint fetches whatever URL it is handed, which without
 * checks is a server-side request forgery primitive: an attacker (or a
 * mistyped paste) could reach the loopback interface, the private network, or
 * a cloud metadata endpoint. Every outbound import fetch goes through here
 * first (spec §64).
 */

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that must never be resolved, regardless of DNS. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:10.0.0.1) — check the embedded address.
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Parses and vets a URL, resolving DNS so a public hostname pointing at a
 * private address is rejected too.
 */
export async function checkImportUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Geçerli bir URL değil" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Desteklenmeyen protokol: ${url.protocol}` };
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "Yerel adresler içe aktarılamaz" };
  }

  // Literal IPs skip DNS but still need vetting.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { ok: false, reason: "Özel ağ adresleri içe aktarılamaz" };
    }
    return { ok: true, url };
  }
  if (hostname.includes(":") || url.href.includes("[")) {
    if (isPrivateIPv6(hostname)) {
      return { ok: false, reason: "Özel ağ adresleri içe aktarılamaz" };
    }
    return { ok: true, url };
  }

  // Resolve the name: a public hostname may still point inside the network.
  try {
    const results = await lookup(hostname, { all: true });
    for (const { address, family } of results) {
      const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
      if (isPrivate) {
        return {
          ok: false,
          reason: "Bu alan adı özel bir ağ adresine çözümleniyor",
        };
      }
    }
  } catch {
    return { ok: false, reason: "Alan adı çözümlenemedi" };
  }

  return { ok: true, url };
}

/** Caps on what the pipeline will download from an untrusted origin. */
export const FETCH_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024, // 2 MB of HTML is far more than any page needs
};

interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string | null;
}

/** Shared capped-download core — both fetchTextCapped and fetchTextOrPdfCapped build on this so the size-cap streaming logic exists exactly once. */
async function fetchBytesCapped(
  url: string,
  init?: RequestInit
): Promise<{ ok: true } & FetchedBytes | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Roamora/1.0; +https://github.com/E2xCoder/roamora)",
        Accept: "text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8",
        ...init?.headers,
      },
    });

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > FETCH_LIMITS.maxBytes) {
      return { ok: false, reason: "İçerik çok büyük" };
    }
    const contentType = res.headers.get("content-type");

    const reader = res.body?.getReader();
    if (!reader) return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()), contentType };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > FETCH_LIMITS.maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "İçerik çok büyük" };
      }
      chunks.push(value);
    }

    return { ok: true, bytes: concat(chunks, total), contentType };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "İstek başarısız",
    };
  }
}

/**
 * Fetches text with a size cap, so a hostile or broken origin cannot exhaust
 * memory by streaming indefinitely.
 */
export async function fetchTextCapped(
  url: string,
  init?: RequestInit
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const fetched = await fetchBytesCapped(url, init);
  if (!fetched.ok) return fetched;
  return { ok: true, text: new TextDecoder().decode(fetched.bytes) };
}

/**
 * Same as fetchTextCapped, but a PDF response (by URL extension or real
 * Content-Type — either alone is a genuine signal) is run through real PDF
 * text extraction (pdf-extraction.ts) instead of being decoded as UTF-8
 * text, which would just produce binary garbage. Used only by the fact
 * research call sites that can legitimately land on a menu/price PDF
 * (official-site-crawler.ts, direct-research.ts) — fetchTextCapped itself
 * is left untouched for every other caller (the import pipeline, etc.)
 * that has no PDF-handling contract and should not silently change shape.
 */
export async function fetchTextOrPdfCapped(
  url: string,
  init?: RequestInit
): Promise<{ ok: true; text: string; wasPdf: boolean } | { ok: false; reason: string }> {
  const fetched = await fetchBytesCapped(url, init);
  if (!fetched.ok) return fetched;

  const { isPdfUrl, isPdfContentType, extractPdfText } = await import("@/server/services/pdf-extraction");
  if (isPdfUrl(url) || isPdfContentType(fetched.contentType)) {
    try {
      const text = await extractPdfText(fetched.bytes);
      return { ok: true, text, wasPdf: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? `PDF ayrıştırılamadı: ${err.message}` : "PDF ayrıştırılamadı" };
    }
  }
  return { ok: true, text: new TextDecoder().decode(fetched.bytes), wasPdf: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
