/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, MapPin, Check, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Project } from '../types';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface AttendanceMapConfirmProps {
  kind: 'in' | 'out';
  project: Project;
  coords: { latitude: number; longitude: number };
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (remarks: string) => void;
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
  onConfirm
}: AttendanceMapConfirmProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const [ready, setReady] = useState(false);
  const [remarks, setRemarks] = useState('');

  useBackButtonClose(true, submitting ? () => {} : onCancel);

  const hasSite = project.location_lat != null && project.location_lng != null;
  const hasRadius = hasSite && !!project.location_radius;
  const distance = hasSite
    ? Math.round(haversineMeters(coords.latitude, coords.longitude, Number(project.location_lat), Number(project.location_lng)))
    : null;
  const inside = hasRadius && distance != null ? distance <= Number(project.location_radius) : null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const center: [number, number] = hasSite
      ? [Number(project.location_lat), Number(project.location_lng)]
      : [coords.latitude, coords.longitude];
    const map = L.map(mapContainerRef.current, { center, zoom: PROJECT_ZOOM });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const bounds: L.LatLngExpression[] = [[coords.latitude, coords.longitude]];

    if (hasSite) {
      L.marker([Number(project.location_lat), Number(project.location_lng)], { icon: projectPinIcon })
        .addTo(map)
        .bindPopup(project.location_label || project.project_name);
      bounds.push([Number(project.location_lat), Number(project.location_lng)]);
      if (hasRadius) {
        L.circle([Number(project.location_lat), Number(project.location_lng)], {
          radius: Number(project.location_radius),
          color: inside ? '#059669' : '#dc2626',
          weight: 2,
          fillColor: inside ? '#059669' : '#dc2626',
          fillOpacity: 0.12
        }).addTo(map);
      }
    }

    L.marker([coords.latitude, coords.longitude], { icon: userDotIcon })
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
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