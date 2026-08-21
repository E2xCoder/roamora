import "server-only";

/**
 * Shared, rate-limited Wikipedia API client.
 *
 * Extracted out of the image provider so a second caller (place-description
 * lookup, added alongside autonomous discovery) shares the same throttle and
 * backoff state. Two callers each enforcing "1 request/sec" independently
 * still adds up to 2 requests/sec against Wikimedia — which is exactly the
 * class of bug already hit once this session (a 250 ms interval that looked
 * conservative in isolation earned a sustained 429). One client, one clock.
 */

const API = "https://en.wikipedia.org/w/api.php";
const MIN_INTERVAL_MS = 1000;
const BACKOFF_MS = 60_000;

let lastRequestAt = 0;
let backoffUntil = 0;

export class WikipediaUnavailable extends Error {}

async function throttle() {
  const now = Date.now();
  if (now < backoffUntil) {
    throw new WikipediaUnavailable(
      `Wikipedia hız sınırı — ${Math.ceil((backoffUntil - now) / 1000)} sn sonra tekrar denenebilir`
    );
  }

  const since = now - lastRequestAt;
  if (since < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
  }
  lastRequestAt = Date.now();
}

export async function wikipediaFetch(params: Record<string, string>): Promise<unknown> {
  await throttle();
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Roamora/1.0 (personal travel planner; https://github.com/E2xCoder/roamora)",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 429) {
      backoffUntil = Date.now() + BACKOFF_MS;
      throw new WikipediaUnavailable("Wikipedia hız sınırı (429)");
    }
    if (res.status >= 500) throw new WikipediaUnavailable(`Wikipedia ${res.status}`);
    if (!res.ok) return null;

    return await res.json();
  } catch (err) {
    if (err instanceof WikipediaUnavailable) throw err;
    throw new WikipediaUnavailable(
      err instanceof Error ? err.message : "request failed"
    );
  }
}

export function wikipediaCoolingOff(): number {
  return Math.max(0, backoffUntil - Date.now());
}

export interface WikiPage {
  pageid: number;
  title: string;
  thumbnail?: { source: string };
  coordinates?: Array<{ lat: number; lon: number }>;
  extract?: string;
}

export function wikiPagesOf(payload: unknown): WikiPage[] {
  const query = (payload as { query?: { pages?: Record<string, WikiPage> } })?.query;
  return query?.pages ? Object.values(query.pages) : [];
}

/** Articles that are never a photo/description of one specific place. */
const NON_PLACE_TITLE =
  /^(list of |lists of |index of |outline of |timeline of )|\(disambiguation\)|^category:/i;

export function isWikiPlaceArticle(title: string): boolean {
  return !NON_PLACE_TITLE.test(title);
}

/** Loose containment check — "Mürren" should match "Mürren, Switzerland". */
export function wikiTitlesRelated(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
