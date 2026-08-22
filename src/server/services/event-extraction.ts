import "server-only";
import { z } from "zod";
import { config } from "@/server/config";
import { callOllama, htmlToPlainText, ExtractionUnavailableError, repairTruncatedJsonArray } from "@/server/services/fact-extraction";

/**
 * Structured event-fact extraction — the event counterpart to
 * fact-extraction.ts's opening-hours/price extraction, kept as a separate
 * schema/prompt rather than folded into the same one: an event's real shape
 * (a date range, a start/end time, a venue) is different enough from a
 * place's recurring weekly schedule that conflating them would make both
 * prompts vaguer. Same discipline as the rest of this pipeline: the model
 * states what the page actually says, in ISO date format so a deterministic
 * validator (event-guard.ts) can check it without re-parsing free text, and
 * returns null fields rather than guessing when something isn't stated.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD bekleniyor")
  .nullable();
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "SS:DD bekleniyor")
  .nullable();

const eventFactsSchema = z.object({
  eventName: z.string().max(200).nullable(),
  startDate: isoDate,
  /** Same as startDate for a single-day event; the real end of a multi-day festival otherwise. */
  endDate: isoDate,
  startTime: hhmm,
  endTime: hhmm,
  venueName: z.string().max(200).nullable(),
  /** True only when the model is confident the page discusses THIS event. */
  aboutThisEvent: z.boolean(),
});

export type ExtractedEventFacts = z.infer<typeof eventFactsSchema>;

export interface EventExtractionResult {
  facts: ExtractedEventFacts;
}

/**
 * Extracts event date/time/venue from a page's text, for one named event.
 * Returns `null` when the model finds nothing usable or its output fails
 * schema validation — never a best-effort guess at a date.
 */
export async function extractEventFactsFromText(
  eventName: string,
  pageText: string
): Promise<EventExtractionResult | null> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError("AI_DISABLED", "AI sağlayıcı devre dışı (AI_PROVIDER=none).");
  }

  const trimmed = htmlToPlainText(pageText).slice(0, 4000).trim();
  if (!trimmed) return null;

  const prompt = `You are reading a web page about a real-world event. Find facts specifically about this event: "${eventName}".

Page text:
"""
${trimmed}
"""

Return ONLY a JSON object with this exact shape, no other text:
{
  "eventName": "<the event's name as stated, or null>",
  "startDate": "<the event's start date in YYYY-MM-DD format, or null if not clearly stated. Convert whatever date format the page uses (e.g. '21-28.06.2026' means startDate 2026-06-21) — do not guess a year or month that isn't stated.>",
  "endDate": "<the event's end date in YYYY-MM-DD format. Same as startDate for a single-day event. Null if not stated.>",
  "startTime": "<the event's start time as HH:MM (24-hour), or null if not stated>",
  "endTime": "<the event's end time as HH:MM (24-hour), or null if not stated>",
  "venueName": "<the specific venue/location name if stated, or null>",
  "aboutThisEvent": <true only if this page text is actually about "${eventName}", false otherwise>
}

Do not guess. If a fact is not clearly stated in the text, use null for it.`;

  let raw: string;
  try {
    raw = await callOllama(prompt);
  } catch (err) {
    if (err instanceof ExtractionUnavailableError) throw err;
    throw new ExtractionUnavailableError("AI_UNREACHABLE", `Ollama'ya ulaşılamadı (${config.OLLAMA_BASE_URL}).`);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const validated = eventFactsSchema.safeParse(parsedJson);
  if (!validated.success) return null;
  if (!validated.data.aboutThisEvent) return null;
  if (validated.data.startDate == null) return null; // no usable date at all

  return { facts: validated.data };
}

const eventListItemSchema = z.object({
  eventName: z.string().max(200),
  startDate: isoDate,
  endDate: isoDate,
  startTime: hhmm,
  endTime: hhmm,
  venueName: z.string().max(200).nullable(),
});

const eventListSchema = z.object({
  events: z.array(eventListItemSchema).max(10),
});

export type ExtractedEventListItem = z.infer<typeof eventListItemSchema>;

/**
 * Extracts every distinct, dated event mentioned on a page that lists
 * several — a city's "what's on" calendar, a venue's programme page — as
 * opposed to `extractEventFactsFromText`'s single named event. This is the
 * real extraction step behind autonomous event *discovery*: the caller
 * supplies a destination-level query rather than a specific event name, so
 * there is no single "eventName" to check `aboutThisEvent` against — every
 * listed item with a real date is returned, and each is independently
 * re-validated by `validateExtractedEvent` (real calendar date, textually
 * supported, not already ended) exactly like a named-event lookup, so a
 * hallucinated or stale entry in a multi-event list is rejected the same
 * way a bad single-event extraction would be.
 */
export async function extractEventListFromText(pageText: string): Promise<ExtractedEventListItem[]> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError("AI_DISABLED", "AI sağlayıcı devre dışı (AI_PROVIDER=none).");
  }

  const trimmed = htmlToPlainText(pageText).slice(0, 4000).trim();
  if (!trimmed) return [];

  const prompt = `You are reading a web page that may list several real-world events (concerts, festivals, markets, exhibitions, performances, guided tours, demonstrations, cultural or seasonal events).

Page text:
"""
${trimmed}
"""

List every DISTINCT event that has a specific date clearly stated on this page, up to 10. Return ONLY a JSON object with this exact shape, no other text:
{
  "events": [
    {
      "eventName": "<the event's name as stated>",
      "startDate": "<YYYY-MM-DD, converting whatever date format the page uses — do not guess a year or month that isn't stated>",
      "endDate": "<YYYY-MM-DD, same as startDate for a single-day event>",
      "startTime": "<HH:MM 24-hour, or null if not stated>",
      "endTime": "<HH:MM 24-hour, or null if not stated>",
      "venueName": "<the specific venue/location if stated, or null>"
    }
  ]
}

Do not guess. Only include an event if a real date is clearly stated for it. If the page lists no dated events at all, return {"events": []}.`;

  let raw: string;
  try {
    // A list of up to 10 events needs far more than the 200-token default
    // sized for a single fact — see callOllama's docstring for the real,
    // live-observed truncation bug this fixes.
    raw = await callOllama(prompt, 1200);
  } catch (err) {
    if (err instanceof ExtractionUnavailableError) throw err;
    throw new ExtractionUnavailableError("AI_UNREACHABLE", `Ollama'ya ulaşılamadı (${config.OLLAMA_BASE_URL}).`);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonMatch[0]);
  } catch {
    // The response was cut off mid-generation — salvage whichever events
    // completed before the truncation rather than losing all of them.
    const salvaged = repairTruncatedJsonArray(raw, "events");
    return salvaged
      .map((item) => eventListItemSchema.safeParse(item))
      .filter((r) => r.success)
      .map((r) => r.data);
  }

  const validated = eventListSchema.safeParse(parsedJson);
  if (!validated.success) return [];
  return validated.data.events;
}
