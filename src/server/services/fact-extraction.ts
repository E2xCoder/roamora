import "server-only";
import { z } from "zod";
import { config } from "@/server/config";

/**
 * Structured-fact extraction from unstructured web page text.
 *
 * The LLM's role here is narrow and specific (spec §63): read a page of real
 * text and extract facts it actually contains, returning nothing when it
 * finds nothing. It never invents a price or a time — a malformed or
 * implausible response is discarded, not repaired or guessed at.
 *
 * Confidence is capped at "medium": this is free-text extraction from an
 * arbitrary web page, not a verified official source with a checked date, so
 * "high" confidence is never claimed by this path regardless of how the model
 * phrases its answer.
 */

export class ExtractionUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtractionUnavailableError";
    this.code = code;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * Strips a raw HTML page down to its visible text.
 *
 * `fetchTextCapped` deliberately returns raw HTML (other callers, e.g. the
 * import pipeline's meta-tag reader, need the markup) — but feeding that raw
 * HTML straight into the extraction prompt was a real, measured bug: a real
 * page's `<head>` (meta tags, hreflang links, inline CSS/JS) routinely runs
 * to 10,000+ characters before any visible body text starts, so slicing the
 * first 4000 raw characters — as this module used to do — could hand the
 * model nothing but boilerplate and never reach the actual opening-hours or
 * price text at all. Confirmed directly against a real page (a Poznań
 * museum's site): its "GODZINY OTWARCIA" heading sat at byte 51,422, far
 * outside that old 4000-character raw-HTML window.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => HTML_ENTITIES[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How the source text stated its hours — asked for explicitly rather than
 * inferred from the absence of a day name in `openingHoursText`.
 *
 * The model routinely strips the qualifying word along with the day when it
 * extracts just the hours ("täglich von 9 bis 17 Uhr" -> "9 bis 17 Uhr",
 * "Ouvert aujourd'hui 09:00 - 00:00" -> "09:00 - 00:00") — by the time
 * `openingHoursText` reaches any downstream code, "every day" and "today
 * only" are textually indistinguishable. Those are not the same claim: a
 * museum's hours stated for "today" may differ from its hours on other days
 * (a holiday, a special exhibition, a reduced-hours weekday), so treating
 * every day-less extraction as "daily" — which an earlier version of this
 * module did — is a real, if usually harmless, guess. Asking the model to
 * classify which case it actually saw removes the guess.
 */
const HOURS_SCOPES = ["daily", "today", "specific-days", "closed", "by-appointment", "unclear"] as const;
export type HoursScope = (typeof HOURS_SCOPES)[number];

const factsSchema = z.object({
  openingHoursText: z.string().max(200).nullable(),
  hoursScope: z.enum(HOURS_SCOPES).nullable(),
  priceAmount: z.number().min(0).max(100_000).nullable(),
  priceCurrency: z.string().max(6).nullable(),
  /** True only when the model is confident the page discusses THIS place. */
  aboutThisPlace: z.boolean(),
});

export type ExtractedFacts = z.infer<typeof factsSchema>;

export interface FactExtractionResult {
  facts: ExtractedFacts;
  confidence: "medium";
}

/**
 * Exported for reuse by other extraction paths (event-extraction.ts,
 * restaurant-extraction.ts) that need the same Ollama call/error handling
 * without duplicating it.
 *
 * `maxTokens` defaults to 200 — enough for a single hours/price fact, this
 * function's original use. Real, live-observed bug: extractMenuFromText and
 * extractEventListFromText reused that same 200-token cap for a LIST of up
 * to 20 items, which silently truncated the model's JSON mid-array on every
 * real multi-item menu tested (confirmed directly: a real German menu page
 * with genuinely extractable content produced a 629-character response
 * cut off mid-object, failing JSON.parse and — correctly, safely, but
 * uselessly — falling through to "no items found" rather than fabricating
 * anything). List-style callers must pass a larger budget explicitly.
 */
export async function callOllama(prompt: string, maxTokens = 200): Promise<string> {
  const res = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: maxTokens },
    }),
    // A larger token budget takes proportionally longer to generate — the
    // original flat 30s timeout was sized for a 200-token single-fact
    // response and would itself cut off a genuinely longer list response.
    signal: AbortSignal.timeout(Math.max(30_000, maxTokens * 100)),
  });

  if (!res.ok) {
    throw new ExtractionUnavailableError(
      "AI_HTTP_ERROR",
      `Ollama ${res.status} döndürdü (${config.OLLAMA_BASE_URL}).`
    );
  }

  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

/**
 * Extracts opening hours and price from a page's plain text, for one named
 * place. Returns `null` when the model finds nothing usable or its output
 * fails schema validation — never a best-effort guess.
 */
export async function extractFactsFromText(
  placeName: string,
  pageText: string
): Promise<FactExtractionResult | null> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError(
      "AI_DISABLED",
      "AI sağlayıcı devre dışı (AI_PROVIDER=none)."
    );
  }

  const trimmed = htmlToPlainText(pageText).slice(0, 4000).trim();
  if (!trimmed) return null;

  const prompt = `You are reading a web page about travel destinations. Find facts specifically about this place: "${placeName}".

Page text:
"""
${trimmed}
"""

Return ONLY a JSON object with this exact shape, no other text:
{
  "openingHoursText": "<the opening hours as literally stated, e.g. 'Mon-Fri 9:00-17:00', or null if not found>",
  "hoursScope": "<one of: 'daily' (text says every day / daily / täglich / tous les jours / codziennie / her gün), 'today' (text says only 'today' / 'aujourd'hui' / 'heute' / 'bugün', with no claim about other days), 'specific-days' (text names particular days or a day range), 'closed' (text says this place is closed / permanently closed / closed for renovation), 'by-appointment' (text says visits are by appointment / on request only, no fixed hours), 'unclear' (hours are mentioned but which of the above applies is not clear), or null if no hours information was found at all>",
  "priceAmount": <numeric ticket/entry price if stated, or null>,
  "priceCurrency": "<currency code or symbol as stated, or null>",
  "aboutThisPlace": <true only if this page text is actually about "${placeName}", false otherwise>
}

Do not guess. If a fact is not clearly stated in the text, use null for it.`;

  let raw: string;
  try {
    raw = await callOllama(prompt);
  } catch (err) {
    if (err instanceof ExtractionUnavailableError) throw err;
    throw new ExtractionUnavailableError(
      "AI_UNREACHABLE",
      `Ollama'ya ulaşılamadı (${config.OLLAMA_BASE_URL}).`
    );
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const validated = factsSchema.safeParse(parsedJson);
  if (!validated.success) return null;
  if (!validated.data.aboutThisPlace) return null;
  if (
    validated.data.openingHoursText == null &&
    validated.data.hoursScope == null &&
    validated.data.priceAmount == null
  ) {
    return null; // nothing useful extracted
  }

  return { facts: validated.data, confidence: "medium" };
}

/**
 * Converts a free-text opening-hours statement extracted by the model (e.g.
 * "Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00") into OSM `opening_hours`
 * syntax, so it can be resolved by the same deterministic parser used for
 * real OSM tags.
 *
 * Multilingual: real pages state hours in whatever language the destination
 * speaks, and the model faithfully preserves that — an English-only day-name
 * table meant every non-English extraction, however textually correct,
 * silently failed to become a usable schedule constraint (measured live:
 * real German, French and Polish extractions all correct as text, 0/3 usable
 * downstream). Day names are matched per-language (English/German/French/
 * Polish/Turkish); the language whose dictionary matches the most day-tokens
 * in the string wins, which resolves genuinely ambiguous short tokens shared
 * across languages (e.g. "So" = Sonntag/Sunday in German, Sobota/Saturday in
 * Polish) by using the token's actual context rather than checking languages
 * in a fixed, guessable order.
 *
 * Daily-with-no-day-mentioned is supported deliberately: a real page saying
 * "täglich 9 bis 17 Uhr" / "ouvert aujourd'hui 09:00 - 00:00" has its "daily"
 * qualifier stripped by the model along with the day name, since the model is
 * asked for the *hours*, not a restatement of "every day" — by the time this
 * function sees it, the string is just a bare time range. A bare time range
 * with no day name found is therefore treated as "Mo-Su" rather than
 * rejected, matching what both real pages actually meant.
 *
 * Still deliberately conservative in the failure direction: if no time
 * pattern is found anywhere in the string, this returns null immediately,
 * regardless of how many day names are present — this is what rejects a
 * hallucinated day-list with no real hours (regression: a real extraction
 * over a Hagia Sophia "best time to visit" page returned a crowd-calendar
 * widget's day-abbreviation-plus-legend text, "Pzt Sal Çar Per Cum Cmt Paz
 * Hoş Kalabalık Çok Kalabalık Kapalı" — seven real Turkish day names, zero
 * digits). Likewise, a day-group (e.g. "Tu-Fr") that has no time range
 * immediately following it before the next day-group rejects the *entire*
 * result rather than emitting a partial, guessed schedule — a half-right
 * constraint fed to the optimizer is worse than an honestly-missing one.
 */

type OsmDay = "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su";
type DayMap = Record<string, OsmDay>;

const DAY_MAPS: Record<string, DayMap> = {
  english: {
    monday: "Mo", mon: "Mo",
    tuesday: "Tu", tue: "Tu", tues: "Tu",
    wednesday: "We", wed: "We",
    thursday: "Th", thu: "Th", thur: "Th", thurs: "Th",
    friday: "Fr", fri: "Fr",
    saturday: "Sa", sat: "Sa",
    sunday: "Su", sun: "Su",
  },
  german: {
    montag: "Mo", mo: "Mo",
    dienstag: "Tu", di: "Tu",
    mittwoch: "We", mi: "We",
    donnerstag: "Th", do: "Th",
    freitag: "Fr", fr: "Fr",
    samstag: "Sa", sonnabend: "Sa", sa: "Sa",
    sonntag: "Su", so: "Su",
  },
  french: {
    lundi: "Mo", lun: "Mo",
    mardi: "Tu", mar: "Tu",
    mercredi: "We", mer: "We",
    jeudi: "Th", jeu: "Th",
    vendredi: "Fr", ven: "Fr",
    samedi: "Sa", sam: "Sa",
    dimanche: "Su", dim: "Su",
  },
  polish: {
    poniedziałek: "Mo", poniedzialek: "Mo", pon: "Mo",
    wtorek: "Tu", wt: "Tu",
    środa: "We", sroda: "We", "śr": "We", sr: "We",
    czwartek: "Th", czw: "Th",
    piątek: "Fr", piatek: "Fr", pt: "Fr",
    sobota: "Sa", sob: "Sa", so: "Sa",
    niedziela: "Su", nd: "Su", ndz: "Su",
  },
  turkish: {
    pazartesi: "Mo", pzt: "Mo",
    "salı": "Tu", sali: "Tu", sal: "Tu",
    "çarşamba": "We", carsamba: "We", "çar": "We", car: "We",
    "perşembe": "Th", persembe: "Th", per: "Th",
    cuma: "Fr", cum: "Fr",
    cumartesi: "Sa", cmt: "Sa",
    pazar: "Su", paz: "Su",
  },
  // Real, live-observed gap: this project's primary real-data testbed
  // (Prague) had NO Czech day-name coverage at all, which produced a
  // silently WRONG result, not just an unknown one — a real museum's real
  // "Pondělí...Neděle" (Mon...Sun) hours table matched the POLISH map's
  // "sobota" (also a real, unrelated word meaning Saturday in Polish too)
  // as its single best match, converting a real Mon-Sun schedule into
  // "Sa 10:00-18:00" — Saturday only. `bestDayMatches` already picks
  // whichever language matches the MOST tokens; adding real Czech coverage
  // fixes this via that existing mechanism (7 real Czech matches beats
  // Polish's 1 accidental one) without changing any matching logic.
  czech: {
    "pondělí": "Mo", pondeli: "Mo", po: "Mo",
    "úterý": "Tu", utery: "Tu", "út": "Tu", ut: "Tu",
    // Czech is a declined language, and "do" (used as a day-range connector,
    // e.g. "pondělí do pátku") grammatically requires the GENITIVE case —
    // three of the seven day names change form there, not just case: real
    // case, "pondělí do pátku" ("Monday to Friday") uses "pátku", the
    // genitive of "pátek", never the nominative form itself. Adding the
    // genitive as one more surface form (same OSM code) needs no change to
    // the matching logic, same as this table already lists multiple real
    // spellings per day elsewhere (nominative "středa" alongside genitive
    // "středy", etc.). Abbreviations are not declined in real usage, so
    // they need no genitive counterpart.
    "středa": "We", streda: "We", "středy": "We", stredy: "We", st: "We",
    "čtvrtek": "Th", ctvrtek: "Th", "čtvrtka": "Th", ctvrtka: "Th", "čt": "Th", ct: "Th",
    "pátek": "Fr", patek: "Fr", "pátku": "Fr", patku: "Fr", "pá": "Fr", pa: "Fr",
    sobota: "Sa", "soboty": "Sa", so: "Sa",
    "neděle": "Su", nedele: "Su", ne: "Su",
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface DayMatch {
  index: number;
  end: number;
  code: OsmDay;
}

function findDayMatches(text: string, dayMap: DayMap): DayMatch[] {
  const keys = Object.keys(dayMap).sort((a, b) => b.length - a.length);
  const pattern = keys.map(escapeRegExp).join("|");
  const re = new RegExp(`(?<![\\p{L}])(${pattern})(?![\\p{L}])`, "giu");
  const matches: DayMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    matches.push({ index: m.index, end: m.index + m[0].length, code: dayMap[m[0].toLowerCase()] });
  }
  return matches;
}

/**
 * Picks whichever language's day-name table explains the most DISTINCT days
 * in the string — not just the most raw token matches. Real, live-caught
 * collision this distinction fixes: German's existing "do" (Donnerstag)
 * abbreviation is also exactly the Czech preposition "do" ("to") used as a
 * day-range/time-range connector (see isPureConnector and reColon above) —
 * a real Czech sentence like "pondělí do neděle od 10:00 do 19:00" contains
 * "do" TWICE, which German's table happily "matches" as Thursday twice,
 * tying Czech's two genuinely different day names (Mo, Su) on raw count.
 * Two repeated matches of the SAME day is a much weaker signal than two
 * matches of DIFFERENT days — a real day range or list overwhelmingly names
 * more than one distinct day, while a same-word collision like this one
 * doesn't. Ties broken by raw count as a secondary signal, same as before.
 */
function bestDayMatches(text: string): DayMatch[] {
  let best: DayMatch[] = [];
  let bestDistinct = 0;
  for (const lang of Object.keys(DAY_MAPS)) {
    const matches = findDayMatches(text, DAY_MAPS[lang]);
    const distinct = new Set(matches.map((m) => m.code)).size;
    if (distinct > bestDistinct || (distinct === bestDistinct && matches.length > best.length)) {
      best = matches;
      bestDistinct = distinct;
    }
  }
  return best;
}

interface TimeRange {
  index: number;
  end: number;
  open: string;
  close: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A close time of exactly midnight ("00:00") cannot be expressed as a
 * same-day close — `resolveOpeningHoursForDate` has no notion of a stop that
 * closes "tomorrow" (see `widestWindow` in opening-hours.ts, which already
 * excludes close<=open spans for the same reason). "23:59" is the existing
 * sentinel this codebase uses elsewhere for "open until end of day", so
 * reusing it here stays consistent rather than inventing a second one.
 */
function closeFor(close: string): string {
  return close === "00:00" ? "23:59" : close;
}

function findTimeRanges(text: string): TimeRange[] {
  const ranges: TimeRange[] = [];

  // "09:00 - 18:00", "9:00-18:00", "9h00 à 21h00", "daily 9:00 to 22:00",
  // "Open daily 9 to 17h", "10.00–18.00", "od 10:00 do 19:00" — colon, "h",
  // or period delimiter, dash/"to"/"bis"/"do" separator. The period form is
  // a real, common European convention (real case: a Prague gallery's real
  // hours page states "út–ne: 10.00–18.00" — Tue-Sun, 10:00-18:00 — with
  // periods, not colons). The Czech "od ... do ..." ("from ... to ...")
  // prose form is a real, common phrasing (real case: "pondělí do neděle od
  // 10:00 do 19:00" — Muzeum Karla Zemana's real hours) — the leading "od"
  // needs no special handling (it simply sits before the match, same as any
  // other prose this regex already ignores), only "do" needs adding as a
  // valid separator alongside the existing word/dash forms. Each side's
  // delimiter is independently optional (real case: "9 to 17h" has a bare
  // "9" on one side and an "h"-marked "17h" on the other) but at least one
  // side must carry a real time marker — requiring that is what stops a
  // bare number range like "15-25" (a price, a page count) from ever being
  // read as a time, which neither side of has any hour marker at all.
  //
  // Positional groups (named groups need an ES2018+ TS target this project
  // doesn't use): 1=open hour, 2=open marker (whole alternation),
  // 3=open colon-minutes, 4=open period-minutes, 5=open h-minutes,
  // 6=close hour, 7=close marker, 8=close colon-minutes,
  // 9=close period-minutes, 10=close h-minutes.
  const reColon =
    /(\d{1,2})(:(\d{2})|\.(\d{2})|h(\d{2})?)?\s*(?:-|–|—|to|bis|do)\s*(\d{1,2})(:(\d{2})|\.(\d{2})|h(\d{2})?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = reColon.exec(text))) {
    const openHasMarker = m[2] !== undefined;
    const closeHasMarker = m[7] !== undefined;
    if (!openHasMarker && !closeHasMarker) continue; // neither side looks like a time — likely an unrelated number range
    const oh = Number(m[1]);
    const om = openHasMarker ? Number(m[3] ?? m[4] ?? m[5] ?? 0) : 0;
    const ch = Number(m[6]);
    const cm = closeHasMarker ? Number(m[8] ?? m[9] ?? m[10] ?? 0) : 0;
    if (oh > 23 || ch > 23 || om > 59 || cm > 59) continue;
    if (oh === ch && om === cm) continue; // "09:00-09:00" — zero-duration, malformed, not a real window
    ranges.push({ index: m.index, end: m.index + m[0].length, open: `${pad2(oh)}:${pad2(om)}`, close: `${pad2(ch)}:${pad2(cm)}` });
  }

  // "9 bis 17 Uhr" / "9-17 Uhr" — bare hour numbers, no colon on either side,
  // German's spoken-hours convention. Requires the trailing "Uhr" so a plain
  // number range elsewhere in the text (a price range, a page count) is never
  // mistaken for a time.
  const reUhr = /\b(\d{1,2})\s*(?:-|–|—|bis)\s*(\d{1,2})\s*Uhr\b/gi;
  while ((m = reUhr.exec(text))) {
    const oh = Number(m[1]);
    const ch = Number(m[2]);
    if (oh > 23 || ch > 23) continue;
    if (oh === ch) continue; // "9-9 Uhr" — zero-duration, malformed
    const overlapsColonMatch = ranges.some((r) => r.index < m!.index + m![0].length && m!.index < r.end);
    if (overlapsColonMatch) continue;
    ranges.push({ index: m.index, end: m.index + m[0].length, open: `${pad2(oh)}:00`, close: `${pad2(ch)}:00` });
  }

  // "9 a.m. to 5 p.m." / "9am-5pm" / "9:30 AM - 5:00 PM" — English AM/PM,
  // real-world coverage gap found live: a real model extraction for the
  // Rijksmuseum returned exactly "Daily, 365 days a year from 9 a.m. to 5
  // p.m." with hoursScope correctly "daily", but with no AM/PM support this
  // parser could not convert the time at all and the guard correctly
  // refused to guess rather than mishandle it — closing the gap instead of
  // leaving a common, real format permanently unusable.
  const reAmPm = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*(?:to|-|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/gi;
  while ((m = reAmPm.exec(text))) {
    const oh12 = Number(m[1]);
    const om = Number(m[2] ?? 0);
    const ch12 = Number(m[4]);
    const cm = Number(m[5] ?? 0);
    if (oh12 < 1 || oh12 > 12 || ch12 < 1 || ch12 > 12 || om > 59 || cm > 59) continue;
    const oh = to24Hour(oh12, m[3]);
    const ch = to24Hour(ch12, m[6]);
    if (oh === ch && om === cm) continue; // zero-duration, malformed
    const overlapsExisting = ranges.some((r) => r.index < m!.index + m![0].length && m!.index < r.end);
    if (overlapsExisting) continue;
    ranges.push({ index: m.index, end: m.index + m[0].length, open: `${pad2(oh)}:${pad2(om)}`, close: `${pad2(ch)}:${pad2(cm)}` });
  }

  return ranges.sort((a, b) => a.index - b.index);
}

function to24Hour(hour12: number, ampm: string): number {
  const isPm = ampm.toLowerCase() === "p";
  if (hour12 === 12) return isPm ? 12 : 0;
  return isPm ? hour12 + 12 : hour12;
}

/**
 * Only a dash (optionally with surrounding whitespace/periods), or the
 * Czech word "do" ("to") standing completely alone, between two day names —
 * safe to merge into one range, e.g. "Wt. - Pt." -> "Tu-Fr", or the real
 * Czech prose form "pondělí do pátku" -> "Mo-Fr". "do" is only ever
 * evaluated in this exact position — the whole substring between two
 * already-recognized day-name matches with nothing else in it — so it can
 * never be confused with the same word appearing as unrelated prose
 * elsewhere in the sentence; anything beyond that one word (leading or
 * trailing text, another clause) fails the exact match and is correctly
 * left unmerged, same failure direction as the dash case below.
 *
 * Deliberately does NOT treat a comma or a word like "and" as mergeable: a
 * comma-separated day *list* ("Mo, We, Fr") means exactly those three days,
 * not a range spanning Tuesday and Thursday too — merging first-and-last
 * across a comma or "and" would silently turn a list into a wrong range.
 * That case is genuinely unhandled (no comma-list evidence in the real
 * pages this was built against) — a day group whose neighbour isn't a plain
 * dash or "do" simply won't merge, which surfaces as a rejected result
 * rather than a guessed one, matching the rest of this function's failure
 * direction.
 */
function isPureConnector(s: string): boolean {
  return /^[\s.]*[-–—][\s.]*$/.test(s) || /^\s*do\s*$/i.test(s);
}

const OSM_DAY_ORDER: OsmDay[] = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Expands "Tu-Fr" -> [Tu,We,Th,Fr] or a single "Mo" -> [Mo]. */
function expandDaySpec(spec: string): OsmDay[] {
  const [start, end] = spec.split("-") as [OsmDay, OsmDay | undefined];
  if (!end) return [start];
  const startIdx = OSM_DAY_ORDER.indexOf(start);
  const endIdx = OSM_DAY_ORDER.indexOf(end);
  const days: OsmDay[] = [];
  let i = startIdx;
  while (true) {
    days.push(OSM_DAY_ORDER[i]);
    if (i === endIdx) break;
    i = (i + 1) % 7;
  }
  return days;
}

/**
 * Rejects the whole result if the same day appears in two groups with
 * different hours — e.g. a model that emitted both "Mo-Fr 09:00-17:00" and,
 * elsewhere in the same string, "Mo 10:00-14:00" for what should be one
 * schedule. That is not a real venue's hours (nothing opens two different
 * schedules on the same calendar day); it is a sign the extraction merged
 * text from two unrelated parts of the page. A contradictory constraint fed
 * to the optimizer is worse than a missing one.
 *
 * `inherited` parts are exempt: findInheritedClosingTime only ever produces
 * one by finding EXACTLY ONE earlier rule whose day-set already contains
 * the exception's day(s), and deliberately re-uses that rule's own opening
 * time — the two entries differing in stated hours for the same day is not
 * a merge artifact here, it is the whole, intentional point (Thursday
 * really does close later than the general rule; that is what "inherited"
 * means). It already went through its own, narrower uniqueness check at
 * creation time; re-running this broader, unrelated-text-focused check
 * against it would reject the exact real case this feature exists for.
 */
function hasContradiction(parts: Array<{ spec: string; open: string; close: string; inherited?: boolean }>): boolean {
  const seen = new Map<OsmDay, string>();
  for (const part of parts) {
    if (part.inherited) continue;
    for (const day of expandDaySpec(part.spec)) {
      const key = `${part.open}-${part.close}`;
      const existing = seen.get(day);
      if (existing && existing !== key) return true;
      seen.set(day, key);
    }
  }
  return false;
}

/**
 * Recognizes a closing-time-ONLY exception clause — "do 20:00" / "until
 * 20:00" / "bis 20 Uhr"-shaped, a single time with no opening time of its
 * own stated anywhere near it — and, only when it is deterministically
 * safe, resolves it by inheriting the opening time from an already-
 * resolved rule earlier in the same string. Real case: muzeumprahy.cz's
 * real hours state "Úterý–neděle 10.00–18.00, čtvrtek do 20.00 hod."
 * ("Tue-Sun 10-18, Thursday until 20:00") — one single, self-contained
 * sentence about one museum, where Thursday's own opening time is never
 * restated, only its later closing time; the general rule right before it
 * is the only real candidate for what Thursday inherits.
 *
 * Every condition here exists to keep this from ever guessing:
 *  - the fragment must appear immediately after the day group (only
 *    whitespace/a comma between them) — anything else in between means
 *    this isn't a clean, self-contained exception clause, and is refused
 *    rather than searched for elsewhere in the text.
 *  - the lone time must carry a real minute marker (colon/period/"h"),
 *    same discipline findTimeRanges already applies — a bare number is
 *    not confidently a time at all.
 *  - EXACTLY ONE already-resolved rule's day-set must fully contain every
 *    day this exception names. Zero matches means there is nothing to
 *    inherit from; two or more means genuinely ambiguous WHICH rule's
 *    opening time applies (real risk this guards against: multiple
 *    earlier rules that could each plausibly supply the exception's
 *    day) — both outcomes are refused, not guessed at.
 *  - the inherited opening time must be strictly before the exception's
 *    own stated closing time — an inherited pairing that produces a
 *    zero-or-negative-length window is not a sane schedule and is refused
 *    rather than emitted anyway.
 */
function findInheritedClosingTime(
  boundaryText: string,
  groupSpec: string,
  resolvedParts: Array<{ spec: string; open: string; close: string }>
): { open: string; close: string } | null {
  const m = boundaryText.match(/^[\s,]*(?:do|until|bis)\s+(\d{1,2})(?::(\d{2})|\.(\d{2})|h(\d{2})?)?\b/i);
  if (!m) return null;
  const hasMarker = m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
  if (!hasMarker) return null; // a bare number with no minute marker at all is not confidently a time

  const h = Number(m[1]);
  const min = Number(m[2] ?? m[3] ?? m[4] ?? 0);
  if (h > 23 || min > 59) return null;
  const close = closeFor(`${pad2(h)}:${pad2(min)}`);

  const exceptionDays = expandDaySpec(groupSpec);
  const candidates = resolvedParts.filter((p) => exceptionDays.every((d) => expandDaySpec(p.spec).includes(d)));
  if (candidates.length !== 1) return null; // nothing to inherit from, or genuinely ambiguous which rule to use

  const open = candidates[0].open;
  if (open >= close) return null; // would produce a zero/negative-length window — not a sane result

  return { open, close };
}

/**
 * Salvages complete array elements from a JSON response that was cut off
 * mid-generation — a genuinely recurring failure mode for any list-style
 * extraction (a menu, an event calendar), since no fixed token budget can
 * guarantee covering every real page's real item count. Scans for
 * `"arrayKey": [ ... ]` and returns every syntactically complete `{...}`
 * object found before the cutoff, discarding only the one partial object
 * actually truncated mid-way — never inventing or repairing its content.
 * Callers still validate each salvaged item exactly as they would a
 * cleanly-parsed one; this only recovers otherwise fully-lost real data,
 * it does not weaken any downstream guard.
 */
export function repairTruncatedJsonArray(raw: string, arrayKey: string): unknown[] {
  const keyIdx = raw.indexOf(`"${arrayKey}"`);
  if (keyIdx === -1) return [];
  const bracketStart = raw.indexOf("[", keyIdx);
  if (bracketStart === -1) return [];

  const items: string[] = [];
  let depth = 0;
  let itemStart = -1;
  let inString = false;
  let escape = false;

  for (let i = bracketStart + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) itemStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && itemStart !== -1) {
        items.push(raw.slice(itemStart, i + 1));
        itemStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }

  const out: unknown[] = [];
  for (const itemStr of items) {
    try {
      out.push(JSON.parse(itemStr));
    } catch {
      // A malformed individual object (rare — usually only the very last,
      // genuinely truncated one) is skipped, not force-repaired.
    }
  }
  return out;
}

export function looseTextToOsmSyntax(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const times = findTimeRanges(trimmed);
  if (times.length === 0) return null;

  const dayMatches = bestDayMatches(trimmed);

  if (dayMatches.length === 0) {
    const formatted = times.map((t) => `${t.open}-${closeFor(t.close)}`).join(",");
    return `Mo-Su ${formatted}`;
  }

  // Merge adjacent day matches (only whitespace/punctuation/"and" between
  // them) into ranges ("Tu-Fr") or, when there's just one, a single day.
  const groups: Array<{ start: number; end: number; spec: string }> = [];
  let i = 0;
  while (i < dayMatches.length) {
    let j = i;
    while (j + 1 < dayMatches.length && isPureConnector(trimmed.slice(dayMatches[j].end, dayMatches[j + 1].index))) {
      j++;
    }
    const first = dayMatches[i].code;
    const last = dayMatches[j].code;
    groups.push({
      start: dayMatches[i].index,
      end: dayMatches[j].end,
      spec: first === last ? first : `${first}-${last}`,
    });
    i = j + 1;
  }

  const usedTimeIndices = new Set<number>();
  const parts: Array<{ spec: string; open: string; close: string; inherited?: boolean }> = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const boundary = g + 1 < groups.length ? groups[g + 1].start : trimmed.length;
    const timeIdx = times.findIndex((t, idx) => !usedTimeIndices.has(idx) && t.index >= group.end && t.index < boundary);
    if (timeIdx === -1) {
      // No full open-close pair follows this day group — before refusing
      // outright, check for the one narrow, deterministic exception this
      // parser supports: a closing-time-only clause whose day(s) are all
      // already covered by exactly one earlier-resolved rule in this same
      // string (see findInheritedClosingTime's docstring for the real case
      // and the exact safety conditions).
      const inherited = findInheritedClosingTime(trimmed.slice(group.end, boundary), group.spec, parts);
      if (!inherited) return null; // a day group with no hours right after it, and no safe inheritance — refuse rather than guess
      parts.push({ spec: group.spec, open: inherited.open, close: inherited.close, inherited: true });
      continue;
    }
    usedTimeIndices.add(timeIdx);
    const t = times[timeIdx];
    parts.push({ spec: group.spec, open: t.open, close: closeFor(t.close) });
  }

  if (parts.length === 0) return null;
  if (hasContradiction(parts)) return null;

  return parts.map((p) => `${p.spec} ${p.open}-${p.close}`).join("; ");
}
