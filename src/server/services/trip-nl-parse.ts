import "server-only";
import { z } from "zod";
import { config } from "@/server/config";
import { callOllama, ExtractionUnavailableError } from "@/server/services/fact-extraction";

/**
 * Parses a free-text trip description ("5 days in Prague, love museums and
 * coffee, budget around 800 euros") into the same structured fields the
 * trip-creation form already uses — never a separate, auto-submitting path.
 * Same discipline as every other extractor in this pipeline: a field the
 * text doesn't actually state comes back null/absent, never guessed —
 * `durationDays` is the one deliberate exception, and only as a *duration*
 * hint (a real day-count actually mentioned in the text), never resolved
 * into calendar dates here; the caller still requires the user to pick or
 * confirm an actual start date before autoplan() ever runs, since "5 days"
 * without a stated start date has no real start date to invent.
 */

const parsedTripSchema = z.object({
  destination: z.string().max(200).nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  durationDays: z.number().int().min(1).max(30).nullable(),
  interests: z.array(z.string().max(40)).max(10),
  budget: z.number().min(0).max(1_000_000).nullable(),
  currency: z.string().max(6).nullable(),
});

export type ParsedTrip = z.infer<typeof parsedTripSchema>;

export async function parseTripDescription(text: string, todayIso: string): Promise<ParsedTrip | null> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError("AI_DISABLED", "AI sağlayıcı devre dışı (AI_PROVIDER=none).");
  }
  const trimmed = text.trim().slice(0, 1000);
  if (!trimmed) return null;

  const prompt = `A traveller wrote this free-text trip description. Today's real date is ${todayIso}.

"""
${trimmed}
"""

Extract ONLY what is actually stated. Return ONLY a JSON object with this exact shape, no other text:
{
  "destination": "<city/place name exactly as implied by the text, or null if none is stated>",
  "startDate": "<YYYY-MM-DD, only if an actual specific date or an unambiguous relative date (e.g. 'tomorrow', 'next Monday') is stated — resolve it against today's real date above — otherwise null>",
  "endDate": "<YYYY-MM-DD, same rule as startDate, otherwise null>",
  "durationDays": <a real number of days if the text states a trip length (e.g. "5 days", "a week" = 7), or null if not stated>,
  "interests": [<short lowercase keywords for real stated interests, e.g. "museums", "food", "nightlife" — empty array if none stated>],
  "budget": <a real number if a budget amount is stated, or null>,
  "currency": "<the currency code/symbol as stated (e.g. 'EUR', 'USD'), or null>"
}

Do not invent a destination, a date, or a budget the text does not actually state. If the text gives a duration ("5 days") but no real start date, startDate and endDate must both be null — do not guess a start date from today's date.`;

  let raw: string;
  try {
    raw = await callOllama(prompt, 300);
  } catch (err) {
    if (err instanceof ExtractionUnavailableError) throw err;
    throw new ExtractionUnavailableError("AI_UNREACHABLE", `Ollama'ya ulaşılamadı (${config.OLLAMA_BASE_URL}).`);
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const validated = parsedTripSchema.safeParse(parsedJson);
  if (!validated.success) return null;
  return validated.data;
}
