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
 *
 * `state` distinguishes four situations a boolean `available` collapsed into
 * one — a plan that silently reports "web research not available" reads very
 * differently depending on *why*:
 *   not-configured — no URL/config set at all; nothing was ever attempted.
 *   unavailable    — configured, but genuinely nothing is listening
 *                     (Node's fetch surfaces this as ECONNREFUSED) — the
 *                     process isn't running.
 *   starting       — configured and something answered the TCP handshake,
 *                     but the request timed out rather than completing —
 *                     the real, observable shape of OpenTripPlanner mid-graph-load:
 *                     the JVM process is up long before its HTTP server
 *                     finishes initializing.
 *   unhealthy      — reachable and responded, but not usably (wrong status,
 *                     Ollama up with the wrong model pulled, etc).
 *   available       — reachable and working.
 * `starting` is only ever reported from an actual timeout signature, never
 * guessed from elapsed time or a hardcoded delay — there is no synthetic
 * "starting" state here, only what the two distinguishable fetch failure
 * modes (connection refused vs timeout) actually support.
 */

export type CapabilityState = "available" | "starting" | "unhealthy" | "unavailable" | "not-configured";

export interface Capability {
  id: string;
  state: CapabilityState;
  /** True only for `state === "available"` — kept for existing call sites that only need a yes/no. */
  available: boolean;
  detail: string;
  /** What the user must do to enable it. */
  remedy?: string;
}

let cached: Map<string, Capability> | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;

function cap(id: string, state: CapabilityState, detail: string, remedy?: string): Capability {
  return { id, state, available: state === "available", detail, remedy };
}

/** Classifies a fetch failure as connection-refused ("unavailable") vs a timeout ("starting"), rather than collapsing both into one generic failure. */
function classifyFetchError(err: unknown): "unavailable" | "starting" {
  if (err instanceof Error && err.name === "TimeoutError") return "starting";
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  if (cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND") return "unavailable";
  // Unclassified network errors (DNS hiccup, reset mid-response, etc.) — a
  // real distinction can't be made from the signal available, so this falls
  // to the more conservative label rather than claiming a specific cause.
  return "unavailable";
}

async function probeYtDlp(): Promise<Capability> {
  try {
    const { stdout } = await execAsync(`"${config.YTDLP_PATH}" --version`, {
      timeout: 8000,
    });
    return cap("ytdlp", "available", `yt-dlp ${stdout.trim()}`);
  } catch {
    return cap(
      "ytdlp",
      "unavailable",
      "yt-dlp bulunamadı",
      "TikTok/Instagram içeriğinden otomatik yer çıkarımı için yt-dlp gerekiyor: `pip install -U yt-dlp` (ya da YTDLP_PATH ile tam yolu belirt)."
    );
  }
}

async function probeAi(): Promise<Capability> {
  if (config.AI_PROVIDER === "none") {
    return cap("ai", "not-configured", "AI devre dışı (AI_PROVIDER=none)", "AI_PROVIDER=ollama yaparak etkinleştir.");
  }

  let res: Response;
  try {
    res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    const state = classifyFetchError(err);
    return cap(
      "ai",
      state,
      state === "starting"
        ? `Ollama başlıyor gibi görünüyor, zaman aşımı (${config.OLLAMA_BASE_URL})`
        : `Ollama'ya ulaşılamıyor (${config.OLLAMA_BASE_URL})`,
      "Ollama'yı başlat: `ollama serve`"
    );
  }

  if (!res.ok) {
    return cap("ai", "unhealthy", `Ollama ${res.status} döndürdü (${config.OLLAMA_BASE_URL})`, "Ollama servisinin loglarını kontrol et.");
  }

  const data = (await res.json()) as { models?: Array<{ name: string }> };
  const models = data.models?.map((m) => m.name) ?? [];
  const hasModel = models.some((m) => m.startsWith(config.OLLAMA_MODEL.split(":")[0]));

  if (!hasModel) {
    return cap(
      "ai",
      "unhealthy",
      `Ollama çalışıyor ama "${config.OLLAMA_MODEL}" kurulu değil`,
      `Modeli indir: \`ollama pull ${config.OLLAMA_MODEL}\``
    );
  }

  return cap("ai", "available", `Ollama · ${config.OLLAMA_MODEL}`);
}

async function probeSearxng(): Promise<Capability> {
  if (!config.SEARXNG_URL) {
    return cap(
      "search",
      "not-configured",
      "SEARXNG_URL yapılandırılmamış",
      "Açılış saati/fiyat/etkinlik gibi web araştırması gerektiren adımlar için: `docker compose up -d searxng` ile self-host et, sonra SEARXNG_URL ayarla."
    );
  }

  let res: Response;
  try {
    const url = new URL("/search", config.SEARXNG_URL);
    url.searchParams.set("q", "test");
    url.searchParams.set("format", "json");
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    const state = classifyFetchError(err);
    return cap(
      "search",
      state,
      state === "starting"
        ? `SearXNG başlıyor gibi görünüyor, zaman aşımı (${config.SEARXNG_URL})`
        : `SearXNG'e ulaşılamıyor (${config.SEARXNG_URL})`,
      "SearXNG konteynerinin çalıştığından emin ol: `docker compose ps searxng`"
    );
  }

  if (!res.ok) {
    return cap("search", "unhealthy", `SearXNG ${res.status} döndürdü (${config.SEARXNG_URL})`, "SearXNG konteynerinin loglarını kontrol et: `docker compose logs searxng`");
  }

  return cap("search", "available", `SearXNG (${config.SEARXNG_URL})`);
}

async function probeOtp(): Promise<Capability> {
  if (!config.OTP_URL) {
    return cap(
      "transit",
      "not-configured",
      "OTP_URL yapılandırılmamış",
      "Toplu taşıma rotalaması için OpenTripPlanner ayrı bir servis olarak kurulmalı (OSM + GTFS verisiyle beslenir) — bu tek başına bir kod değişikliği değil, gerçek bir altyapı kurulumu. Kurulana kadar rotalar yalnızca yürüyüşle hesaplanır."
    );
  }

  let res: Response;
  try {
    // OTP 2.x's routable server exposes build info at `/otp`; the old OTP1
    // `/otp/routers/default` REST path this used to check no longer exists
    // in 2.9 and always 404s, which made this probe report "available" wrong.
    res = await fetch(`${config.OTP_URL}/otp`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // OTP's own HTTP server does not start listening until AFTER its graph
    // has finished loading (which can take from seconds to a couple of
    // minutes) — a timeout here is the real, observable "still starting"
    // shape, not a guess, since the JVM process can be up long before the
    // port is bound.
    const state = classifyFetchError(err);
    return cap(
      "transit",
      state,
      state === "starting"
        ? `OpenTripPlanner başlıyor (graph yükleniyor), henüz yanıt vermiyor (${config.OTP_URL})`
        : `OpenTripPlanner'a ulaşılamıyor (${config.OTP_URL})`,
      "OTP servisinin çalıştığından emin ol: `docker compose ps otp` / `docker compose logs otp`"
    );
  }

  if (!res.ok) {
    return cap("transit", "unhealthy", `OpenTripPlanner ${res.status} döndürdü (${config.OTP_URL})`, "OTP konteynerinin loglarını kontrol et: `docker compose logs otp`");
  }

  return cap("transit", "available", `OpenTripPlanner (${config.OTP_URL})`);
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
