import { NextResponse } from "next/server";
import { getTrailDetail, getTrailGeometry, getTrailElevation } from "@/lib/waymarked";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trailId = parseInt(id, 10);
  const { searchParams } = new URL(request.url);
  const include = searchParams.get("include") || "detail";

  if (include === "geometry") {
    const geojson = await getTrailGeometry(trailId);
    return NextResponse.json(geojson);
  }

  if (include === "elevation") {
    const elevation = await getTrailElevation(trailId);
    return NextResponse.json(elevation);
  }

  const detail = await getTrailDetail(trailId);
  return NextResponse.json(detail);
}
