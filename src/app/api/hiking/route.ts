import { NextResponse } from "next/server";
import { searchHikingTrails } from "@/lib/overpass";
import { searchTrails, getTrailsByBbox } from "@/lib/waymarked";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source") || "waymarked";
  const query = searchParams.get("q");
  const south = searchParams.get("south");
  const west = searchParams.get("west");
  const north = searchParams.get("north");
  const east = searchParams.get("east");
  const trailType = searchParams.get("type") as "international" | "national" | "regional" | "all" | null;

  if (source === "waymarked") {
    if (query) {
      const results = await searchTrails(query);
      return NextResponse.json(results);
    }
    if (south && west && north && east) {
      const bbox = {
        south: parseFloat(south),
        west: parseFloat(west),
        north: parseFloat(north),
        east: parseFloat(east),
      };
      const results = await getTrailsByBbox(bbox);
      return NextResponse.json(results);
    }
    return NextResponse.json({ error: "Provide q or bbox params" }, { status: 400 });
  }

  if (source === "overpass") {
    if (!south || !west || !north || !east) {
      return NextResponse.json({ error: "Provide bbox params" }, { status: 400 });
    }
    const bbox = {
      south: parseFloat(south),
      west: parseFloat(west),
      north: parseFloat(north),
      east: parseFloat(east),
    };
    const results = await searchHikingTrails(bbox, trailType || "all");
    return NextResponse.json(results);
  }

  return NextResponse.json({ error: "Unknown source" }, { status: 400 });
}
