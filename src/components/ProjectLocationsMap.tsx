/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, MapPinned } from 'lucide-react';
import { Project } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ProjectLocationsMapProps {
  token: string;
  onClose: () => void;
}

const DEFAULT_ZOOM = 12;

// Same inline SVG pin style AttendanceMapConfirm.tsx uses for a project's
// spot, so a site reads the same way here.
const projectPinIcon = L.divIcon({
  className: '',
  html: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#7F00FF"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [26, 26],
  iconAnchor: [13, 26],
  popupAnchor: [0, -22]
});

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// "View Project Locations" — read-only map of every Project's set Remote
// Attendance site (location_lat/location_lng, with its location_radius
// circle when one's set), reachable from AttendanceCard regardless of which
// Project(s) this account itself is assigned to check in/out against.
// Deliberately asks for NOTHING from the device: no geolocation permission
// prompt, no "where am I" fix — it just plots the company's own saved
// Project pins/circles, so every signed-in account can browse them freely.
// Reads GET /api/projects/all (already open to any role — see server.ts,
// the same endpoint Timesheet's "Correct Attendance" project picker uses)
// rather than GET /api/projects, since that one narrows to only the
// Projects this account has been granted — this view is meant to show
// every Project's site regardless of that.
export default function ProjectLocationsMap({ token, onClose }: ProjectLocationsMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/projects/all'), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load Projects');
        const data = await res.json();
        if (!cancelled) setProjects(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setError("Couldn't load Project locations. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const sited = projects.filter((p) => p.location_lat != null && p.location_lng != null);

  useEffect(() => {
    if (loading || !mapContainerRef.current || mapRef.current) return;

    const center: [number, number] = sited.length > 0
      ? [Number(sited[0].location_lat), Number(sited[0].location_lng)]
      : [23.685, 90.3563]; // Bangladesh-wide fallback view when no Project has a pin set yet.
    const map = L.map(mapContainerRef.current, { center, zoom: DEFAULT_ZOOM });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const bounds: L.LatLngExpression[] = [];
    for (const p of sited) {
      const lat = Number(p.location_lat);
      const lng = Number(p.location_lng);
      bounds.push([lat, lng]);
      L.marker([lat, lng], { icon: projectPinIcon })
        .addTo(map)
        .bindPopup(
          `<strong>${p.project_name}</strong>${p.location_label ? `<br/>${p.location_label}` : ''}${
            p.location_radius ? `<br/>${formatDistance(Number(p.location_radius))} radius` : ''
          }`
        );
      if (p.location_radius) {
        L.circle([lat, lng], {
          radius: Number(p.location_radius),
          color: '#7F00FF',
          weight: 2,
          fillColor: '#7F00FF',
          fillOpacity: 0.1
        }).addTo(map);
      }
    }

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
    }

    setTimeout(() => {
      map.invalidateSize();
      setMapReady(true);
    }, 80);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)'
      }}
      onClick={onClose}
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl flex flex-col"
        style={{ maxHeight: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-violet-50 text-violet-600 p-2 rounded-xl border border-violet-100">
              <MapPinned className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Project Locations</h3>
              <p className="text-xs text-slate-500">Every Project's set attendance site, view-only.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : error ? (
            <p className="text-sm text-rose-600 px-1">{error}</p>
          ) : (
            <>
              <div className="relative">
                <div
                  ref={mapContainerRef}
                  className="w-full rounded-xl border border-slate-200 overflow-hidden"
                  style={{ height: 'clamp(240px, 50vh, 420px)' }}
                />
                {!mapReady && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-50 rounded-xl">
                    <Spinner size={20} className="text-slate-400" />
                  </div>
                )}
              </div>
              {sited.length === 0 ? (
                <p className="text-xs text-slate-500 px-1">
                  No Project has a site location set yet (Admin Panel -&gt; Projects -&gt; Set Location on Map).
                </p>
              ) : (
                <p className="text-xs text-slate-500 px-1">
                  {sited.length} Project{sited.length === 1 ? '' : 's'} with a set location — tap a pin for details.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
