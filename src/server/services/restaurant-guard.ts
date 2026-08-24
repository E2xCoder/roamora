import "server-only";
import { isSupportedBySource } from "@/server/services/opening-hours-guard";

/**
 * Deterministic verification layer for restaurant/menu research — the
 * restaurant counterpart to opening-hours-guard.ts and price-guard.ts.
 * Per-item prices still go through the existing price-guard.ts (a menu
 * item's price is not a different kind of claim than an attraction's ticket
 * price); this module adds the two checks that guard has no notion of:
 * whether an extracted menu item's *name* is actually present on the source
 * page at all (never invented), and two purely evidence-based, deliberately
 * bounded scorers — queue/wait signal and tourist-trap risk — built only
 * from keyword patterns in already-fetched real text, never guessed or
 * invented by an LLM.
 */

/** Rejects a menu item whose name has no textual support in the source at all — same discipline as opening-hours-guard's isSupportedBySource. */
export function isMenuItemNameSupported(itemName: string, sourceText: string): boolean {
  return isSupportedBySource(itemName, sourceText);
}

const NAV_LABEL_EXACT = new Set([
  "menu", "full menu", "our menu", "see menu", "download menu",
  "order now", "book now", "reserve now", "reserve a table", "book a table", "buy now",
  "add to cart", "add to basket", "learn more", "read more", "see more", "click here", "shop now",
  "sign in", "log in", "sign up", "register", "checkout", "cart", "basket",
  "home", "about", "about us", "contact", "contact us", "gallery", "reservations", "reservation",
  "location", "locations", "hours", "opening hours", "directions", "faq", "careers", "jobs",
  "privacy policy", "terms of service", "terms & conditions", "cookie policy",
  // Real, live-observed case: a restaurant site's mobile-nav menu-TOGGLE
  // button ("Hamburger Toggle Menu") was extracted as if "Hamburger" were a
  // dish — the icon's own common name is a false positive precisely because
  // it is also a real food word.
  "hamburger", "hamburger menu", "hamburger toggle menu", "toggle menu", "toggle navigation",
  // multilingual, matching the codebase's existing multilingual practice
  "speisekarte ansehen", "jetzt bestellen", "tisch reservieren", // German
  "zobacz menu", "zamów teraz", "zarezerwuj stolik", // Polish
  "menüyü görüntüle", "şimdi sipariş ver", // Turkish
]);

const GENERIC_MENU_LABEL_RE = /^(the\s+)?(food|drinks?|members?|home|main|full|our|view|see|download|order|online)\s+menu$/;
const CUISINE_LABEL_RE = /^[a-z][a-z-]*\s+cuisine$/;
const CTA_RE = /^(order|book|reserve|buy|add|view|see|click|read|shop|learn|download|sign|log)\b.*\b(now|more|here|in|up)$/;

/**
 * Rejects an extracted "menu item" that is really a navigation label, a
 * menu-section/category link, a button, or generic UI text — real,
 * live-observed failure: a real official menu page
 * (fulumandarijn.com/menu) is itself a landing/navigation hub linking out
 * to separate sub-pages, and the model extracted its nav labels ("Food
 * Menu", "Drink Menu", "Member Menu", "Home Menu") as if they were dish
 * names. `isMenuItemNameSupported` alone cannot catch this — the text IS
 * genuinely present on the page, it just isn't a dish.
 *
 * Deliberately narrow and pattern-based rather than a vague "looks
 * generic" heuristic, so a real short dish name ("Fries", "Coffee") or a
 * real prix-fixe item ("Tasting Menu", "Chef's Menu", "Kids Menu" — all
 * genuinely orderable, often individually priced) is never rejected.
 */
export function isLikelyNavigationLabel(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;

  if (NAV_LABEL_EXACT.has(normalized)) return true;

  // "<generic qualifier> menu" — e.g. "Food Menu", "Drink Menu", "View
  // Menu", "Member Menu", "Home Menu" — a category/nav link, never a real
  // dish name. Curated qualifier list rather than a blanket "-menu"
  // suffix rule, since a bare suffix rule would also reject genuinely
  // orderable items like "Tasting Menu" or "Chef's Menu".
  if (GENERIC_MENU_LABEL_RE.test(normalized)) return true;

  // A bare "<style/nationality> Cuisine" label ("Sichuan Cuisine",
  // "Italian Cuisine") is a category tag, never a specific dish — unlike
  // "menu", no real menu item is ever named just "X Cuisine".
  if (CUISINE_LABEL_RE.test(normalized)) return true;

  // Call-to-action phrasing: a verb the page uses to prompt an action,
  // not a food/drink name.
  if (CTA_RE.test(normalized)) return true;

  return false;
}

export type QueueConfidence = "low" | "medium";

export interface QueueEstimate {
  /** Human-readable band, never a fabricated exact figure. */
  range: string;
  confidence: QueueConfidence;
  reservationRecommended: boolean;
  /** The matched phrases that produced this estimate, for transparency. */
  evidence: string[];
}

/**
 * Multilingual review/page-text vocabulary indicating a real queue/wait
 * pattern. Grouped so a single strong phrase ("expect to queue") counts the
 * same as it should, without needing an exact-count threshold tuned per
 * language.
 */
const QUEUE_PHRASES: Array<{ phrase: string; kind: "queue" | "busy" | "reservation" | "slow" }> = [
  // English
  { phrase: "long queue", kind: "queue" },
  { phrase: "long line", kind: "queue" },
  { phrase: "queue outside", kind: "queue" },
  { phrase: "wait for a table", kind: "queue" },
  { phrase: "expect to wait", kind: "queue" },
  { phrase: "always busy", kind: "busy" },
  { phrase: "very busy", kind: "busy" },
  { phrase: "book ahead", kind: "reservation" },
  { phrase: "reservation recommended", kind: "reservation" },
  { phrase: "reservations essential", kind: "reservation" },
  { phrase: "slow service", kind: "slow" },
  { phrase: "understaffed", kind: "slow" },
  // German
  { phrase: "lange schlange", kind: "queue" },
  { phrase: "warteschlange", kind: "queue" },
  { phrase: "reservierung empfohlen", kind: "reservation" },
  { phrase: "sehr voll", kind: "busy" },
  { phrase: "langsamer service", kind: "slow" },
  // French
  { phrase: "longue file", kind: "queue" },
  { phrase: "réservation recommandée", kind: "reservation" },
  { phrase: "service lent", kind: "slow" },
  // Polish
  { phrase: "długa kolejka", kind: "queue" },
  { phrase: "trzeba czekać", kind: "queue" },
  { phrase: "zalecana rezerwacja", kind: "reservation" },
  { phrase: "wolna obsługa", kind: "slow" },
  // Czech
  { phrase: "dlouhá fronta", kind: "queue" },
  { phrase: "doporučujeme rezervaci", kind: "reservation" },
  // Dutch
  { phrase: "lange wachtrij", kind: "queue" },
  { phrase: "reservering aanbevolen", kind: "reservation" },
  // Turkish
  { phrase: "uzun kuyruk", kind: "queue" },
  { phrase: "rezervasyon önerilir", kind: "reservation" },
  { phrase: "yavaş servis", kind: "slow" },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics left by NFKD (ü -> u, ó -> o, ş -> s, ...)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scans already-fetched real page/review text for repeated queue/busy/
 * reservation/slow-service patterns and reports an estimated *range*, never
 * an invented exact minute figure — confidence is capped at "medium" since
 * this is inherently soft evidence extracted from free text, not a measured
 * fact. Returns null when there is no real evidence at all (silence, not a
 * guessed "probably fine").
 */
export function estimateQueueSignal(sourceText: string): QueueEstimate | null {
  const normalized = normalize(sourceText);
  const matched = QUEUE_PHRASES.filter((p) => normalized.includes(normalize(p.phrase)));
  if (matched.length === 0) return null;

  const reservationRecommended = matched.some((m) => m.kind === "reservation");
  const strength = new Set(matched.map((m) => m.kind)).size; // distinct signal kinds, not raw phrase count

  let range: string;
  let confidence: QueueConfidence;
  if (strength === 1) {
    range = "10-20 dakika bekleme olası";
    confidence = "low";
  } else if (strength === 2) {
    range = "20-40 dakika bekleme olası, özellikle yoğun saatlerde";
    confidence = "medium";
  } else {
    range = "40+ dakika bekleme olası ya da rezervasyon gerekebilir";
    confidence = "medium";
  }

  return {
    range,
    confidence,
    reservationRecommended,
    evidence: matched.map((m) => m.phrase),
  };
}

export type TouristTrapRisk = "LOW" | "MEDIUM" | "HIGH";

export interface TouristTrapAssessment {
  risk: TouristTrapRisk;
  reasons: string[];
}

/** Real, multilingual red-flag phrases — a page/review explicitly calling out overpricing or a "tourist menu". */
const TRAP_NEGATIVE_PHRASES = [
  "tourist trap", "overpriced", "avoid this place", "rip off", "ripoff",
  "touristenfalle", "überteuert", "abzocke",
  "piège à touristes", "trop cher", "arnaque",
  "pułapka na turystów", "przepłacony",
  "turist tuzağı", "aşırı pahalı",
  "tourist menu", "touristenmenü", "menù turistico", "menu turystyczne",
];

/** Real, multilingual authenticity-signal phrases — a page/review explicitly framing the place as where locals actually eat. */
const AUTHENTICITY_POSITIVE_PHRASES = [
  "local favorite", "where locals eat", "hidden gem", "off the beaten path", "authentic",
  "lokaler favorit", "einheimische", "authentisch",
  "favori des locaux", "authentique",
  "lokalny favoryt", "autentyczn",
  "yerli halkın", "otantik",
];

/**
 * Deterministic, evidence-based tourist-trap scoring — never rejects a place
 * for being famous (fame is not evidence of being a trap on its own; the
 * spec is explicit about this), only for real textual signals found in the
 * actual fetched source. Absence of any signal at all reports LOW, not
 * UNKNOWN — "no evidence of being a trap" is itself informative and is not
 * the same claim as "verified authentic", which the reasons array makes
 * clear by staying empty in that case.
 */
export function scoreTouristTrapRisk(sourceText: string, isOfficialSource: boolean): TouristTrapAssessment {
  const normalized = normalize(sourceText);
  const negativeHits = TRAP_NEGATIVE_PHRASES.filter((p) => normalized.includes(normalize(p)));
  const positiveHits = AUTHENTICITY_POSITIVE_PHRASES.filter((p) => normalized.includes(normalize(p)));

  const reasons: string[] = [];
  for (const hit of negativeHits) reasons.push(`kaynak metinde olumsuz sinyal: "${hit}"`);
  for (const hit of positiveHits) reasons.push(`kaynak metinde özgünlük sinyali: "${hit}"`);

  // A dedicated "tourist menu" mention is a strong, unambiguous signal on its
  // own — the phrase directly describes the thing being asked about.
  const hasTouristMenu = ["tourist menu", "touristenmenü", "menù turistico", "menu turystyczne"].some((p) =>
    normalized.includes(normalize(p))
  );

  if (negativeHits.length >= 2 || (negativeHits.length >= 1 && hasTouristMenu)) {
    return { risk: "HIGH", reasons };
  }
  if (negativeHits.length === 1) {
    return { risk: "MEDIUM", reasons };
  }
  if (positiveHits.length > 0 || isOfficialSource) {
    return { risk: "LOW", reasons };
  }
  return { risk: "LOW", reasons: [] }; // no real evidence either way — reported plainly, not inflated
}
