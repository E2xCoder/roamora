import "server-only";
import { looseTextToOsmSyntax, type HoursScope } from "@/server/services/fact-extraction";

/**
 * Purpose-built verification layer for LLM-extracted opening hours.
 *
 * `looseTextToOsmSyntax` (fact-extraction.ts) answers one question: is this
 * string *shaped* like valid opening-hours syntax (real day names, real time
 * ranges, no contradictions)? That is necessary but not sufficient — a real
 * page's crowd-calendar widget or a stale "today is Monday" date stamp can be
 * shaped exactly like real hours text while being entirely the wrong content
 * (both are real, live-observed extraction failures; see the regression
 * tests). This module adds the semantic layer: is the extracted text
 * actually hours-shaped *and* actually present in the source *and* not one
 * of the known non-hours shapes it happens to resemble, and — separately —
 * what should be done with a "closed" / "by appointment" / "today only"
 * classification the model reported.
 *
 * Deliberately conservative: every check here can only turn a "yes" into a
 * "no" (unknown/rejected), never the reverse. A missed hallucination is bad;
 * an over-eager rejection just leaves a stop's hours unverified, which is
 * the system's existing, safe default state.
 */

export type OpeningHoursGuardResult =
  | { status: "specific-hours"; osmSyntax: string }
  | { status: "closed" }
  | { status: "by-appointment" }
  // The source stated hours for "today" specifically, not "every day" — this
  // is never converted into a same-day-of-week hard constraint unless the
  // caller can independently confirm the page was fetched for the exact
  // trip date, which no caller in this codebase currently tracks. It is
  // reported, not discarded, so a caller that gains that context later can
  // use it — today it is always treated as "unknown" for scheduling.
  | { status: "today-only"; rawText: string }
  | { status: "unknown"; reason: string };

/** DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, or a bare 4-digit year — a calendar date, not a time. */
const DATE_STAMP_RE = /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b(19|20)\d{2}\b/;

/**
 * Crowd-calendar / "best time to visit" widget vocabulary, multilingual.
 * Real regression case: a Hagia Sophia page's crowd-calendar legend
 * ("Hoş/Kalabalık/Çok Kalabalık/Kapalı" — Nice/Crowded/Very Crowded/Closed)
 * was extracted as if it were the day/hours line sitting near it on the page.
 */
const CROWD_VOCAB = [
  // Turkish
  "kalabalık", "yoğun", "sakin", "hoş",
  // English
  "crowded", "busy", "quiet", "best time",
  // German
  "besucherzahlen", "andrang", "stoßzeiten",
  // French
  "affluence", "fréquentation",
  // Polish
  "tłok", "kolejki",
];

/** "by appointment" / "on request", multilingual — a real absence of fixed hours, not a parse failure. */
const BY_APPOINTMENT_RE =
  /\b(by appointment|on request|nach vereinbarung|auf anfrage|sur rendez-vous|na umówione spotkanie|randevu ile|randevuyla)\b/i;

/** "closed" / "permanently closed" / "closed for renovation", multilingual. */
const CLOSED_RE =
  /\b(permanently closed|temporarily closed|closed for renovation|geschlossen|fermé définitivement|fermé pour rénovation|nieczynne|zamknięte|kapalı|kapatıldı)\b/i;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifies the extracted string's substance actually appears in the fetched
 * source text, rather than being invented outright. Deliberately fuzzy
 * (normalized substring, not exact match) since the model may reformat
 * whitespace/punctuation slightly — but a genuine hallucination-from-nothing
 * has no matching substring at all, which this reliably catches. It does
 * NOT catch "real text, wrong context" (the Hagia Sophia case) — that needs
 * the crowd-vocabulary and date-stamp checks below instead, since the text
 * there genuinely is present in the source, just the wrong part of it.
 */
export function isSupportedBySource(extractedText: string, sourceText: string): boolean {
  const needle = normalize(extractedText);
  const haystack = normalize(sourceText);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  // Allow minor whitespace/punctuation drift: compare the digit sequence
  // alone (e.g. "9:00-17:00" vs "9.00 - 17.00" should still count as
  // supported) as a fallback when the exact substring isn't found.
  const needleDigits = needle.replace(/\D+/g, "");
  if (needleDigits.length >= 3 && haystack.replace(/\D+/g, "").includes(needleDigits)) return true;

  return false;
}

function crowdVocabScore(text: string): number {
  const n = normalize(text);
  return CROWD_VOCAB.filter((word) => n.includes(word)).length;
}

/**
 * The single entry point: takes what the model extracted (its raw hours
 * text and its own `hoursScope` classification) plus the source page text
 * it was extracted from, and returns a verdict a caller can act on directly.
 */
export function validateExtractedOpeningHours(
  extractedText: string | null,
  hoursScope: HoursScope | null,
  sourceText: string
): OpeningHoursGuardResult {
  if (hoursScope === "closed") return { status: "closed" };
  if (hoursScope === "by-appointment") return { status: "by-appointment" };
  if (hoursScope === "today") {
    return { status: "today-only", rawText: extractedText ?? "" };
  }

  if (!extractedText || !extractedText.trim()) {
    return { status: "unknown", reason: "boş çıkarım" };
  }
  const trimmed = extractedText.trim();

  // A model can also state closed/appointment status directly in the text
  // even when hoursScope came back null/unclear (schema field is new; older
  // or less careful model output may still say it in the text itself).
  if (CLOSED_RE.test(trimmed)) return { status: "closed" };
  if (BY_APPOINTMENT_RE.test(trimmed)) return { status: "by-appointment" };

  if (DATE_STAMP_RE.test(trimmed)) {
    return { status: "unknown", reason: "bu bir tarih damgası gibi görünüyor, açılış saati değil" };
  }

  const crowdScore = crowdVocabScore(trimmed);
  if (crowdScore > 0) {
    return {
      status: "unknown",
      reason: "kalabalık takvimi / ziyaret zamanı widget'ı diline benziyor, açılış saati değil",
    };
  }

  if (!isSupportedBySource(trimmed, sourceText)) {
    return { status: "unknown", reason: "çıkarılan metin kaynak sayfada bulunamadı" };
  }

  // hoursScope === "daily": the source explicitly said every day — apply
  // confidently even without a day name in the text (the qualifier is
  // routinely stripped by the model along with the day mention).
  if (hoursScope === "daily") {
    const osmSyntax = looseTextToOsmSyntax(trimmed);
    if (!osmSyntax) return { status: "unknown", reason: "günlük saat metni ayrıştırılamadı" };
    return { status: "specific-hours", osmSyntax };
  }

  // hoursScope === "specific-days" / "unclear" / null: fall through to the
  // structural day+time parser. If it finds real day names, use them; if it
  // finds none, this is now treated as unknown rather than guessed as daily
  // — hoursScope is what used to carry that signal (see fact-extraction.ts),
  // and here it's absent or non-committal, so guessing would be exactly the
  // kind of unsupported inference this guard exists to avoid.
  const osmSyntax = looseTextToOsmSyntax(trimmed);
  if (!osmSyntax) {
    return { status: "unknown", reason: "yapısal olarak geçerli bir gün/saat kalıbı bulunamadı" };
  }
  if (osmSyntax.startsWith("Mo-Su ")) {
    // looseTextToOsmSyntax's own day-less default is "Mo-Su"; reaching this
    // branch means hoursScope was NOT "daily" (that case already returned
    // above), so an explicit "every day" classification from the model was
    // never given — that default is a guess this guard does not forward as
    // a confident constraint.
    return { status: "unknown", reason: "gün belirtilmemiş ve model bunu 'her gün' olarak sınıflandırmadı" };
  }
  return { status: "specific-hours", osmSyntax };
}
