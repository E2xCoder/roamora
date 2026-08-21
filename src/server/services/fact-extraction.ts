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

const factsSchema = z.object({
  openingHoursText: z.string().max(200).nullable(),
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

async function callOllama(prompt: string): Promise<string> {
  const res = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 200 },
    }),
    signal: AbortSignal.timeout(30_000),
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

  const trimmed = pageText.slice(0, 4000).trim();
  if (!trimmed) return null;

  const prompt = `You are reading a web page about travel destinations. Find facts specifically about this place: "${placeName}".

Page text:
"""
${trimmed}
"""

Return ONLY a JSON object with this exact shape, no other text:
{
  "openingHoursText": "<the opening hours as literally stated, e.g. 'Mon-Fri 9:00-17:00', or null if not found>",
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
  if (validated.data.openingHoursText == null && validated.data.priceAmount == null) {
    return null; // nothing useful extracted
  }

  return { facts: validated.data, confidence: "medium" };
}

/**
 * Converts a free-text opening-hours statement extracted by the model (e.g.
 * "Mon-Fri 9:00-17:00, Sat 10:00-14:00") into OSM `opening_hours` syntax, so
 * it can be resolved by the same deterministic parser used for real OSM tags.
 * Deliberately narrow: only handles the exact patterns the extraction prompt
 * asks the model to produce. Anything else returns null rather than guessing
 * a translation.
 */
export function looseTextToOsmSyntax(text: string): string | null {
  const DAY_NAMES: Record<string, string> = {
    monday: "Mo", mon: "Mo",
    tuesday: "Tu", tue: "Tu", tues: "Tu",
    wednesday: "We", wed: "We",
    thursday: "Th", thu: "Th", thur: "Th", thurs: "Th",
    friday: "Fr", fri: "Fr",
    saturday: "Sa", sat: "Sa",
    sunday: "Su", sun: "Su",
  };

  let normalized = text.trim();
  if (!normalized) return null;

  // Replace English day names/abbreviations with OSM's two-letter tokens.
  normalized = normalized.replace(/\b([A-Za-z]+)\b/g, (word) => {
    const key = word.toLowerCase();
    return DAY_NAMES[key] ?? word;
  });

  // Already looks like OSM syntax (e.g. "Mo-Fr 9:00-17:00") — pad single-digit
  // hours to two digits, which the deterministic parser requires.
  const padded = normalized.replace(
    /\b(\d):([0-5]\d)\b/g,
    (_, h: string, m: string) => `0${h}:${m}`
  );

  const looksValid = /^(Mo|Tu|We|Th|Fr|Sa|Su)/.test(padded) && /\d{2}:\d{2}-\d{2}:\d{2}/.test(padded);
  return looksValid ? padded : null;
}
