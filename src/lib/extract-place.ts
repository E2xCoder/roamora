import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execAsync = promisify(exec);

export interface ExtractedPlace {
  title: string;
  description: string;
  thumbnailUrl?: string;
  thumbnailPath?: string;
  videoUrl?: string;
  platform: "tiktok" | "instagram" | "unknown";
  placeName?: string;
  lat?: number;
  lng?: number;
  category?: string;
  sourceUrl: string;
}

interface YtDlpInfo {
  title?: string;
  description?: string;
  thumbnail?: string;
  location?: string;
  channel?: string;
  uploader?: string;
  webpage_url?: string;
  id?: string;
}

function detectPlatform(url: string): "tiktok" | "instagram" | "unknown" {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  return "unknown";
}

export async function extractFromUrl(url: string): Promise<ExtractedPlace> {
  const platform = detectPlatform(url);

  let info: YtDlpInfo = {};
  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-download --no-warnings "${url}"`,
      { timeout: 30000, maxBuffer: 1024 * 1024 * 10 }
    );
    info = JSON.parse(stdout);
  } catch (err) {
    console.error("yt-dlp failed:", (err as Error).message);
  }

  const title = info.title || "";
  const description = info.description || "";

  // Download thumbnail
  let thumbnailPath: string | undefined;
  if (info.thumbnail) {
    try {
      const thumbDir = path.join(process.cwd(), "public", "thumbnails");
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = `${info.id || Date.now()}.jpg`;
      const thumbPath = path.join(thumbDir, thumbName);

      await execAsync(
        `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "${thumbPath.replace('.jpg', '')}" "${url}"`,
        { timeout: 15000 }
      );

      // yt-dlp adds extension, find the file
      const files = await fs.readdir(thumbDir);
      const matchingFile = files.find(f => f.startsWith(info.id || String(Date.now())));
      if (matchingFile) {
        thumbnailPath = `/thumbnails/${matchingFile}`;
      }
    } catch {
      // thumbnail download failed, use URL instead
    }
  }

  // Try to extract place name from text
  const fullText = `${title} ${description}`;
  let placeName = extractPlaceFromText(fullText);

  // Try geocoding if we have a place name
  let lat: number | undefined;
  let lng: number | undefined;

  if (placeName) {
    const geo = await geocodePlace(placeName);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      if (!placeName || placeName === geo.displayName) {
        placeName = geo.displayName;
      }
    }
  }

  return {
    title,
    description: description.slice(0, 500),
    thumbnailUrl: info.thumbnail,
    thumbnailPath,
    platform,
    placeName,
    lat,
    lng,
    category: guessCategory(fullText),
    sourceUrl: url,
  };
}

export async function extractPlaceWithAI(text: string): Promise<string | null> {
  try {
    const prompt = `Extract the specific place name (restaurant, cafe, attraction, hotel, park, etc.) from this social media post. Return ONLY the place name, nothing else. If you can't find a specific place, return "NONE".

Post: ${text.slice(0, 1000)}`;

    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 100 },
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const answer = data.response?.trim();
    if (!answer || answer === "NONE" || answer.length > 200) return null;
    return answer;
  } catch {
    return null;
  }
}

function extractPlaceFromText(text: string): string | undefined {
  // Try common patterns: "📍Place Name" or "at Place Name" or location tags
  const patterns = [
    /📍\s*([^,\n#@]+)/,
    /📌\s*([^,\n#@]+)/,
    /🏠\s*([^,\n#@]+)/,
    /(?:at|@)\s+([A-Z][^,\n#@]{2,40})/,
    /(?:in|visit|explore|discover)\s+([A-Z][^,\n#@]{2,40})/i,
    /(?:located|location|place|spot)[:.]?\s*([^,\n#@]{2,50})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  // Try hashtag-based location extraction
  const hashtagPattern = /#(\w+(?:restaurant|cafe|hotel|beach|park|museum|castle|palace|church|mosque|temple|cathedral|bar|club|market|bazaar|tower|bridge|square|garden|trail|waterfall|lake|mountain|island|bay|harbor|port|valley|gorge|canyon|cave|springs?|viewpoint|lookout))/gi;
  const hashMatch = text.match(hashtagPattern);
  if (hashMatch) {
    return hashMatch[0].replace("#", "").replace(/([A-Z])/g, " $1").trim();
  }

  // Try to find city/country mentions with hashtags
  const locationHashtags = text.match(/#(istanbul|paris|london|rome|barcelona|prague|vienna|amsterdam|berlin|munich|budapest|lisbon|athens|santorini|dubai|tokyo|newyork|cappadocia|antalya|bodrum|fethiye|izmir|florence|venice|milan|naples|dubrovnik|split|krakow|warsaw|copenhagen|stockholm|oslo|bergen|zurich|interlaken|malaga|seville|granada|nice|marseille)\b/gi);
  if (locationHashtags) {
    return locationHashtags[0].replace("#", "");
  }

  return undefined;
}

function guessCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/restaurant|food|yemek|eat|dinner|lunch|breakfast|brunch|cuisine|chef|dish|menu/i.test(lower)) return "restaurant";
  if (/cafe|café|coffee|kahve|latte|cappuccino|bakery|pastry/i.test(lower)) return "cafe";
  if (/bar|cocktail|pub|wine|beer|nightlife|club|party|disco/i.test(lower)) return "nightlife";
  if (/hotel|hostel|stay|accommodation|airbnb|resort|boutique hotel/i.test(lower)) return "accommodation";
  if (/beach|plaj|sahil|deniz|sea|ocean|coast|surf/i.test(lower)) return "beach";
  if (/hike|hiking|trail|trek|mountain|dağ|walk|nature|doğa|forest|orman|waterfall|şelale/i.test(lower)) return "hiking";
  if (/museum|müze|gallery|galeri|art|sanat|exhibition/i.test(lower)) return "museum";
  if (/castle|kale|palace|saray|mosque|cami|church|cathedral|historic|tarihi|ruins|ancient/i.test(lower)) return "historic";
  if (/view|manzara|panorama|sunset|sunrise|viewpoint|rooftop/i.test(lower)) return "viewpoint";
  if (/shop|market|bazaar|mall|shopping|alışveriş/i.test(lower)) return "shopping";
  if (/park|garden|bahçe|lake|göl|island|ada/i.test(lower)) return "nature";
  return "attraction";
}

async function geocodePlace(query: string): Promise<{ lat: number; lng: number; displayName: string } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`,
      { headers: { "User-Agent": "Roamora/1.0" } }
    );
    const data = await res.json();
    if (data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        displayName: data[0].display_name,
      };
    }
  } catch {
    // ignore
  }
  return null;
}
