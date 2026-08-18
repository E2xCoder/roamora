import "server-only";

/**
 * Minimal OpenGraph / meta-tag extraction.
 *
 * A full HTML parser is unnecessary here and would be another dependency;
 * these are targeted regexes over the document head. Values are entity-decoded
 * and never interpreted as markup — the pipeline only ever stores them as
 * text (spec §64: sanitize imported HTML).
 */

export interface HtmlMeta {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
  /** Coordinates from geo meta tags, when a site publishes them. */
  lat?: number;
  lng?: number;
  /** JSON-LD blocks, parsed where valid. */
  jsonLd: unknown[];
}

function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Reads a meta tag by property/name, tolerating attribute order. */
function metaContent(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]).trim() || undefined;
  }
  return undefined;
}

export function parseHtmlMeta(html: string): HtmlMeta {
  // Only the head matters, and capping the scan keeps this cheap on big pages.
  const head = html.slice(0, 200_000);

  const jsonLd: unknown[] = [];
  const ldRe =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(head)) !== null) {
    try {
      jsonLd.push(JSON.parse(m[1].trim()));
    } catch {
      // Malformed JSON-LD is common; skip it rather than failing the import.
    }
  }

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const latRaw =
    metaContent(head, "place:location:latitude") ??
    metaContent(head, "geo.position")?.split(/[;,]/)[0] ??
    metaContent(head, "ICBM")?.split(/[,;]/)[0];
  const lngRaw =
    metaContent(head, "place:location:longitude") ??
    metaContent(head, "geo.position")?.split(/[;,]/)[1] ??
    metaContent(head, "ICBM")?.split(/[,;]/)[1];

  const lat = latRaw != null ? Number(latRaw) : undefined;
  const lng = lngRaw != null ? Number(lngRaw) : undefined;

  return {
    title:
      metaContent(head, "og:title") ??
      metaContent(head, "twitter:title") ??
      (titleTag ? decodeEntities(titleTag[1]).trim() : undefined),
    description:
      metaContent(head, "og:description") ??
      metaContent(head, "twitter:description") ??
      metaContent(head, "description"),
    image:
      metaContent(head, "og:image") ??
      metaContent(head, "twitter:image") ??
      metaContent(head, "og:image:secure_url"),
    siteName: metaContent(head, "og:site_name"),
    author:
      metaContent(head, "author") ??
      metaContent(head, "article:author") ??
      metaContent(head, "twitter:creator"),
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
    jsonLd,
  };
}

/**
 * Pulls coordinates out of JSON-LD `geo` blocks, which restaurants, hotels and
 * attractions commonly publish.
 */
export function coordsFromJsonLd(
  blocks: unknown[]
): { lat: number; lng: number } | null {
  const visit = (node: unknown, depth = 0): { lat: number; lng: number } | null => {
    if (!node || typeof node !== "object" || depth > 6) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const obj = node as Record<string, unknown>;
    const geo = obj.geo as Record<string, unknown> | undefined;
    if (geo) {
      const lat = Number(geo.latitude);
      const lng = Number(geo.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }

    for (const value of Object.values(obj)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(blocks);
}

/** Extracts hashtags, which frequently carry the location on social posts. */
export function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => m[1]);
}
