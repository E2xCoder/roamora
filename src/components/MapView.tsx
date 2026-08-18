"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Circle,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import Supercluster from "supercluster";
import "leaflet/dist/leaflet.css";
import {
  CATEGORY_COLORS,
  CATEGORY_EMOJI,
  type Place,
  type UserPosition,
} from "@/lib/place-meta";

/* ---------------------------------- icons --------------------------------- */

const iconCache = new Map<string, L.DivIcon>();

function placeIcon(category: string, selected: boolean) {
  const key = `${category}:${selected}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  const emoji = CATEGORY_EMOJI[category] || "📍";
  const size = selected ? 40 : 32;

  const icon = L.divIcon({
    className: "",
    html: `<div style="
      background:${color};
      width:${size}px;height:${size}px;
      border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      border:${selected ? 3 : 2}px solid ${selected ? "#fbbf24" : "#fff"};
      box-shadow:0 3px 10px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
    "><span style="transform:rotate(45deg);font-size:${size * 0.42}px;line-height:1">${emoji}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
  iconCache.set(key, icon);
  return icon;
}

function clusterIcon(count: number) {
  const key = `cluster:${count}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const size = count < 10 ? 38 : count < 100 ? 46 : count < 1000 ? 54 : 62;
  const label = count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;

  const icon = L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:linear-gradient(135deg,#6366f1,#8b5cf6,#a855f7);
      border:3px solid rgba(255,255,255,.9);
      box-shadow:0 4px 16px rgba(99,102,241,.45);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-weight:700;font-size:${size * 0.32}px;
      font-family:system-ui,sans-serif;
    ">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  iconCache.set(key, icon);
  return icon;
}

function stopIcon(index: number, isNext: boolean) {
  const key = `stop:${index}:${isNext}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const icon = L.divIcon({
    className: "",
    html: `<div style="
      width:36px;height:36px;border-radius:50%;
      background:linear-gradient(135deg,#fbbf24,#f59e0b);
      border:3px solid ${isNext ? "#fff" : "rgba(255,255,255,.85)"};
      box-shadow:0 4px 14px rgba(245,158,11,.6)${isNext ? ",0 0 0 6px rgba(251,191,36,.25)" : ""};
      display:flex;align-items:center;justify-content:center;
      color:#1c1917;font-weight:800;font-size:15px;
      font-family:system-ui,sans-serif;
    ">${index}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
  iconCache.set(key, icon);
  return icon;
}

function userIcon(heading: number | null) {
  const arrow =
    heading != null
      ? `<div style="
          position:absolute;top:-9px;left:50%;
          transform:translateX(-50%) rotate(${heading}deg);
          transform-origin:50% 19px;
          width:0;height:0;
          border-left:6px solid transparent;
          border-right:6px solid transparent;
          border-bottom:10px solid #3b82f6;
        "></div>`
      : "";

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:20px;height:20px">
      ${arrow}
      <div style="
        width:20px;height:20px;border-radius:50%;
        background:#3b82f6;border:3px solid #fff;
        box-shadow:0 0 0 4px rgba(59,130,246,.3),0 2px 8px rgba(0,0,0,.3);
      "></div>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/* -------------------------------- clustering ------------------------------- */

type PointProps = { placeId: string; category: string; idx: number };

function ClusterLayer({
  places,
  selectedIds,
  onPlaceClick,
  onPlaceDelete,
}: {
  places: Place[];
  selectedIds: Set<string>;
  onPlaceClick?: (place: Place) => void;
  onPlaceDelete?: (id: string) => void;
}) {
  const map = useMap();
  const [version, setVersion] = useState(0);

  const index = useMemo(() => {
    const sc = new Supercluster<PointProps>({
      radius: 70,
      maxZoom: 16,
      minPoints: 3,
    });
    sc.load(
      places.map((p, idx) => ({
        type: "Feature" as const,
        properties: { placeId: p.id, category: p.category, idx },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      }))
    );
    return sc;
  }, [places]);

  // Re-compute clusters whenever the viewport settles.
  useMapEvents({
    moveend: () => setVersion((v) => v + 1),
    zoomend: () => setVersion((v) => v + 1),
  });

  useEffect(() => {
    setVersion((v) => v + 1);
  }, [index]);

  const clusters = useMemo(() => {
    if (places.length === 0) return [];
    const b = map.getBounds();
    const zoom = Math.round(map.getZoom());
    return index.getClusters(
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      zoom
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, map, version, places.length]);

  return (
    <>
      {clusters.map((c) => {
        const [lng, lat] = c.geometry.coordinates;
        const props = c.properties as Supercluster.ClusterProperties & PointProps;

        if (props.cluster) {
          return (
            <Marker
              key={`c-${c.id}`}
              position={[lat, lng]}
              icon={clusterIcon(props.point_count)}
              eventHandlers={{
                click: () => {
                  const zoom = Math.min(
                    index.getClusterExpansionZoom(c.id as number),
                    17
                  );
                  map.flyTo([lat, lng], zoom, { duration: 0.5 });
                },
              }}
            />
          );
        }

        const place = places[props.idx];
        if (!place) return null;
        const selected = selectedIds.has(place.id);

        return (
          <Marker
            key={place.id}
            position={[lat, lng]}
            icon={placeIcon(place.category, selected)}
            eventHandlers={
              onPlaceClick ? { click: () => onPlaceClick(place) } : undefined
            }
          >
            {!onPlaceClick && (
              <Popup>
                <PlacePopup place={place} onDelete={onPlaceDelete} />
              </Popup>
            )}
          </Marker>
        );
      })}
    </>
  );
}

function PlacePopup({
  place,
  onDelete,
}: {
  place: Place;
  onDelete?: (id: string) => void;
}) {
  return (
    <div className="min-w-[190px] max-w-[250px]">
      {place.imageUrl && (
        <img
          src={place.imageUrl}
          alt=""
          className="w-full h-24 object-cover rounded-lg mb-2"
        />
      )}
      <h3 className="font-bold text-sm">{place.name}</h3>
      {place.address && (
        <p className="text-xs text-gray-500 mt-0.5">{place.address}</p>
      )}
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 mt-2 rounded-full text-white text-[10px] font-medium"
        style={{
          background: CATEGORY_COLORS[place.category] || CATEGORY_COLORS.other,
        }}
      >
        {CATEGORY_EMOJI[place.category] || "📍"} {place.category}
      </span>
      {place.notes && (
        <p className="text-xs mt-2 text-gray-600 line-clamp-3">{place.notes}</p>
      )}
      {onDelete && (
        <button
          onClick={() => onDelete(place.id)}
          className="mt-2 text-xs text-red-500 hover:text-red-700 font-medium"
        >
          Sil
        </button>
      )}
    </div>
  );
}

/* ------------------------------- route layer ------------------------------- */

function RouteLayer({
  stops,
  geometry,
  activeStop,
  onStopClick,
}: {
  stops: Place[];
  geometry: [number, number][] | null;
  activeStop: number;
  onStopClick?: (place: Place) => void;
}) {
  const line: [number, number][] =
    geometry && geometry.length > 1
      ? geometry
      : stops.map((s) => [s.lat, s.lng]);

  return (
    <>
      {line.length > 1 && (
        <>
          {/* outer glow */}
          <Polyline
            positions={line}
            pathOptions={{
              color: "#fbbf24",
              weight: 14,
              opacity: 0.22,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          {/* mid glow */}
          <Polyline
            positions={line}
            pathOptions={{
              color: "#f59e0b",
              weight: 8,
              opacity: 0.45,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
          {/* core */}
          <Polyline
            positions={line}
            pathOptions={{
              color: "#fde68a",
              weight: 3.5,
              opacity: 1,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </>
      )}

      {stops.map((stop, i) => (
        <Marker
          key={`stop-${stop.id}`}
          position={[stop.lat, stop.lng]}
          icon={stopIcon(i + 1, i === activeStop)}
          zIndexOffset={1000}
          eventHandlers={
            onStopClick ? { click: () => onStopClick(stop) } : undefined
          }
        >
          <Popup>
            <div className="min-w-[160px]">
              <div className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">
                Durak {i + 1}
              </div>
              <h3 className="font-bold text-sm mt-0.5">{stop.name}</h3>
              {stop.address && (
                <p className="text-xs text-gray-500 mt-0.5">{stop.address}</p>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/* ------------------------------ live location ------------------------------ */

function LiveLocation({
  enabled,
  follow,
  onPosition,
}: {
  enabled: boolean;
  follow: boolean;
  onPosition?: (p: UserPosition) => void;
}) {
  const map = useMap();
  const [pos, setPos] = useState<UserPosition | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    if (!enabled || !("geolocation" in navigator)) {
      setPos(null);
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        const next: UserPosition = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          heading: p.coords.heading,
          speed: p.coords.speed,
        };
        setPos(next);
        onPosition?.(next);
        if (followRef.current) {
          map.setView([next.lat, next.lng], Math.max(map.getZoom(), 16), {
            animate: true,
          });
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, map]);

  if (!pos) return null;

  return (
    <>
      <Circle
        center={[pos.lat, pos.lng]}
        radius={pos.accuracy}
        pathOptions={{
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.1,
          weight: 1,
          opacity: 0.3,
        }}
      />
      <Marker
        position={[pos.lat, pos.lng]}
        icon={userIcon(pos.heading)}
        zIndexOffset={2000}
      />
    </>
  );
}

/* --------------------------------- helpers -------------------------------- */

function MapClickHandler({
  onClick,
}: {
  onClick?: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Fits the map to a set of points, but only when `fitKey` changes. */
function FitTo({
  points,
  fitKey,
}: {
  points: [number, number][];
  fitKey: string;
}) {
  const map = useMap();
  const lastKey = useRef<string>("");

  useEffect(() => {
    if (points.length === 0 || fitKey === lastKey.current) return;
    lastKey.current = fitKey;
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [70, 70], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);

  return null;
}

function MapController({
  onReady,
}: {
  onReady: (map: L.Map) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

/* --------------------------------- MapView -------------------------------- */

interface MapViewProps {
  places: Place[];
  center?: [number, number];
  zoom?: number;
  onMapClick?: (lat: number, lng: number) => void;
  onPlaceDelete?: (id: string) => void;
  selectedCategory?: string;

  /** Route mode: clicking a pin toggles it in the route instead of opening a popup. */
  routeMode?: boolean;
  routeStops?: Place[];
  routeGeometry?: [number, number][] | null;
  activeStop?: number;
  onPlaceToggle?: (place: Place) => void;

  /** Live GPS */
  liveTracking?: boolean;
  followUser?: boolean;
  onUserPosition?: (p: UserPosition) => void;

  onMapReady?: (map: L.Map) => void;
}

export default function MapView({
  places,
  center = [48.2082, 16.3738],
  zoom = 5,
  onMapClick,
  onPlaceDelete,
  selectedCategory = "all",
  routeMode = false,
  routeStops = [],
  routeGeometry = null,
  activeStop = 0,
  onPlaceToggle,
  liveTracking = false,
  followUser = false,
  onUserPosition,
  onMapReady,
}: MapViewProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const filtered = useMemo(
    () =>
      selectedCategory === "all"
        ? places
        : places.filter((p) => p.category === selectedCategory),
    [places, selectedCategory]
  );

  const selectedIds = useMemo(
    () => new Set(routeStops.map((s) => s.id)),
    [routeStops]
  );

  // Fit to the route while building one, otherwise to the places on first load.
  const fitPoints = useMemo<[number, number][]>(() => {
    if (routeStops.length > 0)
      return routeStops.map((s) => [s.lat, s.lng] as [number, number]);
    return filtered.slice(0, 500).map((p) => [p.lat, p.lng] as [number, number]);
  }, [routeStops, filtered]);

  const fitKey =
    routeStops.length > 0
      ? `route:${routeStops.map((s) => s.id).join(",")}`
      : `places:${filtered.length > 0 ? selectedCategory : "empty"}`;

  const handleReady = useCallback(
    (map: L.Map) => onMapReady?.(map),
    [onMapReady]
  );

  if (!mounted) {
    return (
      <div className="w-full h-full bg-surface flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-2xl gradient-primary flex items-center justify-center animate-pulse">
            <span className="text-white font-bold">R</span>
          </div>
          <p className="text-muted text-sm">Harita yukleniyor...</p>
        </div>
      </div>
    );
  }

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="!rounded-none"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
      />

      {onMapReady && <MapController onReady={handleReady} />}
      <MapClickHandler onClick={onMapClick} />
      <FitTo points={fitPoints} fitKey={fitKey} />

      <ClusterLayer
        places={filtered}
        selectedIds={selectedIds}
        onPlaceClick={routeMode ? onPlaceToggle : undefined}
        onPlaceDelete={onPlaceDelete}
      />

      {routeStops.length > 0 && (
        <RouteLayer
          stops={routeStops}
          geometry={routeGeometry}
          activeStop={activeStop}
          onStopClick={routeMode ? onPlaceToggle : undefined}
        />
      )}

      <LiveLocation
        enabled={liveTracking}
        follow={followUser}
        onPosition={onUserPosition}
      />
    </MapContainer>
  );
}
