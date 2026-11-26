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
import { nativeAttendanceFix, MOCK_LOCATION_MESSAGE, type AttendanceFix } from '../lib/attendanceFix';
import { X, MapPin, AlertTriangle, CheckCircle2, LocateFixed } from 'lucide-react';
import { Project } from '../types';
import { apiUrl } from '../lib/api';
import { useKeyboardGap, scrollFocusedFieldIntoView } from '../lib/useKeyboardInset';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface AttendanceMapConfirmProps {
  kind: 'in' | 'out';
  // Outside every one of the account's own Projects: it goes for approval,
  // and a reason is required.
  offsite?: boolean;
  project: Project;
  coords: AttendanceFix;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (remarks: string) => void;
  // Fires whenever the "Use current location" button gets a fresh GPS fix —
  // lets the parent (AttendanceCard) keep its own `pending.coords` in sync so
  // the eventual check-in/out POST sends this refreshed point, not the
  // original snapshot taken before the modal opened. Optional so older
  // callers that don't pass it still work (falls back to the initial coords).
  onCoordsChange?: (coords: AttendanceFix) => void;
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
  html: `<div style="width:34px;height:34px;border-radius:50%;background:rgba(37,99,235,.18);display:flex;align-items:center;justify-content:center"><div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div></div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17]
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

// The theme's accent (Orange / Violet / …) for the attendance-area circles —
// Leaflet takes a colour string, not a CSS variable.
function accentColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--g-accent').trim();
    if (v) return v;
  } catch {
    // no computed style (tests)
  }
  return '#f47920';
}

const nowLabel = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// Same geolocation flow AttendanceCard.tsx already uses to get the initial
// fix: Capacitor's plugin on the native Android app build (works without a
// browser permission prompt inside the WebView), plain navigator.geolocation
// on the web build. Kept as its own copy here (not imported) matching the
// existing convention in this codebase of each file owning its own copy.
async function getCurrentCoords(): Promise<AttendanceFix> {
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
    // The APK's own fix says whether it is fake GPS (mock location).
    const fix = await nativeAttendanceFix();
    if (fix) return fix;
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
  offsite = false,
  project,
  coords,
  submitting,
  onCancel,
  onConfirm,
  onCoordsChange,
  token
}: AttendanceMapConfirmProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const keyboard = useKeyboardGap();
  // The map gets smaller while the keyboard is up; Leaflet redraws its tiles for the new size.
  useEffect(() => {
    const t = window.setTimeout(() => mapRef.current?.invalidateSize(), 60);
    return () => window.clearTimeout(t);
  }, [keyboard.open]);
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
    // No +/- buttons: pinch to zoom (the location button sits on the map instead).
    const map = L.map(mapContainerRef.current, { center, zoom: PROJECT_ZOOM, zoomControl: false });
    map.attributionControl.setPrefix(false);
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
          color: accentColor(),
          weight: 2.5,
          fillColor: accentColor(),
          fillOpacity: 0.1
        }).addTo(map);
      }
    }

    userMarkerRef.current = L.marker([liveCoords.latitude, liveCoords.longitude], { icon: userDotIcon })
      .addTo(map)
      .bindPopup('You are here');

    // Show the whole attendance area and where you are (the status line
    // covers the top of the map, hence the larger top padding).
    const area = circleRef.current ? circleRef.current.getBounds().extend([liveCoords.latitude, liveCoords.longitude]) : null;
    // (The area is fitted below, once the map knows its size.)
    if (!area && bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: PROJECT_ZOOM });
    }

    const sizeTimer = setTimeout(() => {
      map.invalidateSize();
      if (area) map.fitBounds(area, { paddingTopLeft: [24, 56], paddingBottomRight: [24, 24], maxZoom: PROJECT_ZOOM, animate: false });
      setReady(true);
    }, 80);

    return () => {
      clearTimeout(sizeTimer);
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
          color: accentColor(),
          opacity: 0.5,
          weight: 1.5,
          dashArray: '5 4',
          fillColor: accentColor(),
          fillOpacity: 0.03
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
      if (fresh.mock) throw new Error(MOCK_LOCATION_MESSAGE);
      setLiveCoords(fresh);
      onCoordsChange?.(fresh);
      userMarkerRef.current?.setLatLng([fresh.latitude, fresh.longitude]);
      if (mapRef.current) {
        const bounds: L.LatLngExpression[] = [[fresh.latitude, fresh.longitude]];
        if (hasSite) bounds.push([Number(project.location_lat), Number(project.location_lng)]);
        if (circleRef.current) {
          mapRef.current.fitBounds(circleRef.current.getBounds().extend([fresh.latitude, fresh.longitude]), {
            paddingTopLeft: [24, 56],
            paddingBottomRight: [24, 24],
            maxZoom: PROJECT_ZOOM
          });
        } else if (bounds.length > 1) {
          mapRef.current.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: PROJECT_ZOOM });
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

  // The phone's first fix is often a coarse one (cell towers / Wi-Fi, a few
  // hundred metres off) and the map used to keep it until the person pressed
  // the locate button — so people standing inside the area were shown "491 m
  // away". While the position reads as outside the area, quietly read GPS again
  // a few times (3 s apart) and move the marker; stops at once when it is inside,
  // when the person is already submitting, or after 4 tries. The fix that is
  // sent is always the last one shown, and the server still checks it.
  const autoTriesRef = useRef(0);
  const insideRef = useRef<boolean | null>(null);
  insideRef.current = inside;
  const busyRef = useRef(false);
  busyRef.current = locating || submitting;
  useEffect(() => {
    if (!hasRadius || offsite) return;
    let gone = false;
    const timer = window.setInterval(() => {
      if (gone || insideRef.current !== false || busyRef.current || autoTriesRef.current >= 4) {
        if (insideRef.current === true || autoTriesRef.current >= 4) window.clearInterval(timer);
        return;
      }
      autoTriesRef.current += 1;
      getCurrentCoords()
        .then((fresh) => {
          if (gone || fresh.mock || busyRef.current) return;
          setLiveCoords(fresh);
          onCoordsChange?.(fresh);
          userMarkerRef.current?.setLatLng([fresh.latitude, fresh.longitude]);
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRadius, offsite]);


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
  // One line on the map: where you stand against the area.
  const status: { tone: 'ok' | 'warn' | 'bad' | 'plain'; text: string } = !hasSite
    ? { tone: 'plain', text: `No site location set for ${project.project_name}` }
    : !hasRadius
      ? { tone: 'plain', text: `${formatDistance(distance as number)} from ${project.location_label || project.project_name} · no area set` }
      : inside
        ? { tone: 'ok', text: `You're inside ${project.project_name}'s area · ${formatDistance(distance as number)}` }
        : offsite
          ? { tone: 'warn', text: `${formatDistance(distance as number)} from ${project.project_name} — goes for approval` }
          : { tone: 'bad', text: `${formatDistance(distance as number)} away — outside the ${formatDistance(Number(project.location_radius))} area` };
  const toneCls = {
    ok: 'bg-emerald-50/95 text-emerald-700',
    warn: 'bg-orange-50/95 text-orange-700',
    bad: 'bg-rose-50/95 text-rose-700',
    plain: 'bg-white/90 text-slate-600'
  }[status.tone];
  const label = kind === 'in' ? 'In Time' : 'Out Time';
  const [timeNow, setTimeNow] = useState(nowLabel);
  useEffect(() => {
    const t = window.setInterval(() => setTimeNow(nowLabel()), 20000);
    return () => window.clearInterval(t);
  }, []);

  // Rendered via a portal straight onto document.body instead of in place —
  // this component gets mounted deep inside UserPanel's dashboard tree,
  // which has an `overflow-hidden` ancestor; on a number of Android WebViews
  // a `position: fixed` element nested inside it gets clipped to that box.
  // Liquid-glass popup (house style): a big map with the status line and the
  // location button on it, Remarks / Reason, and Cancel / Submit side by side.
  return createPortal(
    <div
      // Keeps itself above the keyboard (paddingBottom below) — so the app-wide
      // html.kb-open rule (index.css) must not lift it a second time: both at
      // once squeezed the popup to a sliver at the top while typing Remarks.
      data-kb-self
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-2.5 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        // Typing the Reason / Remarks: the popup ends above the on-screen
        // keyboard (some Android WebViews don't shrink the page for it, so
        // the box stayed under the keyboard) and the box is scrolled into view.
        paddingBottom: keyboard.gap
          ? `${keyboard.gap + 8}px`
          : 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.75rem)'
      }}
    >
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => !submitting && onCancel()} />
      <div className="relative w-full max-w-lg flex flex-col" style={{ maxHeight: '100%' }}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full overflow-clip flex flex-col" style={{ maxHeight: '100%' }}>
          <div className="px-5 pt-5 pb-1 flex items-start justify-between gap-3 shrink-0">
            <div className="min-w-0">
              <h3 className="text-[22px] font-extrabold text-slate-900 leading-tight">{label}</h3>
              <p className="text-[12.5px] text-slate-500 mt-0.5 truncate">
                {offsite ? 'Outside your project area' : project.project_name} · now {timeNow}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              aria-label="Close"
              className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600 active:scale-95 transition-transform disabled:opacity-40"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 pt-3 pb-4 space-y-3 overflow-y-auto min-h-0" onFocusCapture={scrollFocusedFieldIntoView}>
            <div className="relative rounded-3xl overflow-hidden liquid-glass-inset" style={{ height: keyboard.open ? '120px' : 'clamp(200px, 40vh, 340px)' }}>
              <div ref={mapContainerRef} className="absolute inset-0" />
              {!ready && (
                <div className="absolute inset-0 z-[500] flex items-center justify-center bg-slate-50">
                  <Spinner size={20} className="text-slate-400" />
                </div>
              )}
              {/* Status on the map: inside / outside / goes for approval. */}
              <div
                data-testid="attendance-map-status"
                className={`absolute left-2.5 right-2.5 top-2.5 z-[500] flex items-start gap-1.5 rounded-[18px] px-3 py-2 text-xs font-bold leading-snug shadow-sm backdrop-blur ${toneCls}`}
              >
                {status.tone === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : status.tone === 'plain' ? <MapPin className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                <span className="min-w-0">{status.text}</span>
              </div>
              {/* Fresh GPS fix — on the map, like a maps app. */}
              <button
                type="button"
                onClick={handleUseCurrentLocation}
                disabled={locating || submitting}
                aria-label="Use current location"
                className={`absolute right-3 z-[500] w-12 h-12 rounded-full bg-white text-slate-800 shadow-[0_8px_18px_-8px_rgba(0,0,0,.45)] flex items-center justify-center active:scale-95 transition-transform disabled:opacity-60 ${keyboard.open ? 'bottom-2 w-10 h-10' : 'bottom-6'}`}
              >
                {locating ? <Spinner size={18} /> : <LocateFixed className="w-5 h-5" />}
              </button>
            </div>
            {locateError && <p className="text-xs text-rose-600 px-1">{locateError}</p>}

            <div>
              <label htmlFor="attendance-remarks" className="block text-[13px] font-bold text-slate-900 mb-1.5 px-0.5">
                {offsite ? 'Reason' : 'Remarks'} <span className="font-medium text-slate-500">{offsite ? '(needed)' : '(optional)'}</span>
              </label>
              <textarea
                id="attendance-remarks"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                maxLength={1000}
                rows={2}
                placeholder={offsite ? 'Why are you giving it from here?' : kind === 'in' ? 'e.g. Reached late — traffic' : 'e.g. Left early, cleared with PM'}
                className={`w-full text-sm px-4 py-3 rounded-2xl liquid-glass-inset focus:outline-none focus:ring-2 focus:ring-[var(--g-accent,#f47920)] resize-none ${
                  offsite && !remarks.trim() ? 'ring-1 ring-orange-300' : ''
                }`}
              />
              {offsite && <p className="mt-1 px-1 text-[11px] text-slate-500">It goes to your approvers and counts as attendance once approved.</p>}
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="liquid-glass-chip h-12 rounded-full text-[15px] font-bold text-slate-700 active:scale-[0.98] transition-transform disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onConfirm(remarks.trim())}
                disabled={submitting || (offsite && !remarks.trim())}
                className="liquid-glass-button h-12 rounded-full text-[15px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:active:scale-100"
              >
                {submitting && <Spinner size={16} />}
                Submit
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
