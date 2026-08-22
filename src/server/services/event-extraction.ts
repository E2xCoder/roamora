import "server-only";
import { z } from "zod";
import { config } from "@/server/config";
import { callOllama, htmlToPlainText, ExtractionUnavailableError } from "@/server/services/fact-extraction";

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
