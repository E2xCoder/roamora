/**
 * A conservative subset parser for OSM's `opening_hours` tag syntax.
 *
 * The full spec (https://wiki.openstreetmap.org/wiki/Key:opening_hours) covers
 * sunrise/sunset times, week numbers, school/public holidays, comments and
 * more. Implementing all of it risks silently mis-parsing an edge case into a
 * confidently wrong constraint — and a wrong `latestTime` fed into the
 * itinerary optimizer doesn't just look odd, it can make a real museum visit
 * get scheduled after closing, or get rejected as "impossible" when it
 * wasn't. So this parser handles the common, high-confidence cases —
 * weekday ranges, time ranges, closed days, 24/7, a leading month range — and
 * refuses ("unparseable") the moment it meets anything outside that grammar,
 * rather than guessing at the rest.
 */

export interface DayWindow {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

export type OpeningHoursResult =
  | { status: "open"; windows: DayWindow[] }
  | { status: "closed" }
  | { status: "always" }
  | { status: "unparseable"; reason: string };

const DAY_TOKENS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
type DayToken = (typeof DAY_TOKENS)[number];

const MONTH_TOKENS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function dayTokenFor(date: Date): DayToken {
  // getDay(): 0=Sunday..6=Saturday
  return DAY_TOKENS[(date.getDay() + 6) % 7];
}

function expandDaySpec(spec: string): Set<DayToken> | null {
  const out = new Set<DayToken>();
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (token === "PH" || token === "SH") continue; // no holiday calendar available — never claimed

    const range = token.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)-(Mo|Tu|We|Th|Fr|Sa|Su)$/);
    if (range) {
      const start = DAY_TOKENS.indexOf(range[1] as DayToken);
      const end = DAY_TOKENS.indexOf(range[2] as DayToken);
      if (start === -1 || end === -1) return null;
      let i = start;
      while (true) {
        out.add(DAY_TOKENS[i]);
        if (i === end) break;
        i = (i + 1) % 7;
      }
      continue;
    }

    if ((DAY_TOKENS as readonly string[]).includes(token)) {
      out.add(token as DayToken);
      continue;
    }

    return null; // unrecognised day token — bail rather than guess
  }
  return out;
}

interface DateClause {
  month: number;
  day: number;
  endMonth: number;
  endDay: number;
}

/** "Jan", "Aug", etc. — a real month token, used to type-narrow a regex capture group without an `as` cast at the call site. */
function monthIndex(token: string): number {
  return MONTH_TOKENS.indexOf(token as (typeof MONTH_TOKENS)[number]);
}

function parseSingleDateClause(token: string): DateClause | null {
  const m = token
    .trim()
    .match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:-(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+)?(\d{1,2}))?$/);
  if (!m) return null;
  const month = monthIndex(m[1]);
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  if (m[4] == null) return { month, day, endMonth: month, endDay: day }; // single date, not a range
  const endMonth = m[3] ? monthIndex(m[3]) : month;
  const endDay = Number(m[4]);
  if (endDay < 1 || endDay > 31) return null;
  return { month, day, endMonth, endDay };
}

function dateClauseContains(date: Date, c: DateClause): boolean {
  const key = (mo: number, d: number) => mo * 100 + d;
  const target = key(date.getMonth(), date.getDate());
  const start = key(c.month, c.day);
  const end = key(c.endMonth, c.endDay);
  if (start <= end) return target >= start && target <= end;
  return target >= start || target <= end; // wraps across year end
}

const DATE_CLAUSE_TOKEN_RE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(?:-(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+)?\\d{1,2})?";
// A colon after the date-clause list is real, common, and optional in real
// OSM data (e.g. "Mar 15-Nov 30: Mo-Su 10:00-18:00" — a real Prague
// landmark's real hours) — `:?\s+` accepts it either way, never requiring
// it, since the same real data this parser already handled has no colon at
// all (e.g. "Apr 01-31,Sep 01-Oct 18 09:00-18:00").
const LEADING_DATE_CLAUSES_RE = new RegExp(`^((?:${DATE_CLAUSE_TOKEN_RE})(?:,(?:${DATE_CLAUSE_TOKEN_RE}))*):?\\s+(.*)$`);

/**
 * Consumes a leading comma-separated list of day-of-month-precision date
 * clauses from the front of a rule — a single date ("Jan 01"), a same-month
 * range ("Apr 01-31"), or a cross-month range ("Sep 01-Oct 18"). This is a
 * real, common refinement of the whole-month-only range `monthInRange`
 * already handled below, and a real gap without it: a rule for one
 * completely unrelated specific date (e.g. a New Year's Day exception) used
 * to fail the ENTIRE opening_hours string as "unparseable" — even when a
 * later, perfectly parseable rule was the one that actually governed the
 * requested date. Returns null when the rule does not start with this shape
 * at all, so the caller falls through to its existing parsing rather than
 * guessing.
 */
function consumeLeadingDateClauses(remainder: string, date: Date): { appliesToday: boolean; rest: string } | null {
  const m = remainder.match(LEADING_DATE_CLAUSES_RE);
  if (!m) return null;
  const clauses = m[1].split(",").map(parseSingleDateClause);
  if (clauses.some((c) => c === null)) return null; // regex guarantees this in practice; stay safe regardless
  return { appliesToday: (clauses as DateClause[]).some((c) => dateClauseContains(date, c)), rest: m[2] };
}

function monthInRange(date: Date, spec: string): boolean | null {
  const range = spec.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/
  );
  if (!range) return null;
  const start = MONTH_TOKENS.indexOf(range[1] as (typeof MONTH_TOKENS)[number]);
  const end = MONTH_TOKENS.indexOf(range[2] as (typeof MONTH_TOKENS)[number]);
  if (start === -1 || end === -1) return null;

  const m = date.getMonth();
  if (start <= end) return m >= start && m <= end;
  return m >= start || m <= end; // wraps across year end, e.g. Nov-Feb
}

/**
 * Validates one HH:MM clock time, accepting OSM's legal special value
 * "24:00" (end of day — distinct from "00:00", the start of the day) in
 * addition to the normal 00:00-23:59 range. Real, live-observed gap: a real
 * Prague restaurant's real OSM hours ("Mo-Su 18:00-24:00,11:30-15:00" —
 * dinner service until midnight) failed to parse at all, since "24" was
 * outside the old regex's accepted hour range entirely — and a midnight (or
 * later) closing time is an extremely common, unremarkable shape for
 * exactly the kind of venue (restaurants, bars) an itinerary most needs
 * real hours for. Normalized to "23:59" rather than kept as literal
 * "24:00", so it stays inside the [00:00, 23:59] range every other HH:MM
 * consumer in this codebase already assumes — a lost minute of precision is
 * a fair trade for not introducing a new "hour 24" edge case downstream.
 */
function parseClockTime(token: string): string | null {
  const m = token.match(/^([01]\d|2[0-3]|24):([0-5]\d)$/);
  if (!m) return null;
  if (m[1] === "24") return m[2] === "00" ? "23:59" : null; // "24:00" only, never e.g. "24:15"
  return `${m[1]}:${m[2]}`;
}

function parseTimeSpec(spec: string): DayWindow[] | "off" | null {
  const trimmed = spec.trim();
  if (trimmed === "off" || trimmed === "closed") return "off";

  const windows: DayWindow[] = [];
  for (const part of trimmed.split(",")) {
    const [openRaw, closeRaw, ...rest] = part.trim().split("-");
    if (openRaw == null || closeRaw == null || rest.length > 0) return null;
    const open = parseClockTime(openRaw);
    const close = parseClockTime(closeRaw);
    if (open === null || close === null) return null;
    windows.push({ open, close });
  }
  return windows.length > 0 ? windows : null;
}

/**
 * Resolves an OSM `opening_hours` string against one specific calendar date.
 *
 * Rules are separated by `;` and applied in order, with a later rule for the
 * same day overriding an earlier one — matching the OSM spec's own
 * override semantics. Any rule this parser cannot confidently interpret
 * fails the whole string closed to "unparseable", rather than silently
 * dropping just that rule (a dropped exception rule, e.g. "Mo off" after a
 * blanket "Mo-Su 09:00-18:00", would wrongly report a closed day as open).
 */
export function resolveOpeningHoursForDate(raw: string, date: Date): OpeningHoursResult {
  const value = raw?.trim();
  if (!value) return { status: "unparseable", reason: "boş değer" };
  if (value === "24/7") return { status: "always" };

  const today = dayTokenFor(date);
  let result: OpeningHoursResult | null = null;

  for (const ruleRaw of value.split(";")) {
    const rule = ruleRaw.trim();
    if (!rule) continue;

    let remainder = rule;
    let dateClauseHandled = false;

    // Leading day-of-month-precision date clause(s), e.g. "Jan 01", "Apr
    // 01-31", "Sep 01-Oct 18" (comma-separated combinations of these) — see
    // consumeLeadingDateClauses's own docstring for why this exists.
    const dateClauseConsumed = consumeLeadingDateClauses(remainder, date);
    if (dateClauseConsumed) {
      if (!dateClauseConsumed.appliesToday) continue; // a real date, just not this one
      remainder = dateClauseConsumed.rest;
      dateClauseHandled = true;
    }

    // Optional leading month range, e.g. "Apr-Oct Mo-Fr 09:00-17:00" — only
    // tried when a date clause didn't already establish today's applicability.
    if (!dateClauseHandled) {
      const monthMatch = remainder.match(/^([A-Za-z]{3}-[A-Za-z]{3})\s+(.*)$/);
      if (monthMatch && MONTH_TOKENS.some((m) => monthMatch[1].startsWith(m))) {
        const inMonth = monthInRange(date, monthMatch[1]);
        if (inMonth === null) {
          return { status: "unparseable", reason: `anlaşılamayan ay aralığı: "${monthMatch[1]}"` };
        }
        if (!inMonth) continue; // this rule does not apply in the given month
        remainder = monthMatch[2];
      }
    }

    // A holiday-calendar-dependent rule with no calendar this pipeline has
    // access to (e.g. `"Jewish holidays" off`) — same treatment as the
    // existing PH/SH day tokens below: never claimed either way, not guessed at.
    if (/^"[^"]*"\s+/.test(remainder)) continue;

    // A bare time spec with no day-of-week selector at all means "every
    // day" — OSM's own convention, and a real, common, minimal authoring
    // shape on its own (real case: a church's whole opening_hours tag was
    // just "10:00-17:00", no day-of-week rule at all — every day, all
    // week). Also what a date clause commonly leaves once its own scope is
    // established ("every day within this date/date range"). Falls through
    // to the day-token parsing below when the remainder isn't actually a
    // bare time spec (e.g. a day selector follows, "Sep 01-Oct 18 Sa,Su
    // 10:00-16:00", or a day-token rule like "Mo-Fr 09:00-17:00" — which
    // parseTimeSpec itself rejects, since it splits into more than two
    // dash-separated pieces).
    const bareTime = parseTimeSpec(remainder);
    if (bareTime !== null) {
      result = bareTime === "off" ? { status: "closed" } : { status: "open", windows: bareTime };
      continue;
    }

    const spaceIdx = remainder.indexOf(" ");
    if (spaceIdx === -1) {
      return { status: "unparseable", reason: `çözümlenemeyen kural: "${rule}"` };
    }

    const daySpecRaw = remainder.slice(0, spaceIdx);
    const timeSpecRaw = remainder.slice(spaceIdx + 1);

    const days = expandDaySpec(daySpecRaw);
    if (days === null) {
      return { status: "unparseable", reason: `anlaşılamayan gün: "${daySpecRaw}"` };
    }
    if (!days.has(today)) continue; // rule does not govern the requested date

    const timeResult = parseTimeSpec(timeSpecRaw);
    if (timeResult === null) {
      return { status: "unparseable", reason: `anlaşılamayan saat: "${timeSpecRaw}"` };
    }

    result = timeResult === "off" ? { status: "closed" } : { status: "open", windows: timeResult };
  }

  return result ?? { status: "closed" };
}

/**
 * Convenience: the single widest open→close window for the day, if any.
 *
 * Excludes windows that span midnight (close < open, e.g. "12:00-02:00" for
 * a bar open past midnight) — a real bug this exclusion fixes: fed as-is,
 * "02:00" was read as a same-day 2 AM cutoff, so a venue open until 2 AM was
 * reported as unreachable by a 10:27 arrival. The itinerary optimizer has no
 * notion of a stop that closes "tomorrow", so an overnight window cannot be
 * expressed as a same-day earliest/latest pair — it is better left
 * unconstrained here than fed in wrong.
 */
export function widestWindow(result: OpeningHoursResult): DayWindow | null {
  if (result.status === "always") return { open: "00:00", close: "23:59" };
  if (result.status !== "open" || result.windows.length === 0) return null;

  const sameDay = result.windows.filter((w) => w.close > w.open);
  if (sameDay.length === 0) return null;

  return sameDay.reduce((a, b) => (a.close > b.close ? a : b));
}
