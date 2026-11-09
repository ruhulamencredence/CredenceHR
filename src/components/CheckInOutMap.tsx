/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Check In/Out on a full map, like Book a Ride's map picker: the map fills
// the screen with you on it (the pulsing dot), a sheet at the bottom holds
// the rest. Phone: full screen; wider screens: a big card, map beside the
// panel.
//
// - Opens on whichever is next: nothing open -> Check In, a claim open ->
//   Check Out (GET /api/claims/status).
// - Check In: the address under you (GET /api/vehicles/places/reverse),
//   Purpose (kept as a draft, same as the form), the nearest project sites as
//   one-tap suggestions (GET /api/vehicles/places/nearby), Remarks.
// - Check Out: the Check In pin, a dashed line to you and the distance.
// - "My location" re-reads GPS. The same API calls as the form
//   (POST /api/claims/check-in, /api/claims/:id/check-out), so the same
//   access (requireMovementClaimAccess) and approvals apply.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, Building2, LocateFixed, LogIn, LogOut, MapPin, Route } from 'lucide-react';
import type { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { getCurrentCoords } from '../lib/currentCoords';
import { clearDraft, readDraft, saveDraft } from '../lib/formDraft';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { useMdUp } from '../lib/useMdUp';
import { Spinner } from './Spinner';

type Coords = { latitude: number; longitude: number };
const DHAKA: L.LatLngTuple = [23.8103, 90.4125];
const ZOOM = 16;

const accent = () => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--g-accent').trim() || '#7F00FF';
  } catch {
    return '#7F00FF';
  }
};
const hereIcon = () =>
  L.divIcon({
    className: '',
    html: `<div style="position:relative;width:18px;height:18px">
      <span style="position:absolute;inset:-10px;border-radius:9999px;background:rgba(59,130,246,.22);animation:cio-pulse 1.8s ease-out infinite"></span>
      <span style="position:absolute;inset:0;border-radius:9999px;background:#3b82f6;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></span>
    </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
const startIcon = () =>
  L.divIcon({
    className: '',
    html: `<svg width="34" height="44" viewBox="0 0 36 48" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M18 0C8 0 0 8 0 18c0 13 18 30 18 30s18-17 18-30C36 8 28 0 18 0z" fill="${accent()}" stroke="#fff" stroke-width="2.5"/><circle cx="18" cy="18" r="7" fill="#fff"/></svg>`,
    iconSize: [34, 44],
    iconAnchor: [17, 44]
  });

function metres(a: Coords, b: Coords) {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const x = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const CheckInOutMap: React.FC<{ token: string; onClose: () => void; onDone: (kind: 'in' | 'out', text: string) => void }> = ({ token, onClose, onDone }) => {
  const wide = useMdUp();
  const auth = { Authorization: `Bearer ${token}` };
  const [open, setOpen] = useState<ClaimRecord | null | undefined>(undefined); // undefined = loading
  const [coords, setCoords] = useState<Coords | null>(null);
  const [locating, setLocating] = useState(true);
  const [gpsError, setGpsError] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [nearby, setNearby] = useState<{ label: string; distance_m: number }[]>([]);
  const [purpose, setPurposeState] = useState(() => readDraft<string>('checkinout-purpose') || '');
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const setPurpose = (v: string) => {
    setPurposeState(v);
    if (v.trim()) saveDraft('checkinout-purpose', v);
    else clearDraft('checkinout-purpose');
  };
  useBackButtonClose(true, () => !submitting && onClose());

  const kind: 'in' | 'out' = open ? 'out' : 'in';
  const start: Coords | null = open ? { latitude: Number(open.check_in_lat), longitude: Number(open.check_in_lng) } : null;
  const travelled = start && coords ? metres(start, coords) : null;

  // What's next: Check In or Check Out.
  useEffect(() => {
    fetch(apiUrl('/api/claims/status'), { headers: auth })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load your Check In/Out.'))))
      .then((d) => setOpen(d || null))
      .catch((e) => {
        setOpen(null);
        setError(e.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locate = async () => {
    setLocating(true);
    setGpsError('');
    try {
      setCoords(await getCurrentCoords());
    } catch (e: any) {
      setGpsError(e?.message || "Couldn't get your location.");
    } finally {
      setLocating(false);
    }
  };
  useEffect(() => {
    void locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The address and the nearest sites, for each new fix.
  useEffect(() => {
    if (!coords) return;
    let alive = true;
    setAddress(null);
    const q = `lat=${coords.latitude}&lng=${coords.longitude}`;
    fetch(apiUrl(`/api/vehicles/places/reverse?${q}`), { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setAddress(d?.label || ''))
      .catch(() => alive && setAddress(''));
    fetch(apiUrl(`/api/vehicles/places/nearby?${q}`), { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setNearby(Array.isArray(d?.offices) ? d.offices : []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords?.latitude, coords?.longitude]);

  // The map.
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const hereRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const startRef = useRef<L.Marker | null>(null);
  // Puts you (and on Check Out the Check In pin) in view — again whenever the
  // map's box changes size (the sheet growing, the keyboard, rotating).
  const fitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { center: DHAKA, zoom: 12, zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      fitRef.current();
    });
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      hereRef.current = startRef.current = null;
      lineRef.current = null;
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (coords) {
      const at: L.LatLngTuple = [coords.latitude, coords.longitude];
      if (hereRef.current) hereRef.current.setLatLng(at);
      else hereRef.current = L.marker(at, { icon: hereIcon(), zIndexOffset: 500 }).addTo(map);
    }
    if (start && !startRef.current) startRef.current = L.marker([start.latitude, start.longitude], { icon: startIcon() }).addTo(map).bindPopup('Checked in here');
    if (start && coords) {
      const pts: L.LatLngTuple[] = [
        [start.latitude, start.longitude],
        [coords.latitude, coords.longitude]
      ];
      if (lineRef.current) lineRef.current.setLatLngs(pts);
      else lineRef.current = L.polyline(pts, { color: accent(), weight: 4, dashArray: '8 8' }).addTo(map);
      fitRef.current = () => map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: ZOOM, animate: false });
    } else if (coords) fitRef.current = () => map.setView([coords.latitude, coords.longitude], ZOOM, { animate: false });
    else if (start) fitRef.current = () => map.setView([start.latitude, start.longitude], ZOOM, { animate: false });
    map.invalidateSize();
    fitRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords?.latitude, coords?.longitude, open]);
  useEffect(() => {
    mapRef.current?.invalidateSize();
  }, [wide]);

  const submit = async () => {
    if (!coords || open === undefined) return;
    if (kind === 'in' && !purpose.trim()) return setError('Write where / why you are going first.');
    setSubmitting(true);
    setError('');
    try {
      const url = kind === 'in' ? '/api/claims/check-in' : `/api/claims/${open!.id}/check-out`;
      const body = { ...(kind === 'in' ? { purpose: purpose.trim() } : {}), latitude: coords.latitude, longitude: coords.longitude, remarks: remarks.trim() || undefined };
      const res = await fetch(apiUrl(url), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not check ${kind}.`);
      if (kind === 'out') setPurpose('');
      onDone(kind, kind === 'in' ? 'Checked in — have a safe trip!' : `Checked out — ${data.distance_km} km travelled.`);
    } catch (e: any) {
      setError(e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const ready = !!coords && open !== undefined;
  const canSubmit = ready && !submitting && (kind === 'out' || !!purpose.trim());

  const panel = (
    <div className="px-4 sm:px-5 pt-1 pb-1 flex flex-col gap-3">
      <div>
        <h2 className="text-xl font-extrabold text-slate-900">{open === undefined ? 'Check In/Out' : kind === 'in' ? 'Check In' : 'Check Out'}</h2>
        <p className="text-[12px] text-slate-500 mt-0.5">
          {open ? `Checked in at ${timeOf(open.check_in_at)} · ${open.purpose}` : 'Going out for office work? Check in where you start, check out when you finish.'}
        </p>
      </div>

      {/* Where you are. */}
      <div className="flex items-center gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 bg-white" style={{ borderColor: 'var(--g-accent, #7F00FF)', boxShadow: '0 0 0 3px rgba(var(--g-accent-rgb, 127, 0, 255), 0.12)' }}>
        <MapPin className="w-5 h-5 shrink-0" style={{ color: 'var(--g-accent, #7F00FF)' }} fill="currentColor" stroke="white" />
        <div className="min-w-0 flex-1">
          {gpsError ? (
            <span className="block text-[13px] text-rose-700">{gpsError}</span>
          ) : !coords ? (
            <span className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner size={14} /> Finding your location…
            </span>
          ) : (
            <>
              <span className="block truncate text-[15px] font-semibold text-slate-900">{address === null ? 'Finding the address…' : address || 'Your location'}</span>
              <span className="block truncate text-[11.5px] text-slate-500 font-mono">
                {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)}
              </span>
            </>
          )}
        </div>
        {gpsError && (
          <button type="button" onClick={() => void locate()} className="text-xs font-bold px-3 py-1.5 rounded-full bg-slate-100 text-slate-700 shrink-0">
            Try again
          </button>
        )}
      </div>

      {kind === 'out' && travelled != null && (
        <div className="flex items-center gap-2 text-[13px] font-semibold px-3.5 py-2.5 rounded-2xl bg-blue-50 text-blue-700">
          <Route className="w-4 h-4 shrink-0" /> Travelled {fmt(travelled)} from your Check In point
        </div>
      )}

      {kind === 'in' && open !== undefined && (
        <div>
          <label className="block text-[12px] font-semibold text-slate-500 mb-1">Purpose / where are you going</label>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={255}
            placeholder="e.g. Bank visit — City Branch"
            className="w-full text-[15px] px-3.5 py-2.5 bg-slate-100/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-[color:var(--g-accent,#7F00FF)]"
          />
          {nearby.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">
              {nearby.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setPurpose(p.label)}
                  className="shrink-0 flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                >
                  <Building2 className="w-3.5 h-3.5" style={{ color: 'var(--g-accent, #7F00FF)' }} /> {p.label}
                  <span className="font-normal text-slate-400">{fmt(p.distance_m)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {open !== undefined && (
        <div>
          <label className="block text-[12px] font-semibold text-slate-500 mb-1">
            Remarks <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder={kind === 'in' ? 'e.g. Leaving now, back in about an hour' : 'e.g. Meeting done, heading back'}
            className="w-full text-[14px] px-3.5 py-2.5 bg-slate-100/80 rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-[color:var(--g-accent,#7F00FF)]"
          />
        </div>
      )}

      {error && <p className="text-[13px] text-rose-700 bg-rose-50 rounded-2xl px-3.5 py-2.5">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className={`w-full min-h-[52px] rounded-full text-[16px] font-extrabold text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-transform active:scale-[0.98] ${kind === 'in' ? 'bg-emerald-600 shadow-[0_12px_24px_-10px_rgba(5,150,105,0.7)]' : 'liquid-glass-button'}`}
      >
        {submitting ? <Spinner size={18} /> : kind === 'in' ? <LogIn className="w-5 h-5" /> : <LogOut className="w-5 h-5" />}
        {kind === 'in' ? 'Check In here' : 'Check Out here'}
      </button>
    </div>
  );

  const backBtn = (
    <button
      type="button"
      onClick={() => !submitting && onClose()}
      className="absolute left-4 z-[500] w-11 h-11 rounded-full bg-white/90 backdrop-blur shadow-lg flex items-center justify-center text-slate-800"
      style={{ top: wide ? 16 : 'calc(14px + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))' }}
      aria-label="Back"
    >
      <ArrowLeft className="w-5 h-5" />
    </button>
  );
  const locateBtn = (
    <button
      type="button"
      onClick={() => void locate()}
      disabled={locating}
      className="w-11 h-11 rounded-full bg-white shadow-lg flex items-center justify-center text-slate-800"
      aria-label="My location"
    >
      {locating ? <Spinner size={16} /> : <LocateFixed className="w-5 h-5" />}
    </button>
  );
  const mapBox = (
    <>
      <div ref={boxRef} className="absolute inset-0" />
      {!coords && !gpsError && (
        <div className="absolute inset-0 z-[450] grid place-items-center pointer-events-none">
          <span className="rounded-full bg-white/95 px-4 py-2 text-[13px] font-semibold text-slate-700 shadow-lg flex items-center gap-2">
            <Spinner size={14} /> Finding your location…
          </span>
        </div>
      )}
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Check In/Out">
      <style>{'@keyframes cio-pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.8);opacity:0}}'}</style>
      {wide ? (
        <div className="absolute inset-0 liquid-glass-backdrop flex items-center justify-center p-6" onClick={() => !submitting && onClose()}>
          <div className="relative w-full max-w-[1040px] h-[min(700px,90vh)] rounded-[32px] overflow-hidden bg-white shadow-2xl flex" onClick={(e) => e.stopPropagation()}>
            <div className="relative flex-1 bg-slate-100">
              {mapBox}
              {backBtn}
              <div className="absolute right-4 bottom-4 z-[500]">{locateBtn}</div>
            </div>
            <div className="w-[380px] shrink-0 overflow-y-auto py-5">{panel}</div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 bg-slate-100 flex flex-col">
          <div className="relative flex-1 min-h-[38%]">
            {mapBox}
            {backBtn}
          </div>
          <div className="relative z-[550] -mt-6 rounded-t-[28px] bg-white/95 backdrop-blur-xl shadow-[0_-10px_30px_rgba(0,0,0,0.12)] max-h-[62%] flex flex-col">
            <div className="absolute -top-14 right-4">{locateBtn}</div>
            <div className="mx-auto mt-2.5 mb-1 h-1 w-10 rounded-full bg-slate-300 shrink-0" />
            <div className="overflow-y-auto" style={{ paddingBottom: 'calc(14px + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
              {panel}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

export default CheckInOutMap;
