import "server-only";
import { config } from "@/server/config";
import { getCached } from "@/server/services/research-cache";

/**
 * Free, keyless daily weather forecast — Open-Meteo, the same "free/self-
 * hostable, no API key" philosophy as this project's other providers
 * (OSRM, Nominatim, Overpass, Wikivoyage). Real forecast data, honestly
 * bounded: Open-Meteo's forecast API only covers roughly 16 days ahead —
 * a trip date beyond that returns null, not a guessed or averaged value.
 */

export type WeatherCondition = "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm";

export interface WeatherForecast {
  date: string; // YYYY-MM-DD
  weatherCode: number; // raw WMO code, kept for transparency
  condition: WeatherCondition;
  /** 0-100, or null when Open-Meteo did not report it for this day. */
  precipitationProbability: number | null;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
}

const NAMESPACE = "weather-forecast";
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours — a real forecast changes meaningfully within a day, unlike geocoding/Wikipedia content

/**
 * WMO weather interpretation codes (the standard Open-Meteo, and most
 * other forecast APIs, report) collapsed to the six real distinctions
 * this pipeline actually acts on. https://open-meteo.com/en/docs — the
 * code ranges below are that standard's own grouping, not invented here.
 */
export function classifyWeatherCode(code: number): WeatherCondition {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code === 95 || code === 96 || code === 99) return "storm"; // the only three WMO codes actually defined as thunderstorm
  return "cloudy"; // an unrecognised code is treated as the mildest non-clear bucket, never guessed as clear or severe
}

/**
 * Whether this forecast should actually change routing decisions (spec
 * §Priority 6) — real, textually-supported reasoning, not a vague "looks
 * bad" heuristic: a storm is always disruptive regardless of the
 * reported probability (Open-Meteo sometimes omits precipitation
 * probability for a storm-coded day); rain/snow only counts when the
 * reported probability clears a real threshold, so a 10%-chance drizzle
 * classification doesn't flip an entire day's plan to "indoor-biased".
 */
export function isBadWeatherDay(forecast: WeatherForecast): boolean {
  if (forecast.condition === "storm") return true;
  if (forecast.condition === "rain" || forecast.condition === "snow") {
    return forecast.precipitationProbability == null || forecast.precipitationProbability >= 50;
  }
  return false;
}

/**
 * Fetches the real daily forecast for one date at one coordinate. Returns
 * null — never a guess — when the date is outside Open-Meteo's real
 * forecast horizon or the request fails.
 */
export async function fetchDailyForecast(
  lat: number,
  lng: number,
  date: string
): Promise<WeatherForecast | null> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}|${date}`;
  return getCached(NAMESPACE, key, TTL_MS, async () => {
    const url = new URL(config.OPEN_METEO_URL);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set("daily", "weathercode,precipitation_probability_max,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let data: {
      daily?: {
        time?: string[];
        weathercode?: number[];
        precipitation_probability_max?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
      };
    };
    try {
      data = await res.json();
    } catch {
      return null;
    }

    const idx = data.daily?.time?.indexOf(date) ?? -1;
    if (idx === -1 || data.daily?.weathercode?.[idx] == null) {
      // Real, honest absence — beyond the forecast horizon, or Open-Meteo
      // had nothing for this exact date. Never fabricated.
      return null;
    }

    const code = data.daily.weathercode[idx];
    return {
      date,
      weatherCode: code,
      condition: classifyWeatherCode(code),
      precipitationProbability: data.daily.precipitation_probability_max?.[idx] ?? null,
      temperatureMaxC: data.daily.temperature_2m_max?.[idx] ?? null,
      temperatureMinC: data.daily.temperature_2m_min?.[idx] ?? null,
    };
  });
}
