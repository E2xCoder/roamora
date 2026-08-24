import "server-only";
import { detectStaleness } from "@/server/services/confidence";

/**
 * Purpose-built verification layer for LLM-extracted prices — the
 * counterpart to opening-hours-guard.ts. Until now `priceAmount` had no
 * validation beyond a schema-level "is it a number between 0 and 100,000"
 * (fact-extraction.ts's `factsSchema`), which cannot catch a real, common
 * class of wrong-but-plausible-looking price: a child/reduced fare read as
 * the standard adult price, a "from €X" minimum read as the full price, or
 * a stale price left over from an old season.
 *
 * Same failure direction as the hours guard: every check here can only turn
 * a "yes" into "unknown", never invent or repair a value.
 */

export type PriceGuardResult =
  | { status: "valid"; amount: number; currency: string | null; priceType: "standard" }
  | { status: "valid-minimum"; amount: number; currency: string | null } // "from €23" — a floor, not the full/standard price
  | { status: "valid-reduced"; amount: number; currency: string | null } // a child/student/senior fare, not the standard adult price
  | { status: "unknown"; reason: string };

/**
 * A real currency symbol/code, not the punctuation Central-European price
 * notation ("169,-" — a whole number, no decimals) gets mistaken for one.
 * Real, live-observed case: extracting a real Prague restaurant's real menu
 * ("169,-" meaning 169 Kč) returned `currency: ",-"` for every single item —
 * the model read the price-formatting mark itself as if it were the stated
 * currency. An ISO 4217 code is always exactly 3 letters; everything else
 * must match a real, known symbol/shorthand actually seen in this
 * pipeline's real research — never accepted on "not obviously wrong" alone.
 */
const KNOWN_CURRENCY_SYMBOLS = new Set([
  "€", "$", "£", "¥", "₺", "₽", "₹", "₩", "zł", "kč", "ft", "kr", "chf", "r$",
]);

export function normalizeCurrency(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[a-z]{3}$/i.test(trimmed)) return trimmed.toUpperCase(); // ISO 4217 shape
  if (KNOWN_CURRENCY_SYMBOLS.has(trimmed.toLowerCase())) return trimmed;
  return null;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

/** "from €23" / "ab 23 €" / "à partir de 23€" / "od 23 zł" / "23 TL'den itibaren" — a floor, not the standard price. */
const MINIMUM_PRICE_WORDS = [
  "from", "starting at", "ab", "à partir de", "od", "poczynając od", "itibaren", "başlayan",
];

/** child/student/senior/reduced fare labels, multilingual — real risk: this becomes the reported "standard" price. */
const REDUCED_PRICE_WORDS = [
  "child", "children", "kids", "student", "senior", "reduced", "concession",
  "kind", "kinder", "ermäßigt", "schüler", "rentner",
  "enfant", "réduit", "étudiant",
  "dziecko", "dzieci", "ulgowy", "student",
  "çocuk", "öğrenci", "indirimli",
];

/** Finds the byte offset of a number (with common thousands/decimal formatting) in normalized text, or -1. */
function findNumberOffset(amount: number, text: string): number {
  // Real prices appear with a variety of decimal/thousands conventions —
  // "23.5", "23,5", "23", "23.50", "23,50" all mean the same €23,50 style
  // value depending on locale, so several renderings are tried.
  const candidates = [
    String(amount),
    amount.toFixed(2),
    amount.toFixed(2).replace(".", ","),
    Number.isInteger(amount) ? String(amount) : String(amount).replace(".", ","),
  ];
  for (const c of candidates) {
    const idx = text.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Text within `radius` characters before the matched number — where a "from"/"child" qualifier would realistically sit. */
function contextWindow(text: string, offset: number, radius = 40): string {
  return text.slice(Math.max(0, offset - radius), offset);
}

/**
 * The single entry point: takes the model's extracted price plus the source
 * page text it came from, and returns a verdict distinguishing a genuine
 * standard price from a minimum, a reduced fare, or an unsupported number.
 */
export function validateExtractedPrice(
  amount: number | null,
  currency: string | null,
  sourceText: string
): PriceGuardResult {
  if (amount == null) return { status: "unknown", reason: "fiyat çıkarılmadı" };
  if (amount < 0) return { status: "unknown", reason: "negatif fiyat, geçersiz" };

  const normalizedSource = normalize(sourceText);
  const offset = findNumberOffset(amount, normalizedSource);

  if (offset === -1) {
    return { status: "unknown", reason: "çıkarılan fiyat kaynak sayfada bulunamadı" };
  }

  if (detectStaleness(sourceText)) {
    return { status: "unknown", reason: "fiyat eski bir güncelleme tarihi yakınında bulundu, güncel olmayabilir" };
  }

  const validCurrency = normalizeCurrency(currency);
  const before = contextWindow(normalizedSource, offset);

  if (REDUCED_PRICE_WORDS.some((w) => before.includes(w))) {
    return { status: "valid-reduced", amount, currency: validCurrency };
  }
  if (MINIMUM_PRICE_WORDS.some((w) => before.includes(w))) {
    return { status: "valid-minimum", amount, currency: validCurrency };
  }

  return { status: "valid", amount, currency: validCurrency, priceType: "standard" };
}
