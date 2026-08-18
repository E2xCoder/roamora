import "server-only";
import {
  normalizeUrl,
  type Platform,
  type SourceMetadata,
  type SourceProvider,
  type SourceResult,
} from "./types";
import { parseHtmlMeta, coordsFromJsonLd, extractHashtags } from "./html-meta";
import { fetchTextCapped } from "@/server/services/url-safety";

/**
 * Source providers.
 *
 * Each uses the cheapest mechanism that platform offers. TikTok and YouTube
 * publish keyless oEmbed endpoints, so basic metadata works without yt-dlp
 * installed — yt-dlp is treated as an enrichment step, not a prerequisite.
 */

async function fetchJson(url: string): Promise<unknown | null> {
  const res = await fetchTextCapped(url);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

async function fetchMeta(url: URL, platform: Platform, strategy: string) {
  const res = await fetchTextCapped(url.href);
  if (!res.ok) {
    return { ok: false as const, reason: res.reason, platform };
  }

  const meta = parseHtmlMeta(res.text);
  const geo = coordsFromJsonLd(meta.jsonLd);
  const text = `${meta.title ?? ""} ${meta.description ?? ""}`;

  return {
    ok: true as const,
    data: {
      platform,
      url: url.href,
      normalizedUrl: normalizeUrl(url),
      title: meta.title,
      description: meta.description,
      creator: meta.author,
      thumbnailUrl: meta.image,
      lat: meta.lat ?? geo?.lat,
      lng: meta.lng ?? geo?.lng,
      placeHints: extractHashtags(text),
      raw: { meta: { ...meta, jsonLd: undefined } },
      strategy,
    } satisfies SourceMetadata,
  };
}

/* --------------------------------- TikTok --------------------------------- */

export const tiktokProvider: SourceProvider = {
  id: "tiktok",
  matches: (url) => /(^|\.)tiktok\.com$/.test(url.hostname.replace(/^www\./, "")),

  async fetchMetadata(url): Promise<SourceResult> {
    // oEmbed is public, keyless and does not require yt-dlp.
    const oembed = (await fetchJson(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url.href)}`
    )) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
      embed_product_id?: string;
    } | null;

    if (oembed?.title || oembed?.author_name) {
      const title = oembed.title ?? "";
      return {
        ok: true,
        data: {
          platform: "tiktok",
          url: url.href,
          normalizedUrl: normalizeUrl(url),
          // TikTok puts the whole caption in `title`.
          title: title.slice(0, 200),
          description: title,
          creator: oembed.author_name,
          thumbnailUrl: oembed.thumbnail_url,
          externalId: oembed.embed_product_id ?? url.pathname.match(/\/video\/(\d+)/)?.[1],
          placeHints: extractHashtags(title),
          raw: oembed,
          strategy: "oembed",
        },
      };
    }

    // oEmbed rejects private/removed videos; fall back to the page itself.
    const viaMeta = await fetchMeta(url, "tiktok", "opengraph");
    if (viaMeta.ok) return viaMeta;

    return {
      ok: false,
      platform: "tiktok",
      reason:
        "TikTok bu video için üstveri vermedi (gizli, silinmiş ya da bölge kısıtlı olabilir).",
    };
  },
};

/* -------------------------------- YouTube --------------------------------- */

export const youtubeProvider: SourceProvider = {
  id: "youtube",
  matches: (url) => {
    const h = url.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h === "youtu.be" || h === "m.youtube.com";
  },

  async fetchMetadata(url): Promise<SourceResult> {
    const oembed = (await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`
    )) as { title?: string; author_name?: string; thumbnail_url?: string } | null;

    if (oembed?.title) {
      return {
        ok: true,
        data: {
          platform: "youtube",
          url: url.href,
          normalizedUrl: normalizeUrl(url),
          title: oembed.title,
          description: oembed.title,
          creator: oembed.author_name,
          thumbnailUrl: oembed.thumbnail_url,
          externalId:
            url.searchParams.get("v") ??
            (url.pathname.replace(/^\//, "") || undefined),
          placeHints: extractHashtags(oembed.title),
          raw: oembed,
          strategy: "oembed",
        },
      };
    }

    return {
      ok: false,
      platform: "youtube",
      reason: "YouTube bu video için üstveri vermedi.",
    };
  },
};

/* ------------------------------- Instagram -------------------------------- */

export const instagramProvider: SourceProvider = {
  id: "instagram",
  matches: (url) => /(^|\.)instagram\.com$/.test(url.hostname.replace(/^www\./, "")),

  async fetchMetadata(url): Promise<SourceResult> {
    // Instagram's oEmbed needs an app token, so OpenGraph is the keyless path.
    // It works for public posts; logged-out reels often return a login wall.
    const viaMeta = await fetchMeta(url, "instagram", "opengraph");

    if (viaMeta.ok && (viaMeta.data.title || viaMeta.data.description)) {
      const looksLikeLoginWall =
        /login|log in|sign up/i.test(viaMeta.data.title ?? "") &&
        !viaMeta.data.description;
      if (!looksLikeLoginWall) {
        return {
          ...viaMeta,
          data: {
            ...viaMeta.data,
            externalId: url.pathname.match(/\/(?:p|reel|reels)\/([^/]+)/)?.[1],
          },
        };
      }
    }

    return {
      ok: false,
      platform: "instagram",
      reason:
        "Instagram giriş yapmadan bu gönderinin bilgilerini vermiyor. Açıklamayı elle yapıştırabilir ya da yt-dlp kurabilirsin.",
    };
  },
};

/* ------------------------------ Google Maps ------------------------------- */

export const googleMapsProvider: SourceProvider = {
  id: "googlemaps",
  matches: (url) => {
    const h = url.hostname.replace(/^www\./, "");
    return (
      h === "maps.app.goo.gl" ||
      h === "goo.gl" ||
      h.endsWith("google.com") ||
      h.startsWith("maps.google.")
    );
  },

  async fetchMetadata(url): Promise<SourceResult> {
    // Coordinates are usually encoded in the URL itself.
    const coords = coordsFromGoogleUrl(url.href);

    // Short links must be followed to expose them.
    if (!coords && /goo\.gl/.test(url.hostname)) {
      const res = await fetchTextCapped(url.href);
      if (res.ok) {
        const canonical = parseHtmlMeta(res.text);
        const fromCanonical = coordsFromGoogleUrl(res.text.slice(0, 50_000));
        if (fromCanonical) {
          return {
            ok: true,
            data: {
              platform: "googlemaps",
              url: url.href,
              normalizedUrl: normalizeUrl(url),
              title: canonical.title,
              thumbnailUrl: canonical.image,
              lat: fromCanonical.lat,
              lng: fromCanonical.lng,
              placeHints: canonical.title ? [canonical.title] : [],
              strategy: "url-coordinates",
            },
          };
        }
      }
    }

    const name = decodeURIComponent(
      url.pathname.match(/\/place\/([^/@]+)/)?.[1] ?? ""
    ).replace(/\+/g, " ");

    if (coords || name) {
      return {
        ok: true,
        data: {
          platform: "googlemaps",
          url: url.href,
          normalizedUrl: normalizeUrl(url),
          title: name || undefined,
          lat: coords?.lat,
          lng: coords?.lng,
          placeHints: name ? [name] : [],
          strategy: coords ? "url-coordinates" : "url-name",
        },
      };
    }

    return {
      ok: false,
      platform: "googlemaps",
      reason: "Bu Google Maps bağlantısından konum çıkarılamadı.",
    };
  },
};

/** `@lat,lng` and `!3dlat!4dlng` are the two forms Maps uses. */
export function coordsFromGoogleUrl(
  input: string
): { lat: number; lng: number } | null {
  const at = input.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  const bang = input.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (bang) {
    const lat = Number(bang[1]);
    const lng = Number(bang[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  const q = input.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (q) {
    const lat = Number(q[1]);
    const lng = Number(q[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/* --------------------------------- Komoot --------------------------------- */

export const komootProvider: SourceProvider = {
  id: "komoot",
  matches: (url) => /(^|\.)komoot\.[a-z]+$/.test(url.hostname.replace(/^www\./, "")),

  async fetchMetadata(url): Promise<SourceResult> {
    const viaMeta = await fetchMeta(url, "komoot", "opengraph");
    if (!viaMeta.ok) return viaMeta;

    return {
      ok: true,
      data: {
        ...viaMeta.data,
        externalId: url.pathname.match(/\/(?:tour|smarttour)\/(\d+)/)?.[1],
      },
    };
  },
};

/* --------------------------------- Generic -------------------------------- */

export const genericWebProvider: SourceProvider = {
  id: "web",
  matches: () => true, // last resort
  fetchMetadata: (url) => fetchMeta(url, "web", "opengraph"),
};

export const SOURCE_PROVIDERS: SourceProvider[] = [
  tiktokProvider,
  youtubeProvider,
  instagramProvider,
  googleMapsProvider,
  komootProvider,
  genericWebProvider, // must stay last
];

export function providerFor(url: URL): SourceProvider {
  return SOURCE_PROVIDERS.find((p) => p.matches(url)) ?? genericWebProvider;
}
