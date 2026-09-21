/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { X, MapPin, Check, AlertTriangle, CheckCircle2, LocateFixed } from 'lucide-react';
import { Project } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface AttendanceMapConfirmProps {
  kind: 'in' | 'out';
  project: Project;
  coords: { latitude: number; longitude: number };
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (remarks: string) => void;
  // Fires whenever the "Use current location" button gets a fresh GPS fix —
  // lets the parent (AttendanceCard) keep its own `pending.coords` in sync so
  // the eventual check-in/out POST sends this refreshed point, not the
  // original snapshot taken before the modal opened. Optional so older
  // callers that don't pass it still work (falls back to the initial coords).
  onCoordsChange?: (coords: { latitude: number; longitude: number }) => void;
  // Lets this same map also plot every OTHER Project's set location circle
  // (muted/gray, purely for context) alongside the one being checked into —
  // fetched from GET /api/projects/all, which needs auth but nothing from
  // the device itself, so this adds no extra permission prompt on top of the
  // GPS fix already obtained before this modal opened.
  token: string;
}

const PROJECT_ZOOM = 17;

// Same inline SVG pin style LocationMapPicker uses for the project's spot —
// kept blue so it visually reads as "the site" here too.
const projectPinIcon = L.divIcon({
  className: '',
  html: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#7F00FF"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 30],
  popupAnchor: [0, -26]
});

// Every OTHER Project's site — muted gray so it never gets mistaken for the
// one actually being checked into (that one keeps the violet pin above).
const otherProjectPinIcon = L.divIcon({
  className: '',
  html: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#94a3b8"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [22, 22],
  iconAnchor: [11, 22],
  popupAnchor: [0, -19]
});

// The user's own live position — a distinct pulsing dot rather than a pin, so
// it never gets confused with the project's site marker above.
const userDotIcon = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#f43f5e;border:3px solid #ffffff;box-shadow:0 0 0 2px #f43f5e, 0 1px 4px rgba(0,0,0,0.4);"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Same geolocation flow AttendanceCard.tsx already uses to get the initial
// fix: Capacitor's plugin on the native Android app build (works without a
// browser permission prompt inside the WebView), plain navigator.geolocation
// on the web build. Kept as its own copy here (not imported) matching the
// existing convention in this codebase of each file owning its own copy.
async function getCurrentCoords(): Promise<{ latitude: number; longitude: number }> {
  if (Capacitor.isNativePlatform()) {
    let status: string;
    try {
      status = (await Geolocation.checkPermissions()).location;
    } catch {
      status = 'prompt';
    }
    if (status !== 'granted') {
      try {
        status = (await Geolocation.requestPermissions()).location;
      } catch {
        throw new Error('Location permission is required to mark attendance. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required to mark attendance. Please allow location access and try again.');
    }
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't access your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => reject(new Error("Couldn't get your location. Please allow location access and try again.")),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

// Shown after the device's GPS fix comes back and before the actual
// check-in/check-out API call fires. Lets the user SEE where they are versus
// the project's attendance circle (location_lat/lng/radius) on a map before
// they commit — Confirm triggers the real network call (still server-side
// validated either way), Cancel just closes this with nothing sent.
export default function AttendanceMapConfirm({
  kind,
  project,
  coords,
  submitting,
  onCancel,
  onConfirm,
  onCoordsChange,
  token
}: AttendanceMapConfirmProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  // Every other Project's site, drawn on this same map once fetched — kept
  // in its own layer group so it can be cleared/redrawn independently of the
  // rest of the map (which is set up once on mount, before this data is even
  // back yet).
  const otherProjectsLayerRef = useRef<L.LayerGroup | null>(null);

  const [ready, setReady] = useState(false);
  const [remarks, setRemarks] = useState('');
  // The point actually shown/submitted — starts as the snapshot the parent
  // captured before opening this modal, but can be refreshed in place via the
  // "Use current location" button below without closing/reopening the modal.
  const [liveCoords, setLiveCoords] = useState(coords);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  // Every OTHER Project with a set site location, for context on this same
  // map (muted gray — see otherProjectPinIcon). Fetched from GET
  // /api/projects/all, which is open to any signed-in role and doesn't touch
  // the device's own location at all, so it adds no extra permission prompt
  // on top of the GPS fix already obtained before this modal opened.
  const [otherProjects, setOtherProjects] = useState<Project[]>([]);

  useBackButtonClose(true, submitting ? () => {} : onCancel);

  const hasSite = project.location_lat != null && project.location_lng != null;
  const hasRadius = hasSite && !!project.location_radius;
  const distance = hasSite
    ? Math.round(haversineMeters(liveCoords.latitude, liveCoords.longitude, Number(project.location_lat), Number(project.location_lng)))
    : null;
  const inside = hasRadius && distance != null ? distance <= Number(project.location_radius) : null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const center: [number, number] = hasSite
      ? [Number(project.location_lat), Number(project.location_lng)]
      : [liveCoords.latitude, liveCoords.longitude];
    const map = L.map(mapContainerRef.current, { center, zoom: PROJECT_ZOOM });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const bounds: L.LatLngExpression[] = [[liveCoords.latitude, liveCoords.longitude]];

    if (hasSite) {
      L.marker([Number(project.location_lat), Number(project.location_lng)], { icon: projectPinIcon })
        .addTo(map)
        .bindPopup(project.location_label || project.project_name);
      bounds.push([Number(project.location_lat), Number(project.location_lng)]);
      if (hasRadius) {
        circleRef.current = L.circle([Number(project.location_lat), Number(project.location_lng)], {
          radius: Number(project.location_radius),
          color: inside ? '#059669' : '#dc2626',
          weight: 2,
          fillColor: inside ? '#059669' : '#dc2626',
          fillOpacity: 0.12
        }).addTo(map);
      }
    }

    userMarkerRef.current = L.marker([liveCoords.latitude, liveCoords.longitude], { icon: userDotIcon })
      .addTo(map)
      .bindPopup('You are here');

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: PROJECT_ZOOM });
    }

    setTimeout(() => {
      map.invalidateSize();
      setReady(true);
    }, 80);

    return () => {
      map.remove();
      mapRef.current = null;
      userMarkerRef.current = null;
      circleRef.current = null;
      otherProjectsLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetches every other Project's site once, in parallel with the map/GPS
  // setup above — GET /api/projects/all (not the narrower GET /api/projects)
  // so this shows every Project's circle regardless of which one(s) this
  // account is personally assigned to check in against.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/projects/all'), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setOtherProjects(data.filter((p: Project) => p.id !== project.id && p.location_lat != null && p.location_lng != null));
        }
      } catch {
        // Offline/unreachable — this is purely extra context, the actual
        // check-in/out flow above doesn't depend on it at all.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, project.id]);

  // Draws the fetched otherProjects onto the map created above, once both are
  // ready — kept as its own effect (rather than folded into the map-setup one
  // above) since the fetch resolves after that first effect already ran.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || otherProjects.length === 0) return;

    otherProjectsLayerRef.current?.remove();
    const layer = L.layerGroup();
    for (const p of otherProjects) {
      const lat = Number(p.location_lat);
      const lng = Number(p.location_lng);
      L.marker([lat, lng], { icon: otherProjectPinIcon })
        .addTo(layer)
        .bindPopup(p.project_name);
      if (p.location_radius) {
        L.circle([lat, lng], {
          radius: Number(p.location_radius),
          color: '#94a3b8',
          weight: 1.5,
          dashArray: '4 4',
          fillColor: '#94a3b8',
          fillOpacity: 0.06
        }).addTo(layer);
      }
    }
    layer.addTo(map);
    otherProjectsLayerRef.current = layer;
  }, [otherProjects]);

  // Re-reads GPS (same permission/flow as the initial fix) and moves the
  // existing marker + recenters the map in place, instead of forcing the user
  // to cancel and re-tap Check In/Out just to pick up a better fix — useful
  // when the first fix came back stale/low-accuracy (e.g. indoors) and the
  // banner below is showing "outside the attendance area" incorrectly.
  const handleUseCurrentLocation = async () => {
    setLocating(true);
    setLocateError(null);
    try {
      const fresh = await getCurrentCoords();
      setLiveCoords(fresh);
      onCoordsChange?.(fresh);
      userMarkerRef.current?.setLatLng([fresh.latitude, fresh.longitude]);
      if (mapRef.current) {
        const bounds: L.LatLngExpression[] = [[fresh.latitude, fresh.longitude]];
        if (hasSite) bounds.push([Number(project.location_lat), Number(project.location_lng)]);
        if (bounds.length > 1) {
          mapRef.current.fitBounds(bounds, { padding: [48, 48], maxZoom: PROJECT_ZOOM });
        } else {
          mapRef.current.panTo([fresh.latitude, fresh.longitude]);
        }
      }
    } catch (err: any) {
      setLocateError(err?.message || 'Could not get current location');
    } finally {
      setLocating(false);
    }
  };

  // Circle color follows inside/outside — recolor in place on every fresh fix
  // rather than tearing down and recreating the circle.
  useEffect(() => {
    if (!circleRef.current || inside == null) return;
    circleRef.current.setStyle({
      color: inside ? '#059669' : '#dc2626',
      fillColor: inside ? '#059669' : '#dc2626'
    });
  }, [inside]);

  // Rendered via a portal straight onto document.body instead of in place —
  // this component gets mounted deep inside UserPanel's dashboard tree,
  // which has an `overflow-hidden` ancestor (used to clip the background
  // Lottie animation). On a number of Android WebViews a `position: fixed`
  // element nested inside `overflow: hidden` doesn't truly pin to the full
  // device screen — it gets clipped to that ancestor's box instead, which is
  // what was cutting this popup off near the header and letting BottomNav's
  // background show through at the bottom. Escaping to document.body via a
  // portal sidesteps that ancestor entirely, so this now behaves like a real
  // full-screen modal on every Android version.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)'
      }}
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
        style={{ maxHeight: '100%' }}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Confirm {kind === 'in' ? 'Check In' : 'Check Out'}
              </h3>
              <p className="text-xs text-slate-500">{project.project_name}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto min-h-0">
          <div className="relative">
            <div
              ref={mapContainerRef}
              className="w-full rounded-xl border border-slate-200 overflow-hidden"
              style={{ height: 'clamp(160px, 34vh, 320px)' }}
            />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-50 rounded-xl">
                <Spinner size={20} className="text-slate-400" />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating || submitting}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 text-xs font-semibold rounded-xl border border-slate-200 transition-colors"
            >
              {locating ? <Spinner size={14} /> : <LocateFixed className="w-3.5 h-3.5" />}
              {locating ? 'Locating…' : 'Use current location'}
            </button>
            <span className="text-xs font-mono text-slate-500">
              {liveCoords.latitude.toFixed(6)}, {liveCoords.longitude.toFixed(6)}
            </span>
          </div>
          {locateError && <p className="text-xs text-rose-600 px-1">{locateError}</p>}

          {hasSite ? (
            hasRadius ? (
              <div
                className={`flex items-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl ${
                  inside ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                }`}
              >
                {inside ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                <span>
                  {inside
                    ? `You're ${formatDistance(distance as number)} from the site — inside the ${formatDistance(Number(project.location_radius))} attendance area.`
                    : `You're ${formatDistance(distance as number)} from the site — outside the ${formatDistance(Number(project.location_radius))} attendance area.`}
                </span>
              </div>
            ) : (
              <p className="text-xs text-slate-500 px-1">
                {formatDistance(distance as number)} from {project.location_label || project.project_name}. This project has no attendance radius set, so any location is accepted.
              </p>
            )
          ) : (
            <p className="text-xs text-slate-500 px-1">
              This project has no site location set — your check-{kind} won't be checked against a location.
            </p>
          )}

          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">
              Remarks <span className="font-normal normal-case text-slate-400">(optional)</span>
            </label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder={kind === 'in' ? 'e.g. Reached late — traffic' : 'e.g. Left early, cleared with PM'}
              className="w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
            />
          </div>
        </div>

        <div className="p-5 border-t border-slate-200 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(remarks.trim())}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
          >
            {submitting ? <Spinner size={16} /> : <Check className="w-4 h-4" />}
            {kind === 'in' ? 'Confirm Check In' : 'Confirm Check Out'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
