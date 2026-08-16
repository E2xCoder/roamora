import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractFromUrl, extractPlaceWithAI } from "@/lib/extract-place";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Extract info from URL using yt-dlp
    const extracted = await extractFromUrl(url);

    // If no place found from text patterns, try AI
    if (!extracted.placeName && (extracted.title || extracted.description)) {
      const aiPlace = await extractPlaceWithAI(
        `${extracted.title} ${extracted.description}`
      );
      if (aiPlace) {
        extracted.placeName = aiPlace;
        // Geocode the AI-extracted place
        try {
          const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(aiPlace)}&format=json&limit=1`,
            { headers: { "User-Agent": "Roamora/1.0" } }
          );
          const geoData = await geoRes.json();
          if (geoData.length > 0) {
            extracted.lat = parseFloat(geoData[0].lat);
            extracted.lng = parseFloat(geoData[0].lon);
          }
        } catch {
          // geocoding failed
        }
      }
    }

    // Return extracted data for user confirmation before saving
    return NextResponse.json({
      extracted,
      needsConfirmation: true,
    });
  } catch (err) {
    console.error("Extract error:", err);
    return NextResponse.json(
      { error: "Failed to extract from URL" },
      { status: 500 }
    );
  }
}

// Save confirmed place
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { name, lat, lng, category, notes, sourceUrl, thumbnailPath, thumbnailUrl, platform } = body;

    if (!name || lat == null || lng == null) {
      return NextResponse.json(
        { error: "Name, lat, lng are required" },
        { status: 400 }
      );
    }

    const place = await prisma.place.create({
      data: {
        name,
        lat,
        lng,
        category: category || "other",
        tags: JSON.stringify([platform || "social", "saved"]),
        notes: notes || "",
        source: platform || "social",
        imageUrl: thumbnailPath || thumbnailUrl || null,
        isHiddenGem: false,
      },
    });

    return NextResponse.json({
      ...place,
      tags: JSON.parse(place.tags),
    });
  } catch (err) {
    console.error("Save error:", err);
    return NextResponse.json(
      { error: "Failed to save place" },
      { status: 500 }
    );
  }
}
