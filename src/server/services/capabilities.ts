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

export async function getCapabilities(): Promise<Capability[]> {
  if (cached && Date.now() - cachedAt < TTL_MS) {
    return [...cached.values()];
  }

  const results = await Promise.all([probeYtDlp(), probeAi()]);
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
