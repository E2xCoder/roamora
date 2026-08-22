import "server-only";
import { z } from "zod";
import { config } from "@/server/config";
import { callOllama, htmlToPlainText, ExtractionUnavailableError, repairTruncatedJsonArray } from "@/server/services/fact-extraction";

/**
 * Structured menu/local-food extraction — the restaurant counterpart to
 * event-extraction.ts. A restaurant is explicitly NOT modeled as one generic
 * price (spec §Priority 3): the model is asked to list actual individual
 * menu items with their own price/portion/description, exactly the way
 * event-extraction.ts lists individual dated events rather than one
 * generic "event" fact. Same discipline throughout: state what the page
 * actually says, return nothing for a field that isn't stated, never guess
 * a price or a dish name.
 */

const menuItemSchema = z.object({
  category: z.string().max(60),
  name: z.string().max(150),
  description: z.string().max(300).nullable(),
  price: z.number().min(0).max(10_000).nullable(),
  currency: z.string().max(6).nullable(),
  portion: z.string().max(60).nullable(),
  isLocalSpecialty: z.boolean(),
  isVegetarian: z.boolean(),
  isVegan: z.boolean(),
});

const menuSchema = z.object({
  menuItems: z.array(menuItemSchema).max(20),
});

export type ExtractedMenuItem = z.infer<typeof menuItemSchema>;

/**
 * Extracts individual menu items (category, name, price, portion,
 * description, dietary flags) from a restaurant's real page text. Returns an
 * empty array when the page has no real menu content — never invents items
 * to fill a category.
 */
export async function extractMenuFromText(placeName: string, pageText: string): Promise<ExtractedMenuItem[]> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError("AI_DISABLED", "AI sağlayıcı devre dışı (AI_PROVIDER=none).");
  }

  const trimmed = htmlToPlainText(pageText).slice(0, 4000).trim();
  if (!trimmed) return [];

  const prompt = `You are reading a real restaurant's web page, "${placeName}". Find its actual menu items, if any are stated on this page.

Page text:
"""
${trimmed}
"""

List every DISTINCT menu item with a name clearly stated on this page, up to 20. Return ONLY a JSON object with this exact shape, no other text:
{
  "menuItems": [
    {
      "category": "<the menu section this item is under, e.g. 'Starters', 'Main Courses', 'Desserts', 'Drinks' — as stated on the page, or 'Menu' if no section is given>",
      "name": "<the dish/drink name exactly as stated>",
      "description": "<a short description if the page gives one, or null>",
      "price": <the item's price as a number, or null if not stated>,
      "currency": "<the currency symbol/code as stated, or null>",
      "portion": "<size/portion as stated (e.g. '0.5L', 'Large'), or null>",
      "isLocalSpecialty": <true only if the page itself labels this as a local/traditional/regional specialty>,
      "isVegetarian": <true only if the page itself labels this vegetarian>,
      "isVegan": <true only if the page itself labels this vegan>
    }
  ]
}

Do not guess a price or invent a dish. Only include an item whose name is actually stated on this page. If the page has no real menu content, return {"menuItems": []}.`;

  let raw: string;
  try {
    // A real menu of up to 20 items needs far more than the 200-token
    // default sized for a single fact — see callOllama's docstring for the
    // real, live-observed truncation bug this fixes (confirmed directly: a
    // genuine German restaurant menu page produced a 629-char, mid-object
    // truncated response at the old default, every time; 1500 tokens still
    // cut off a real 14-item menu one item short of the closing bracket).
    raw = await callOllama(prompt, 2200);
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
    // The response was cut off mid-generation — salvage whichever items
    // completed before the truncation rather than losing all of them.
    const salvaged = repairTruncatedJsonArray(raw, "menuItems");
    const validatedItems = salvaged
      .map((item) => menuItemSchema.safeParse(item))
      .filter((r) => r.success)
      .map((r) => r.data);
    return validatedItems;
  }

  const validated = menuSchema.safeParse(parsedJson);
  if (!validated.success) return [];
  return validated.data.menuItems;
}

const localFoodItemSchema = z.object({
  name: z.string().max(150),
  description: z.string().max(300).nullable(),
});

const localFoodSchema = z.object({
  iconicDish: localFoodItemSchema.nullable(),
  traditionalDish: localFoodItemSchema.nullable(),
  dessert: localFoodItemSchema.nullable(),
  bakerySpecialty: localFoodItemSchema.nullable(),
  localDrink: localFoodItemSchema.nullable(),
  affordableLocalOption: localFoodItemSchema.nullable(),
});

export type ExtractedLocalFood = z.infer<typeof localFoodSchema>;

/**
 * Extracts destination-level local food facts (spec §Priority 3.6): one
 * iconic dish, one traditional dish, a dessert, a bakery specialty, a local
 * drink, and an affordable local option — each independently nullable, since
 * a real page rarely states all six. Every non-null field is independently
 * re-verified against the source text by the caller (its name must actually
 * appear on the page) before being trusted, the same discipline as every
 * other extractor in this pipeline.
 */
export async function extractLocalFoodFromText(destination: string, pageText: string): Promise<ExtractedLocalFood | null> {
  if (config.AI_PROVIDER === "none") {
    throw new ExtractionUnavailableError("AI_DISABLED", "AI sağlayıcı devre dışı (AI_PROVIDER=none).");
  }

  const trimmed = htmlToPlainText(pageText).slice(0, 4000).trim();
  if (!trimmed) return null;

  const prompt = `You are reading a real web page about local food in "${destination}".

Page text:
"""
${trimmed}
"""

Find, if actually stated on this page:
- one iconic dish this destination is most known for
- one traditional dish (may be the same as the iconic dish if the page only names one)
- a local dessert
- a bakery specialty (a baked good, not a full dish)
- a local drink (alcoholic or not)
- an affordable, everyday local food option a budget traveller could get

Return ONLY a JSON object with this exact shape, no other text:
{
  "iconicDish": {"name": "<name>", "description": "<short description or null>"} or null,
  "traditionalDish": {"name": "<name>", "description": "<short description or null>"} or null,
  "dessert": {"name": "<name>", "description": "<short description or null>"} or null,
  "bakerySpecialty": {"name": "<name>", "description": "<short description or null>"} or null,
  "localDrink": {"name": "<name>", "description": "<short description or null>"} or null,
  "affordableLocalOption": {"name": "<name>", "description": "<short description or null>"} or null
}

Do not guess. Use null for any field the page does not actually mention.`;

  let raw: string;
  try {
    // Six nested objects with descriptions — more headroom than a single
    // fact needs, same reasoning as extractMenuFromText above.
    raw = await callOllama(prompt, 600);
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

  const validated = localFoodSchema.safeParse(parsedJson);
  if (!validated.success) return null;
  return validated.data;
}
