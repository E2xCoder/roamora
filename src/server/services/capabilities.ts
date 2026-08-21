import "server-only";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "@/server/config";

const execAsync = promisify(exec);

/**
 * Runtime capability detection.
 *
 * The import endpoint used to return HTTP 200 with an empty payload when
 * yt-dlp was missing, so a missing binary was indistinguishable from a video
 * with no location. Capabilities are probed once and reported explicitly, so
 * the UI can name what is unavailable instead of showing a blank form
 * (spec §55, §98).
 */

export interface Capability {
  id: string;
  available: boolean;
  detail: string;
  /** What the user must do to enable it. */
  remedy?: string;
}

let cached: Map<string, Capability> | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function probeYtDlp(): Promise<Capability> {
  try {
    const { stdout } = await execAsync(`"${config.YTDLP_PATH}" --version`, {
      timeout: 8000,
    });
    return {
      id: "ytdlp",
      available: true,
      detail: `yt-dlp ${stdout.trim()}`,
    };
  } catch {
    return {
      id: "ytdlp",
      available: false,
      detail: "yt-dlp bulunamadı",
      remedy:
        "TikTok/Instagram içeriğinden otomatik yer çıkarımı için yt-dlp gerekiyor: `pip install -U yt-dlp` (ya da YTDLP_PATH ile tam yolu belirt).",
    };
  }
}

async function probeAi(): Promise<Capability> {
  if (config.AI_PROVIDER === "none") {
    return {
      id: "ai",
      available: false,
      detail: "AI devre dışı (AI_PROVIDER=none)",
      remedy: "AI_PROVIDER=ollama yaparak etkinleştir.",
    };
  }

  try {
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(String(res.status));

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models?.map((m) => m.name) ?? [];
    const hasModel = models.some((m) => m.startsWith(config.OLLAMA_MODEL.split(":")[0]));

    if (!hasModel) {
      return {
        id: "ai",
        available: false,
        detail: `Ollama çalışıyor ama "${config.OLLAMA_MODEL}" kurulu değil`,
        remedy: `Modeli indir: \`ollama pull ${config.OLLAMA_MODEL}\``,
      };
    }

    return { id: "ai", available: true, detail: `Ollama · ${config.OLLAMA_MODEL}` };
  } catch {
    return {
      id: "ai",
      available: false,
      detail: `Ollama'ya ulaşılamıyor (${config.OLLAMA_BASE_URL})`,
      remedy: "Ollama'yı başlat: `ollama serve`",
    };
  }
}

async function probeSearxng(): Promise<Capability> {
  if (!config.SEARXNG_URL) {
    return {
      id: "search",
      available: false,
      detail: "SEARXNG_URL yapılandırılmamış",
      remedy:
        "Açılış saati/fiyat/etkinlik gibi web araştırması gerektiren adımlar için: `docker run -d -p 8080:8080 searxng/searxng` ile self-host et, sonra SEARXNG_URL=http://localhost:8080 ayarla.",
    };
  }

  try {
    const url = new URL("/search", config.SEARXNG_URL);
    url.searchParams.set("q", "test");
    url.searchParams.set("format", "json");
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    return { id: "search", available: true, detail: `SearXNG (${config.SEARXNG_URL})` };
  } catch {
    return {
      id: "search",
      available: false,
      detail: `SearXNG'e ulaşılamıyor (${config.SEARXNG_URL})`,
      remedy: "SearXNG konteynerinin çalıştığından emin ol.",
    };
  }
}

async function probeOtp(): Promise<Capability> {
  if (!config.OTP_URL) {
    return {
      id: "transit",
      available: false,
      detail: "OTP_URL yapılandırılmamış",
      remedy:
        "Toplu taşıma rotalaması için OpenTripPlanner ayrı bir servis olarak kurulmalı (OSM + GTFS verisiyle beslenir) — bu tek başına bir kod değişikliği değil, gerçek bir altyapı kurulumu. Kurulana kadar rotalar yalnızca yürüyüşle hesaplanır.",
    };
  }

  try {
    // OTP 2.x's routable server exposes build info at `/otp`; the old OTP1
    // `/otp/routers/default` REST path this used to check no longer exists
    // in 2.9 and always 404s, which made this probe report "available" wrong.
    const res = await fetch(`${config.OTP_URL}/otp`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(String(res.status));
    return { id: "transit", available: true, detail: `OpenTripPlanner (${config.OTP_URL})` };
  } catch {
    return {
      id: "transit",
      available: false,
      detail: `OpenTripPlanner'a ulaşılamıyor (${config.OTP_URL})`,
      remedy: "OTP servisinin çalıştığından emin ol.",
    };
  }
}

export async function getCapabilities(): Promise<Capability[]> {
  if (cached && Date.now() - cachedAt < TTL_MS) {
    return [...cached.values()];
  }

  const results = await Promise.all([probeYtDlp(), probeAi(), probeSearxng(), probeOtp()]);
  cached = new Map(results.map((c) => [c.id, c]));
  cachedAt = Date.now();
  return results;
}

export async function getCapability(id: string): Promise<Capability | undefined> {
  return (await getCapabilities()).find((c) => c.id === id);
}

/** Forces the next probe to re-run (used after config changes). */
export function invalidateCapabilities() {
  cached = null;
}
