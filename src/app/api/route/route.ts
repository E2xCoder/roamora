import { NextResponse } from "next/server";

export const maxDuration = 30;

// FOSSGIS public OSRM instances (free, no API key)
const PROFILE_HOSTS: Record<string, string> = {
  foot: "https://routing.openstreetmap.de/routed-foot",
  bike: "https://routing.openstreetmap.de/routed-bike",
  car: "https://routing.openstreetmap.de/routed-car",
};

interface Waypoint {
  lat: number;
  lng: number;
}

interface OsrmLeg {
  distance: number;
  duration: number;
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: [number, number][] };
  legs: OsrmLeg[];
}

function haversine(a: Waypoint, b: Waypoint) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line fallback so the UI always has a route to draw. */
function fallbackRoute(waypoints: Waypoint[], speedMs: number) {
  const legs = waypoints.slice(0, -1).map((wp, i) => {
    const distance = haversine(wp, waypoints[i + 1]);
    return { distance, duration: distance / speedMs };
  });
  return {
    coordinates: waypoints.map((w) => [w.lat, w.lng] as [number, number]),
    distance: legs.reduce((s, l) => s + l.distance, 0),
    duration: legs.reduce((s, l) => s + l.duration, 0),
    legs,
    fallback: true,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const waypoints: Waypoint[] = body.waypoints || [];
    const profile: string = body.profile || "foot";

    if (waypoints.length < 2) {
      return NextResponse.json(
        { error: "En az 2 nokta gerekli" },
        { status: 400 }
      );
    }
    if (waypoints.length > 25) {
      return NextResponse.json(
        { error: "En fazla 25 nokta" },
        { status: 400 }
      );
    }

    // walking 1.4 m/s, cycling 4.2 m/s, driving 13.9 m/s
    const speedMs = profile === "bike" ? 4.2 : profile === "car" ? 13.9 : 1.4;
    const host = PROFILE_HOSTS[profile] || PROFILE_HOSTS.foot;
    const coords = waypoints.map((w) => `${w.lng},${w.lat}`).join(";");
    const url = `${host}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Roamora/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const data = await res.json();

      if (data.code !== "Ok" || !data.routes?.length) {
        throw new Error(data.code || "no route");
      }

      const route: OsrmRoute = data.routes[0];
      return NextResponse.json({
        // OSRM returns [lng, lat] — Leaflet wants [lat, lng]
        coordinates: route.geometry.coordinates.map(
          ([lng, lat]) => [lat, lng] as [number, number]
        ),
        distance: route.distance,
        duration: route.duration,
        legs: route.legs.map((l) => ({
          distance: l.distance,
          duration: l.duration,
        })),
        fallback: false,
      });
    } catch (err) {
      console.error("OSRM failed, using straight-line fallback:", err);
      return NextResponse.json(fallbackRoute(waypoints, speedMs));
    }
  } catch (err) {
    console.error("Route error:", err);
    return NextResponse.json({ error: "Rota olusturulamadi" }, { status: 500 });
  }
}
