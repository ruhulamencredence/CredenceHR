/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Live Ride Map — Uber-style view of an 'ongoing' (or completed) ride: polls
// GET /api/vehicles/requisitions/:id/live-location every LIVE_POLL_MS and plots
// the requester's and the driver's latest Employee Tracking ping, plus the
// destination (geocoded server-side from the free-text destination).
//
// The road route comes from OSRM's free public router (no API key). To keep
// data and battery use low it is only re-fetched when a route point has
// actually moved more than REROUTE_METERS, not on every poll. Route order:
// driver -> employee -> destination while they're apart (pickup leg), and
// driver -> destination once they're together.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, Navigation } from 'lucide-react';
import { apiUrl } from '../lib/api';

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// The driver and rider phones report every few seconds during a ride (Live
// Follow, LiveTrackingRoutes.ts), so a short poll keeps the map current.
const LIVE_POLL_MS = 5_000;
const REROUTE_METERS = 100;
const TOGETHER_METERS = 150;

interface LivePoint {
  user_id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  recorded_at: string | null;
}

interface LiveLocationResponse {
  status: 'ongoing' | 'completed';
  pickup_location: string;
  destination: string;
  destination_point: { lat: number; lng: number } | null;
  employee: LivePoint | null;
  driver: LivePoint | null;
}

type LatLng = [number, number];

interface RouteResult {
  coords: LatLng[];
  distanceKm: number;
  durationMin: number;
}

function agoLabel(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

function metersBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const pinIcon = (bg: string, emoji: string) =>
  L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:9999px;background:${bg};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;">${emoji}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
const employeeIcon = pinIcon('#2563eb', '🧑');
const driverIcon = pinIcon('#059669', '🚗');
const destinationIcon = pinIcon('#dc2626', '🏁');

interface LiveRideMapProps {
  requisitionId: number;
  onClose: () => void;
}

export function LiveRideMap({ requisitionId, onClose }: LiveRideMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const hasFittedRef = useRef(false);
  const routedWaypointsRef = useRef<LatLng[] | null>(null);
  const [data, setData] = useState<LiveLocationResponse | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchLocation = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${requisitionId}/live-location`), {
        headers: authHeaders()
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load the live location.');
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, [requisitionId]);

  useEffect(() => {
    fetchLocation();
    const interval = setInterval(fetchLocation, LIVE_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchLocation]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([23.8103, 90.4125], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const employeePos: LatLng | null =
    data?.employee?.lat != null && data?.employee?.lng != null ? [data.employee.lat, data.employee.lng] : null;
  const driverPos: LatLng | null = data?.driver?.lat != null && data?.driver?.lng != null ? [data.driver.lat, data.driver.lng] : null;
  const destinationPos: LatLng | null = data?.destination_point ? [data.destination_point.lat, data.destination_point.lng] : null;
  const together = !!(employeePos && driverPos && metersBetween(employeePos, driverPos) <= TOGETHER_METERS);

  // Waypoints for the road route, in travel order.
  const waypoints: LatLng[] = [];
  if (driverPos) waypoints.push(driverPos);
  if (employeePos && !together) waypoints.push(employeePos);
  if (destinationPos && data?.status === 'ongoing') waypoints.push(destinationPos);

  // Re-fetch the road route only when the set of points changed meaningfully.
  const waypointKey = waypoints.map((p) => p.join(',')).join(';');
  useEffect(() => {
    if (waypoints.length < 2) {
      routedWaypointsRef.current = null;
      setRoute(null);
      return;
    }
    const prev = routedWaypointsRef.current;
    const moved =
      !prev || prev.length !== waypoints.length || waypoints.some((p, i) => metersBetween(p, prev[i]) > REROUTE_METERS);
    if (!moved) return;

    const controller = new AbortController();
    const coords = waypoints.map((p) => `${p[1]},${p[0]}`).join(';');
    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: controller.signal })
      .then((r) => r.json())
      .then((json) => {
        const best = json?.routes?.[0];
        if (!best || !Array.isArray(best.geometry?.coordinates)) throw new Error('no route');
        routedWaypointsRef.current = waypoints;
        setRoute({
          coords: best.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]] as LatLng),
          distanceKm: Number(best.distance) / 1000,
          durationMin: Number(best.duration) / 60
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Router unreachable — the map falls back to a straight dashed line.
        routedWaypointsRef.current = null;
        setRoute(null);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypointKey, data?.status]);

  // Redraw markers + route.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !data) return;
    layer.clearLayers();

    const addMarker = (pos: LatLng, icon: L.DivIcon, label: string) => {
      // A DOM node, not an HTML string: labels carry user-editable names.
      const popup = document.createElement('div');
      popup.style.fontSize = '12px';
      popup.textContent = label;
      L.marker(pos, { icon }).addTo(layer).bindPopup(popup);
    };
    if (employeePos && data.employee) addMarker(employeePos, employeeIcon, `${data.employee.name} (Employee) — ${agoLabel(data.employee.recorded_at)}`);
    if (driverPos && data.driver) addMarker(driverPos, driverIcon, `${data.driver.name} (Driver) — ${agoLabel(data.driver.recorded_at)}`);
    if (destinationPos) addMarker(destinationPos, destinationIcon, `Destination — ${data.destination}`);

    if (route) {
      L.polyline(route.coords, { color: '#7F00FF', weight: 5, opacity: 0.8 }).addTo(layer);
    } else if (waypoints.length >= 2) {
      L.polyline(waypoints, { color: '#7F00FF', weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(layer);
    }

    // Fit once on first data so later polls don't fight the user's own pan/zoom.
    const all = [...waypoints, ...(employeePos ? [employeePos] : []), ...(destinationPos ? [destinationPos] : [])];
    if (!hasFittedRef.current && all.length > 0) {
      map.fitBounds(L.latLngBounds(all), { padding: [50, 50], maxZoom: 16 });
      hasFittedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, route]);

  // Opens turn-by-turn navigation in the phone's own maps app (Google Maps
  // app on Android, or the browser) — free, no API key.
  const navigateUrl = data
    ? destinationPos
      ? `https://www.google.com/maps/dir/?api=1&destination=${destinationPos[0]},${destinationPos[1]}&travelmode=driving`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(data.destination)}&travelmode=driving`
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800">Live Ride Map</div>
            {data && (
              <div className="text-xs text-gray-500 truncate">
                {data.pickup_location} → {data.destination}
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 shrink-0">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}

        {route && data?.status === 'ongoing' && (
          <div className="px-4 py-2 border-b bg-purple-50 text-sm text-purple-900 flex items-center justify-between gap-2">
            <span>
              <span className="font-semibold">{Math.max(1, Math.round(route.durationMin))} min</span> · {route.distanceKm.toFixed(1)} km
              <span className="text-purple-700/70 text-xs"> · {together || !employeePos ? 'to destination' : 'pickup, then destination'}</span>
            </span>
          </div>
        )}

        <div ref={mapContainerRef} style={{ height: 380 }} />

        <div className="px-4 py-3 border-t text-xs text-gray-600 space-y-1">
          <div>🧑 Employee: {employeePos ? `updated ${agoLabel(data?.employee?.recorded_at ?? null)}` : 'waiting for location…'}</div>
          <div>
            🚗 Driver: {data?.driver ? (driverPos ? `updated ${agoLabel(data.driver.recorded_at)}` : 'waiting for location…') : 'no driver account linked'}
          </div>
          <div>🏁 Destination: {destinationPos ? data?.destination : data ? `"${data.destination}" couldn't be found on the map` : '…'}</div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-gray-400">Refreshes every {LIVE_POLL_MS / 1000}s. Needs Employee Tracking on both accounts.</span>
            {navigateUrl && data?.status === 'ongoing' && (
              <a
                href={navigateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded bg-purple-600 text-white font-medium hover:bg-purple-700"
              >
                <Navigation className="w-3.5 h-3.5" /> Navigate
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
