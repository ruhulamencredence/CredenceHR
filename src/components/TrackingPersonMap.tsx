/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One person's location on a map (z-[1100]: over the people list, z-[1050]) — opened by tapping someone in the
// "Under tracking" / "Not tracked" list (Dashboard card, Employee Tracking).
// Their latest location (GET /api/tracking/latest) with its accuracy circle,
// today's path behind it (GET /api/tracking/history, cleaned like the
// tracking map), the address, battery and how long ago; refreshes every
// 30 s while open. "Full path" opens Employee Tracking on that person.
// Same tracking module + Read layer + Tracking scope as the rest of
// Employee Tracking (the API decides).

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, MapPin, Route, BatteryMedium, Clock, AlertTriangle, ExternalLink } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { reverseGeocode } from '../lib/reverseGeocode';
import { cleanPath } from '../lib/trackPath';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { UserAvatar } from './UserAvatar';

interface Latest {
  lat: number | string;
  lng: number | string;
  accuracy_m: number | null;
  battery_pct: number | null;
  recorded_at: string;
  is_mock?: number | null;
  minutes_ago: number | null;
}

const REFRESH_MS = 30_000;
const ago = (m: number | null) => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} day(s) ago`);
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Ask Employee Tracking to open on this person (EmployeeTrackingPanel listens;
// kept here too in case the panel mounts after the request).
export function focusTrackingUser(u: { id: number; name: string }) {
  (window as any).__credenceTrackingFocus = { ...u, at: Date.now() };
  window.dispatchEvent(new CustomEvent('credence:tracking-focus', { detail: u }));
}

export const TrackingPersonMap: React.FC<{
  token: string;
  person: { userId: number; name: string; detail?: string };
  onClose: () => void;
  /** Inside Employee Tracking: show the full path there instead of navigating. */
  onFullPath?: () => void;
}> = ({ token, person, onClose, onFullPath }) => {
  const [latest, setLatest] = useState<Latest | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [path, setPath] = useState<[number, number][]>([]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  useBackButtonClose(true, onClose);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = { Authorization: `Bearer ${token}` };
        const [r1, r2] = await Promise.all([
          fetch(apiUrl(`/api/tracking/latest?user_id=${person.userId}`), { headers: h }),
          fetch(apiUrl(`/api/tracking/history?user_id=${person.userId}&from=${todayIso()}&to=${todayIso()}`), { headers: h })
        ]);
        const d1 = await r1.json().catch(() => null);
        if (!r1.ok) throw new Error(d1?.error || 'Could not load the location.');
        const d2 = r2.ok ? await r2.json().catch(() => []) : [];
        if (!alive) return;
        setLatest(d1);
        const pts = Array.isArray(d2) ? d2 : Array.isArray(d2?.rows) ? d2.rows : [];
        setPath(cleanPath(pts).route.map((p: any) => [Number(p.lat), Number(p.lng)] as [number, number]));
        setError('');
      } catch (e: any) {
        if (alive) {
          setError(e.message);
          setLatest((l) => (l === undefined ? null : l));
        }
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token, person.userId]);

  useEffect(() => {
    if (!latest) return;
    let gone = false;
    reverseGeocode(Number(latest.lat), Number(latest.lng)).then((a) => !gone && setAddress(a));
    return () => {
      gone = true;
    };
  }, [latest?.lat, latest?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // The map, drawn once; the layer redrawn on every refresh.
  useEffect(() => {
    if (!latest || !boxRef.current) return;
    if (!mapRef.current) {
      const map = L.map(boxRef.current, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      setTimeout(() => map.invalidateSize(), 80);
    }
    const map = mapRef.current!;
    const layer = layerRef.current!;
    layer.clearLayers();
    const here: [number, number] = [Number(latest.lat), Number(latest.lng)];
    if (path.length > 1) L.polyline(path, { color: '#7c3aed', weight: 3, opacity: 0.55 }).addTo(layer);
    if (latest.accuracy_m) L.circle(here, { radius: Number(latest.accuracy_m), color: '#10b981', weight: 1, fillOpacity: 0.12 }).addTo(layer);
    const fresh = latest.minutes_ago != null && latest.minutes_ago <= 20;
    const mock = !!Number(latest.is_mock);
    L.circleMarker(here, {
      radius: 9,
      color: '#fff',
      weight: 3,
      fillColor: mock ? '#dc2626' : fresh ? '#10b981' : '#94a3b8',
      fillOpacity: 1
    })
      .addTo(layer)
      .bindTooltip(person.name, { direction: 'top', offset: [0, -8] });
    if (!fittedRef.current) {
      fittedRef.current = true;
      if (path.length > 1) map.fitBounds(L.latLngBounds([...path, here]), { padding: [36, 36], maxZoom: 17 });
      else map.setView(here, 16);
    }
  }, [latest, path, person.name]);

  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
    },
    []
  );

  const fresh = latest?.minutes_ago != null && latest.minutes_ago <= 20;
  const fullPath = () => {
    onClose();
    if (onFullPath) return onFullPath();
    focusTrackingUser({ id: person.userId, name: person.name });
    window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'tracking' }));
  };

  return createPortal(
    <div className="fixed inset-0 z-[1100] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${person.name} — location`}
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in w-full sm:max-w-xl rounded-t-[32px] sm:rounded-[32px] max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 1rem)' }}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <UserAvatar userId={person.userId} name={person.name} token={token} className="w-11 h-11 text-sm" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900 truncate">{person.name}</h3>
            <p className="text-xs text-slate-500 truncate">{person.detail || 'Latest location'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 sm:px-5 space-y-3">
          {latest === undefined ? (
            <div className="liquid-glass-inset rounded-2xl h-72 flex items-center justify-center text-slate-400">
              <MapPin className="w-5 h-5 animate-pulse" />
            </div>
          ) : !latest ? (
            <div className="liquid-glass-inset rounded-2xl px-4 py-10 text-center text-sm text-slate-500">{error || 'No location received from this person yet.'}</div>
          ) : (
            <>
              <div ref={boxRef} className="w-full h-72 sm:h-80 rounded-2xl overflow-hidden border border-white/70" />
              <div className="liquid-glass-inset rounded-2xl divide-y divide-white/70 text-sm">
                <div className="flex items-start gap-2.5 px-3.5 py-2.5">
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                  <span className="text-slate-800 break-words">{address || `${Number(latest.lat).toFixed(5)}, ${Number(latest.lng).toFixed(5)}`}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-xs">
                  <span className={`inline-flex items-center gap-1 font-semibold ${fresh ? 'text-emerald-700' : 'text-slate-500'}`}>
                    <Clock className="w-3.5 h-3.5" /> {fresh ? 'Live' : 'Last seen'} · {ago(latest.minutes_ago)}
                  </span>
                  {latest.accuracy_m != null && <span className="text-slate-500">± {Math.round(Number(latest.accuracy_m))} m</span>}
                  {latest.battery_pct != null && (
                    <span className={`inline-flex items-center gap-1 ${Number(latest.battery_pct) < 15 ? 'text-rose-600 font-semibold' : 'text-slate-500'}`}>
                      <BatteryMedium className="w-3.5 h-3.5" /> {latest.battery_pct}%
                    </span>
                  )}
                  {path.length > 1 && (
                    <span className="inline-flex items-center gap-1 text-violet-700">
                      <Route className="w-3.5 h-3.5" /> today's path
                    </span>
                  )}
                </div>
                {!!Number(latest.is_mock) && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-rose-700">
                    <AlertTriangle className="w-4 h-4 shrink-0" /> Fake GPS — this location came from a mock-location app.
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                <a
                  href={`https://maps.google.com/?q=${Number(latest.lat)},${Number(latest.lng)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="liquid-glass-inset rounded-full px-4 py-2 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Google Maps
                </a>
                <button type="button" onClick={fullPath} className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5">
                  <Route className="w-3.5 h-3.5" /> Full path & live follow
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
