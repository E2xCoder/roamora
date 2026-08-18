/**
 * Platform boilerplate detection.
 *
 * When a post is deleted, private or region-locked, the platform still serves
 * its generic chrome — "TikTok - Make Your Day", "Instagram", "Watch on
 * YouTube". Without this check the pipeline treated that chrome as post
 * content: it extracted "Make Your Day" as a place name, geocoded it to an
 * unrelated shop in Greece, and reported 0.65 confidence.
 *
 * A confident wrong answer is worse than an honest failure (spec §99), so
 * boilerplate is rejected outright rather than being fed into extraction.
 */

const BOILERPLATE_TITLES = [
  /^tiktok\b.*make your day/i,
  /^tiktok$/i,
  /^instagram$/i,
  /^instagram\s*[-–|]\s*/i,
  /login\s*[·•|-]\s*instagram/i,
  /^watch\s+on\s+youtube$/i,
  /^youtube$/i,
  /^before you continue to youtube/i,
  /^google maps$/i,
  /^komoot$/i,
  /^(page not found|404|not found)/i,
  /^access denied/i,
  /^just a moment/i, // Cloudflare interstitial
  /^attention required/i,
  /^are you a robot/i,
  /^log in or sign up/i,
  /^sign up$/i,
  /^error$/i,
];

const BOILERPLATE_DESCRIPTIONS = [
  /make your day/i,
  /create an account or log in to instagram/i,
  /enjoy the videos and music you love, upload original content/i,
  /^\s*$/,
];

export interface BoilerplateVerdict {
  isBoilerplate: boolean;
  reason?: string;
}

export function checkBoilerplate(
  title?: string,
  description?: string
): BoilerplateVerdict {
  const t = title?.trim() ?? "";
  const d = description?.trim() ?? "";

  if (!t && !d) {
    return { isBoilerplate: true, reason: "Sayfa hiç üstveri döndürmedi" };
  }

  for (const re of BOILERPLATE_TITLES) {
    if (re.test(t)) {
      return {
        isBoilerplate: true,
        reason: `Platformun genel sayfası döndü ("${t.slice(0, 50)}") — gönderi silinmiş, gizli ya da bölge kısıtlı olabilir`,
      };
    }
  }

  // A description that is only platform marketing carries no post content.
  if (!d || BOILERPLATE_DESCRIPTIONS.some((re) => re.test(d))) {
    // A real title with no usable description is still worth trying.
    if (!t) {
      return { isBoilerplate: true, reason: "Gönderi metni alınamadı" };
    }
  }

  return { isBoilerplate: false };
}
