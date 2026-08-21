import "server-only";

/**
 * Evidence-based confidence scoring for web-research-derived facts.
 *
 * Replaces the previous flat model, where `extractFactsFromText` always
 * reported `"medium"` and `autoplan.ts` always downgraded anything
 * web-sourced to `"low"` regardless of how strong the actual evidence was —
 * a real official page with an exact, textually-supported price got the
 * same confidence as a third-party blog's vague guess. Neither carried any
 * information a user could act on.
 *
 * Four levels, matching real distinctions this pipeline can actually make:
 *   HIGH    — official source, fact clearly and unambiguously stated, not stale
 *   MEDIUM  — official source but ambiguous/stale, OR independent third-party
 *             sources agreeing with each other
 *   LOW     — third-party source, single-source, no corroboration
 *   UNKNOWN — the fact is not actually supported by the fetched source text
 *             at all (a hallucination-shaped result, or nothing found)
 *
 * OSM tag data never goes through this scorer — a community-maintained
 * structured tag is a categorically different kind of evidence from free
 * text on a webpage, and is treated as HIGH directly at the call site.
 */

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export interface ConfidenceSignals {
  /** The source text was not just present but textually supports the extracted fact (see opening-hours-guard's isSupportedBySource). */
  textuallySupported: boolean;
  /** The source page appears to be the place's own official site, not a reseller/aggregator/travel blog. */
  officialSource: boolean;
  /** The extraction itself was ambiguous — e.g. hoursScope was null/"unclear", or the guard rejected/could not cleanly resolve it. */
  extractionAmbiguous: boolean;
  /** An explicit "updated in <old year>" marker was found near the fact. */
  stale: boolean;
  /**
   * Whether a second, independent source was checked and what it found.
   * `null` = no second source was checked (single-source result).
   * `true` = a second source was checked and agrees.
   * `false` = a second source was checked and disagrees.
   */
  multiSourceAgreement: boolean | null;
}

export function scoreConfidence(signals: ConfidenceSignals): ConfidenceLevel {
  if (!signals.textuallySupported) return "unknown";

  if (signals.multiSourceAgreement === false) {
    // Two independent sources actually conflict — real uncertainty, capped
    // at low regardless of how official either individually looked.
    return "low";
  }

  if (signals.officialSource) {
    if (!signals.extractionAmbiguous && !signals.stale) return "high";
    return "medium";
  }

  // Third-party source.
  if (signals.multiSourceAgreement === true && !signals.extractionAmbiguous && !signals.stale) {
    return "medium"; // independent corroboration compensates for not being official
  }
  return "low";
}

const OFFICIAL_TITLE_WORDS = /\b(official|offizielle?|officiel(le)?|oficjaln[ay]|resmi)\b/i;

/**
 * Marketplace/reseller/aggregator hostname patterns — a strong negative
 * signal that overrides an "official"-sounding title, since resellers
 * routinely use that word in their own marketing copy too. Real example:
 * "hagia-sophia-tickets.com" is a third-party ticket reseller, not Hagia
 * Sophia's own site, despite ranking first for a plain hours query.
 */
const THIRD_PARTY_HOSTNAME_MARKERS = [
  "tickets", "-guide", "travelguide", "tripadvisor", "getyourguide", "viator",
  "booking", "expedia", "yelp", "opentable", "speisekarte", "reiseführer",
];

/**
 * Best-effort, deliberately conservative "is this the place's own site"
 * heuristic. False negatives (missing a real official site, e.g. a national
 * museum's own domain not sharing a slug with one specific gallery's name)
 * are the safer failure direction here than false positives, since
 * overclaiming "official" inflates confidence a user might actually rely on.
 */
export function isOfficialSource(url: string, resultTitle: string, placeName: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  if (THIRD_PARTY_HOSTNAME_MARKERS.some((marker) => hostname.includes(marker))) {
    return false;
  }

  const slug = placeName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (post-NFKD combining marks)
    .replace(/[^a-z0-9]/g, "");
  const hostSlug = hostname.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/g, "");
  // Bidirectional: a place name often carries extra qualifying words a
  // domain omits (real case: "Brama Poznania ICHOT" -> hostname
  // "bramapoznania.pl" — the domain is a genuine substring of the *place*
  // name, not the other way around, which a one-directional check missed).
  const [shorter, longer] = slug.length <= hostSlug.length ? [slug, hostSlug] : [hostSlug, slug];
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  return OFFICIAL_TITLE_WORDS.test(resultTitle);
}

const STALE_MARKER_RE =
  /\b(updated|aktualisiert|mis à jour|zaktualizowano|güncellendi|last updated|stand)\b[^.\n]{0,30}\b((19|20)\d{2})\b/i;

/**
 * Flags an explicit "last updated <year>" style marker naming a year more
 * than one calendar year old near the extracted fact. Deliberately does NOT
 * treat the mere absence of any date as stale — undated content is the norm
 * for most real pages and penalizing it would just make everything "low".
 */
export function detectStaleness(sourceText: string, now: Date = new Date()): boolean {
  const match = sourceText.match(STALE_MARKER_RE);
  if (!match) return false;
  const year = Number(match[2]);
  return now.getFullYear() - year > 1;
}
