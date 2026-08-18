import "server-only";
import type { LocationSource } from "@/lib/taxonomy";

/**
 * Location extraction from free text.
 *
 * Strategies are ordered by trustworthiness, and each candidate carries the
 * strategy that produced it plus a base confidence. Nothing here contacts a
 * geocoder — this stage only proposes *names*; verification happens later, so
 * the two concerns stay testable in isolation.
 */

export interface LocationCandidate {
  name: string;
  source: LocationSource;
  /** Confidence before geocoding corroborates or refutes it. */
  confidence: number;
  strategy: string;
}

/** Pin emoji and friends are the strongest textual signal on social posts. */
const PIN_PATTERNS: Array<{ re: RegExp; confidence: number; strategy: string }> = [
  { re: /📍\s*([^,\n#@|·•]{2,60})/u, confidence: 0.72, strategy: "pin-emoji" },
  { re: /📌\s*([^,\n#@|·•]{2,60})/u, confidence: 0.72, strategy: "pin-emoji" },
  { re: /🗺️?\s*([^,\n#@|·•]{2,60})/u, confidence: 0.6, strategy: "map-emoji" },
  {
    re: /(?:^|\s)(?:location|konum|yer|lugar|ort)\s*[:：]\s*([^,\n#@|]{2,60})/iu,
    confidence: 0.7,
    strategy: "labelled",
  },
  {
    re: /(?:^|\s)(?:at|@)\s+([A-ZÀ-ÿĞÜŞİÖÇ][^,\n#@|]{2,50})/u,
    confidence: 0.45,
    strategy: "preposition",
  },
  {
    re: /(?:^|\s)(?:in|visit|explore|discover)\s+([A-ZÀ-ÿĞÜŞİÖÇ][^,\n#@|]{2,50})/iu,
    confidence: 0.4,
    strategy: "preposition",
  },
];

/** Hashtags that are almost never a place. */
const HASHTAG_STOPWORDS = new Set([
  "travel", "traveling", "travelling", "traveltok", "traveltiktok", "fyp",
  "foryou", "foryoupage", "viral", "trending", "explore", "explorepage",
  "reels", "reel", "shorts", "tiktok", "instagram", "food", "foodie",
  "vlog", "vlogger", "adventure", "wanderlust", "nature", "photography",
  "summer", "winter", "vacation", "holiday", "trip", "tour", "gezi",
  "seyahat", "tatil", "keşfet", "kesfet", "beautiful", "amazing", "love",
]);

export function extractLocationCandidates(text: string): LocationCandidate[] {
  if (!text?.trim()) return [];

  const candidates: LocationCandidate[] = [];
  const seen = new Set<string>();

  const push = (raw: string, confidence: number, strategy: string, source: LocationSource) => {
    const name = cleanName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ name, confidence, strategy, source });
  };

  // 1. Explicit markers.
  for (const { re, confidence, strategy } of PIN_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) push(m[1], confidence, strategy, "TEXT");
  }

  // 2. Multi-word capitalised phrases — "Charles Bridge", "Letná Park".
  for (const phrase of properNounPhrases(text)) {
    push(phrase, 0.35, "proper-noun", "TEXT");
  }

  // 3. Hashtags, after removing the generic travel vocabulary.
  for (const tag of text.matchAll(/#([\p{L}\p{N}_]{3,40})/gu)) {
    const word = tag[1];
    if (HASHTAG_STOPWORDS.has(word.toLowerCase())) continue;
    if (/^\d+$/.test(word)) continue;
    push(splitCamelCase(word), 0.25, "hashtag", "TEXT");
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

/**
 * Sequences of capitalised words, which is how most landmarks are written.
 * Deliberately conservative: a single capitalised word is usually a sentence
 * start, not a place.
 */
function properNounPhrases(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b([A-ZÀ-ÿĞÜŞİÖÇ][\p{Ll}'’-]{1,}(?:\s+(?:of|de|del|la|le|van|von|der|den|di|da)\s+|\s+)[A-ZÀ-ÿĞÜŞİÖÇ][\p{Ll}'’-]{1,}(?:\s+[A-ZÀ-ÿĞÜŞİÖÇ][\p{Ll}'’-]{1,})?)/gu;

  for (const m of text.matchAll(re)) out.push(m[1]);
  return out.slice(0, 6);
}

function splitCamelCase(input: string): string {
  return input
    .replace(/_/g, " ")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .trim();
}

function cleanName(raw: string): string | null {
  const name = raw
    .replace(/[|·•]+/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, "")
    .trim();

  if (name.length < 2 || name.length > 80) return null;
  // Reject strings that are mostly punctuation or digits.
  if (!/\p{L}/u.test(name)) return null;
  if ((name.match(/\d/g)?.length ?? 0) > name.length / 2) return null;
  return name;
}

/**
 * Combines a candidate's textual confidence with what geocoding found.
 *
 * A geocoder hit corroborates the guess; a miss is evidence against it. The
 * result is clamped so nothing reaches certainty on text alone.
 */
export function combineConfidence(
  textConfidence: number,
  geocoded: boolean,
  explicitCoordinates = false
): number {
  if (explicitCoordinates) return 0.97;
  if (!geocoded) return Math.min(textConfidence * 0.45, 0.35);
  return Math.min(textConfidence + 0.3, 0.93);
}
