/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Live Ride Map — the "Uber-style navigation" view for a vehicle_requisitions
// row once it's 'ongoing': polls VehicleManagementRoutes.ts's
// GET /api/vehicles/requisitions/:id/live-location every LIVE_POLL_MS and
// plots the requester's and (if one is assigned) the driver's most recent
// Employee Tracking ping on a Leaflet map, same tile/marker conventions as
// EmployeeTrackingPanel.tsx. The road-route line between them comes from
// OSRM's free public routing API — no API key, matches this project's
// no-Google-Maps-key setup (Leaflet + OpenStreetMap tiles throughout).
//
// Two things this can't do (see the "Bypass" chat thread this shipped with):
// pickup_location/destination are free-text, not lat/lng, so they're shown as
// a text header rather than plotted; and both the employee's and the
// driver's accounts need can_use_tracking enabled AND to have actually
// pinged at least once, or that side just shows "waiting for location".

import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// The device itself only pings every 5-10 min (see server.ts's tracking
// comment), so polling much faster than this wouldn't see anything new —
// this just keeps the map/"X min ago" label reasonably current without
// hammering the server while someone's actually watching this screen.
const LIVE_POLL_MS = 15_000;

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
  employee: LivePoint | null;
  driver: LivePoint | null;
}

function agoLabel(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

const employeeIcon = L.divIcon({
  className: '',
  html: `<div style="width:34px;height:34px;border-radius:9999px;background:#2563eb;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;">🧑</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17]
});
const driverIcon = L.divIcon({
  className: '',
  html: `<div style="width:34px;height:34px;border-radius:9999px;background:#059669;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;">🚗</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17]
});

interface LiveRideMapProps {
  requisitionId: number;
  onClose: () => void;
}

export function LiveRideMap({ requisitionId, onClose }: LiveRideMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [data, setData] = useState<LiveLocationResponse | null>(null);
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

  // Initialize the map once.
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

  // Redraw markers + route whenever a fresh poll comes in.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !data) return;
    layer.clearLayers();

    const points: { pos: [number, number]; icon: L.DivIcon; label: string }[] = [];
    if (data.employee?.lat != null && data.employee?.lng != null) {
      points.push({ pos: [data.employee.lat, data.employee.lng], icon: employeeIcon, label: `${data.employee.name} (Employee) — ${agoLabel(data.employee.recorded_at)}` });
    }
    if (data.driver?.lat != null && data.driver?.lng != null) {
      points.push({ pos: [data.driver.lat, data.driver.lng], icon: driverIcon, label: `${data.driver.name} (Driver) — ${agoLabel(data.driver.recorded_at)}` });
    }
    points.forEach((p) => {
      // A DOM node, not an HTML string: labels carry user-editable names.
      const popup = document.createElement('div');
      popup.style.fontSize = '12px';
      popup.textContent = p.label;
      L.marker(p.pos, { icon: p.icon }).addTo(layer).bindPopup(popup);
    });

    const controller = new AbortController();
    if (points.length === 2) {
      // OSRM's free public routing server — road-based route line between
      // the two live points, refreshed on every poll. No API key needed,
      // same "no Google Maps key" setup as the rest of this project.
      const [a, b] = points;
      fetch(`https://router.project-osrm.org/route/v1/driving/${a.pos[1]},${a.pos[0]};${b.pos[1]},${b.pos[0]}?overview=full&geometries=geojson`, {
        signal: controller.signal
      })
        .then((r) => r.json())
        .then((json) => {
          const coords = json?.routes?.[0]?.geometry?.coordinates;
          if (Array.isArray(coords) && !controller.signal.aborted) {
            const latlngs = coords.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
            L.polyline(latlngs, { color: '#7F00FF', weight: 4, opacity: 0.75 }).addTo(layer);
          }
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Routing is a nice-to-have — if OSRM is unreachable (e.g. no
          // internet egress from this deployment) just fall back to a
          // straight line so the two positions are still connected visually.
          L.polyline([a.pos, b.pos], { color: '#7F00FF', weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(layer);
        });
    }

    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points.map((p) => p.pos)), { padding: [50, 50], maxZoom: 16 });
    }
    return () => controller.abort();
  }, [data]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="text-sm font-semibold text-gray-800">Live Ride Map</div>
            {data && <div className="text-xs text-gray-500">{data.pickup_location} → {data.destination}</div>}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}

        <div ref={mapContainerRef} style={{ height: 380 }} />

        <div className="px-4 py-3 border-t text-xs text-gray-600 space-y-1">
          <div>
            🧑 Employee: {data?.employee?.lat != null ? `updated ${agoLabel(data.employee.recorded_at)}` : 'waiting for location…'}
          </div>
          <div>
            🚗 Driver: {data?.driver ? (data.driver.lat != null ? `updated ${agoLabel(data.driver.recorded_at)}` : 'waiting for location…') : 'no driver account linked'}
          </div>
          <div className="text-gray-400">Refreshes every {LIVE_POLL_MS / 1000}s while this is open. Needs Employee Tracking enabled on both accounts.</div>
        </div>
      </div>
    </div>
  );
}
