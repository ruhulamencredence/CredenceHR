/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride (web only) — the map beside the booking panel. Shows where the
// user is now, the pickup and the destination, and the road route between
// them (OSRM, same free router as LiveRideMap). When onPick is given, a click
// on the map (or dragging a marker) sets whichever point is active.

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed } from 'lucide-react';

export type RidePoint = { lat: number; lng: number };
export type RidePointKind = 'pickup' | 'destination';

type LatLng = [number, number];

const DHAKA: LatLng = [23.8103, 90.4125];

const pinIcon = (bg: string, emoji: string) =>
  L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:9999px;background:${bg};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;">${emoji}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
const pickupIcon = pinIcon('#2563eb', '🧑');
const destinationIcon = pinIcon('#dc2626', '🏁');
const hereIcon = L.divIcon({
  className: '',
  html: '<div style="width:16px;height:16px;border-radius:9999px;background:#3b82f6;border:3px solid white;box-shadow:0 0 0 6px rgba(59,130,246,0.25);"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

interface RideBookingMapProps {
  here: RidePoint | null;
  pickup: RidePoint | null;
  destination: RidePoint | null;
  // Which point a map click sets. Omit onPick for a read-only map.
  active?: RidePointKind;
  onPick?: (kind: RidePointKind, point: RidePoint) => void;
  onLocateMe?: () => void;
  className?: string;
}

export function RideBookingMap({ here, pickup, destination, active, onPick, onLocateMe, className = '' }: RideBookingMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef({ active, onPick });
  pickRef.current = { active, onPick };
  const [route, setRoute] = useState<{ coords: LatLng[]; km: number; min: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView(DHAKA, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      const { active: kind, onPick: pick } = pickRef.current;
      if (kind && pick) pick(kind, { lat: e.latlng.lat, lng: e.latlng.lng });
    });
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Road route between pickup and destination.
  const routeKey = pickup && destination ? `${pickup.lat},${pickup.lng};${destination.lat},${destination.lng}` : '';
  useEffect(() => {
    setRoute(null);
    if (!pickup || !destination) return;
    const controller = new AbortController();
    fetch(
      `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`,
      { signal: controller.signal }
    )
      .then((r) => r.json())
      .then((json) => {
        const best = json?.routes?.[0];
        if (!best || !Array.isArray(best.geometry?.coordinates)) return;
        setRoute({
          coords: best.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]] as LatLng),
          km: Number(best.distance) / 1000,
          min: Number(best.duration) / 60
        });
      })
      .catch(() => {
        // Router unreachable — a straight dashed line is drawn instead.
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  // Markers + route line.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const editable = !!onPick;
    if (here) L.marker([here.lat, here.lng], { icon: hereIcon, interactive: false }).addTo(layer);
    const addPoint = (p: RidePoint, icon: L.DivIcon, kind: RidePointKind) => {
      const marker = L.marker([p.lat, p.lng], { icon, draggable: editable }).addTo(layer);
      if (editable) {
        marker.on('dragend', () => {
          const ll = marker.getLatLng();
          pickRef.current.onPick?.(kind, { lat: ll.lat, lng: ll.lng });
        });
      }
    };
    if (pickup) addPoint(pickup, pickupIcon, 'pickup');
    if (destination) addPoint(destination, destinationIcon, 'destination');
    if (route) {
      L.polyline(route.coords, { color: '#7F00FF', weight: 5, opacity: 0.8 }).addTo(layer);
    } else if (pickup && destination) {
      L.polyline(
        [
          [pickup.lat, pickup.lng],
          [destination.lat, destination.lng]
        ],
        { color: '#7F00FF', weight: 3, opacity: 0.6, dashArray: '6 6' }
      ).addTo(layer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here?.lat, here?.lng, pickup?.lat, pickup?.lng, destination?.lat, destination?.lng, route, !!onPick]);

  // Keep the chosen points in view whenever they change.
  const viewKey = [pickup, destination].map((p) => (p ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : '-')).join('|');
  const hereKnown = !!here;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pts: LatLng[] = [pickup, destination].filter((p): p is RidePoint => !!p).map((p) => [p.lat, p.lng]);
    if (pts.length === 0 && here) pts.push([here.lat, here.lng]);
    if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 15));
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, hereKnown]);

  return (
    <div className={`relative rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100 ${className}`}>
      <div ref={containerRef} className={`absolute inset-0 ${onPick && active ? 'cursor-crosshair [&_.leaflet-container]:cursor-crosshair' : ''}`} />
      {onPick && active && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-3 z-[500] px-3 py-1.5 rounded-full bg-white/95 shadow text-xs font-medium text-slate-700">
          Click the map to set the{' '}
          <span className={active === 'pickup' ? 'text-blue-600' : 'text-red-600'}>{active === 'pickup' ? 'pickup' : 'destination'}</span>
        </div>
      )}
      {route && (
        <div className="absolute left-3 bottom-3 z-[500] px-3 py-1.5 rounded-lg bg-white/95 shadow text-sm text-slate-800">
          <span className="font-semibold">{Math.max(1, Math.round(route.min))} min</span> · {route.km.toFixed(1)} km
        </div>
      )}
      {onLocateMe && (
        <button
          type="button"
          onClick={onLocateMe}
          className="absolute right-3 top-3 z-[500] w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center text-slate-700 hover:text-blue-600"
          aria-label="Go to my location"
          title="My location"
        >
          <LocateFixed className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
