/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride (web only) — the map beside the booking panel. Shows where the
// user is now, the pickup and the destination, and the road route between
// them (OSRM, same free router as LiveRideMap). When onPick is given, a click
// on the map (or dragging a marker) sets whichever point is active.
// "Projects" (when projects are given) shows every project with a location as
// a named pin plus a list to search — picking one sets the active point, the
// same as the phone's map picker.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, LocateFixed, Search, X } from 'lucide-react';

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

export interface ProjectPin {
  id: number;
  label: string;
  detail?: string | null;
  lat: number;
  lng: number;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const projectIcon = (name: string) =>
  L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);width:max-content;cursor:pointer">
      <div style="max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 8px;border-radius:9999px;background:#fff;color:#4c1d95;font:600 11px/1.3 Inter,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)">${esc(name)}</div>
      <div style="width:24px;height:24px;margin-top:3px;border-radius:9999px;background:#7c3aed;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px">🏢</div>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
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
  // Projects with a location: the "Projects" button shows them; picking one calls onPickProject.
  projects?: ProjectPin[];
  onPickProject?: (p: ProjectPin) => void;
}

export function RideBookingMap({ here, pickup, destination, active, onPick, onLocateMe, className = '', projects = [], onPickProject }: RideBookingMapProps) {
  const projLayerRef = useRef<L.LayerGroup | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const [projQuery, setProjQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef({ active, onPick });
  pickRef.current = { active, onPick };
  const [route, setRoute] = useState<{ coords: LatLng[]; km: number; min: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // Zoom buttons bottom-right: the top-left corner holds the Projects button.
    const map = L.map(containerRef.current, { zoomControl: false }).setView(DHAKA, 12);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    projLayerRef.current = L.layerGroup().addTo(map);
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

  // Projects: named pins for the ones the search leaves, all fitted on screen.
  const shownProjects = useMemo(() => {
    const q = projQuery.trim().toLowerCase();
    return projects.filter((p) => !q || p.label.toLowerCase().includes(q) || String(p.detail || '').toLowerCase().includes(q));
  }, [projects, projQuery]);
  const pickProject = (p: ProjectPin) => {
    setShowProjects(false);
    setProjQuery('');
    onPickProject?.(p);
  };
  const pickProjectRef = useRef(pickProject);
  pickProjectRef.current = pickProject;
  useEffect(() => {
    const layer = projLayerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    if (!showProjects || shownProjects.length === 0) return;
    for (const p of shownProjects) {
      L.marker([p.lat, p.lng], { icon: projectIcon(p.label), title: p.label, zIndexOffset: 500 })
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e as any);
          pickProjectRef.current(p);
        })
        .addTo(layer);
    }
    const b = L.latLngBounds(shownProjects.map((p) => [p.lat, p.lng] as LatLng));
    if (shownProjects.length === 1) map.setView(b.getCenter(), 15);
    else map.fitBounds(b, { paddingTopLeft: [330, 70], paddingBottomRight: [60, 60], maxZoom: 15 });
  }, [showProjects, shownProjects]);

  return (
    <div className={`relative isolate rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100 ${className}`}>
      <div ref={containerRef} className={`absolute inset-0 ${onPick && active ? 'cursor-crosshair [&_.leaflet-container]:cursor-crosshair' : ''}`} />
      {onPickProject && projects.length > 0 && (
        <button
          type="button"
          onClick={() => setShowProjects((v) => !v)}
          className={`absolute left-3 top-3 z-[600] inline-flex items-center gap-1.5 px-3.5 h-10 rounded-full shadow-md text-sm font-semibold ${showProjects ? 'bg-violet-600 text-white' : 'bg-white text-slate-700 hover:text-violet-700'}`}
          aria-pressed={showProjects}
        >
          <Building2 className="w-4 h-4" /> Projects
        </button>
      )}
      {showProjects && (
        <div className="absolute left-3 top-16 bottom-3 z-[600] w-[300px] flex flex-col bg-white/95 backdrop-blur rounded-2xl shadow-xl border border-white/80 overflow-hidden">
          <div className="p-3 border-b border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold text-slate-900">
                Projects <span className="text-slate-400 font-medium">· {shownProjects.length}</span>
              </span>
              <button type="button" onClick={() => setShowProjects(false)} aria-label="Close projects" className="p-1 rounded-full hover:bg-slate-100 text-slate-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100">
              <Search className="w-4 h-4 text-slate-400" />
              <input autoFocus value={projQuery} onChange={(e) => setProjQuery(e.target.value)} placeholder="Type a project name or area" className="flex-1 bg-transparent text-sm outline-none" />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Pick one to set it as the <span className={active === 'pickup' ? 'text-blue-600 font-semibold' : 'text-red-600 font-semibold'}>{active === 'pickup' ? 'pickup' : 'destination'}</span>.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {shownProjects.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No project matches.</p>
            ) : (
              shownProjects.map((p) => (
                <button key={p.id} type="button" onClick={() => pickProject(p)} className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-violet-50">
                  <Building2 className="w-4 h-4 mt-0.5 shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900 truncate">{p.label}</span>
                    {p.detail && <span className="block text-xs text-slate-500 truncate">{p.detail}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {onPick && active && !showProjects && (
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
