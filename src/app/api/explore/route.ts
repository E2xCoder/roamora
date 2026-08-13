import { NextResponse } from "next/server";
import { getHiddenGems } from "@/lib/overpass";
import { searchDestination, getDestinationContent, parseListings } from "@/lib/wikivoyage";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source") || "overpass";
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");
  const query = searchParams.get("q");
  const radius = searchParams.get("radius") || "10000";

  if (source === "overpass" && lat && lng) {
    const gems = await getHiddenGems(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(radius, 10)
    );
    return NextResponse.json(gems);
  }

  if (source === "wikivoyage" && query) {
    const results = await searchDestination(query);
    if (results.length === 0) return NextResponse.json([]);

    const content = await getDestinationContent(results[0].title);
    const listings = parseListings(content.wikitext);
    return NextResponse.json({
      title: content.title,
      sections: content.sections,
      listings,
    });
  }

  return NextResponse.json(
    { error: "Provide source=overpass with lat/lng, or source=wikivoyage with q" },
    { status: 400 }
  );
}
