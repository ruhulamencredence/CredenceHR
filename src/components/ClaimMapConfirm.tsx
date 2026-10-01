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
import { X, MapPin, Check, Route, LocateFixed } from 'lucide-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface ClaimMapConfirmProps {
  kind: 'in' | 'out';
  purpose: string;
  // Only set when kind === 'out' — the point this claim was checked in from, so
  // the map can show the full point A -> point B picture instead of just where
  // the user is right now.
  checkInCoords?: { latitude: number; longitude: number } | null;
  coords: { latitude: number; longitude: number };
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (remarks: string) => void;
  // Fires whenever the "Use current location" button gets a fresh GPS fix —
  // lets the parent (ClaimCard) keep its own `pending.coords` in sync so the
  // eventual check-in/out POST sends this refreshed point, not the original
  // snapshot taken before the modal opened. Optional so older callers that
  // don't pass it still work (falls back to the initial coords).
  onCoordsChange?: (coords: { latitude: number; longitude: number }) => void;
}

const CLAIM_ZOOM = 15;

// Same violet "reference point" pin AttendanceMapConfirm uses for the
// project's site — used here for the Check In point, so both popups read the
// same color language: violet pin = a fixed point already on record.
const startPinIcon = L.divIcon({
  className: '',
  html: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#7F00FF"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 30],
  popupAnchor: [0, -26]
});

// Same pulsing live-position dot AttendanceMapConfirm uses for "you, right
// now" — used here for both a plain Check In and the Check Out point, same
// color language across both popups: the pin is a place, the dot is a person.
const currentDotIcon = L.divIcon({
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
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// Same geolocation flow ClaimCard.tsx already uses to get the initial fix:
// Capacitor's plugin on the native Android app build, plain
// navigator.geolocation on the web build. Kept as its own copy here (not
// imported) matching the existing convention in this codebase of each file
// owning its own copy.
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
        throw new Error('Location permission is required for a Movement Claim. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required for a Movement Claim. Please allow location access and try again.');
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

// Shown after the device's GPS fix comes back and before the actual Claim
// check-in/check-out API call fires — lets the user see the point(s) on a map
// before committing. On check-out, draws BOTH the original Check In point and
// the current (Check Out) point with a line + distance between them, since a
// Movement Claim is a point A -> point B travel record, not a fixed-site visit.
export default function ClaimMapConfirm({
  kind,
  purpose,
  checkInCoords,
  coords,
  submitting,
  onCancel,
  onConfirm,
  onCoordsChange
}: ClaimMapConfirmProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const currentMarkerRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);

  const [ready, setReady] = useState(false);
  const [remarks, setRemarks] = useState('');
  // The point actually shown/submitted — starts as the snapshot the parent
  // captured before opening this modal, but can be refreshed in place via the
  // "Use current location" button below without closing/reopening the modal.
  const [liveCoords, setLiveCoords] = useState(coords);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  useBackButtonClose(true, submitting ? () => {} : onCancel);

  const hasCheckIn = kind === 'out' && !!checkInCoords;
  const distance = hasCheckIn
    ? haversineMeters(checkInCoords!.latitude, checkInCoords!.longitude, liveCoords.latitude, liveCoords.longitude)
    : null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, { center: [liveCoords.latitude, liveCoords.longitude], zoom: CLAIM_ZOOM });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const bounds: L.LatLngExpression[] = [[liveCoords.latitude, liveCoords.longitude]];

    if (hasCheckIn) {
      L.marker([checkInCoords!.latitude, checkInCoords!.longitude], { icon: startPinIcon })
        .addTo(map)
        .bindPopup('Checked in here');
      bounds.push([checkInCoords!.latitude, checkInCoords!.longitude]);
      lineRef.current = L.polyline(
        [
          [checkInCoords!.latitude, checkInCoords!.longitude],
          [liveCoords.latitude, liveCoords.longitude]
        ],
        { color: '#7F00FF', weight: 3, dashArray: '6 6' }
      ).addTo(map);
    }

    currentMarkerRef.current = L.marker([liveCoords.latitude, liveCoords.longitude], { icon: currentDotIcon })
      .addTo(map)
      .bindPopup(kind === 'out' ? 'Checking out here' : 'You are here');

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: CLAIM_ZOOM });
    }

    setTimeout(() => {
      map.invalidateSize();
      setReady(true);
    }, 80);

    return () => {
      map.remove();
      mapRef.current = null;
      currentMarkerRef.current = null;
      lineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-reads GPS (same permission/flow as the initial fix) and moves the
  // existing marker (plus the point A -> point B line on Check Out) in place,
  // instead of forcing the user to cancel and re-tap Check In/Out just to
  // pick up a better fix.
  const handleUseCurrentLocation = async () => {
    setLocating(true);
    setLocateError(null);
    try {
      const fresh = await getCurrentCoords();
      setLiveCoords(fresh);
      onCoordsChange?.(fresh);
      currentMarkerRef.current?.setLatLng([fresh.latitude, fresh.longitude]);
      if (hasCheckIn && lineRef.current) {
        lineRef.current.setLatLngs([
          [checkInCoords!.latitude, checkInCoords!.longitude],
          [fresh.latitude, fresh.longitude]
        ]);
      }
      if (mapRef.current) {
        const bounds: L.LatLngExpression[] = [[fresh.latitude, fresh.longitude]];
        if (hasCheckIn) bounds.push([checkInCoords!.latitude, checkInCoords!.longitude]);
        if (bounds.length > 1) {
          mapRef.current.fitBounds(bounds, { padding: [48, 48], maxZoom: CLAIM_ZOOM });
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

  // Rendered via a portal straight onto document.body — see the matching
  // note in AttendanceMapConfirm.tsx. This component is mounted deep inside
  // UserPanel's dashboard tree (ClaimCard -> here), behind the same
  // `overflow-hidden` ancestor, so without the portal this popup gets
  // clipped to that ancestor's box on a lot of Android WebViews instead of
  // covering the true full screen — cutting it off near the header and
  // letting BottomNav's background show through at the bottom.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.5rem)'
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
              <p className="text-xs text-slate-500 truncate max-w-[280px]">{purpose}</p>
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

          {hasCheckIn ? (
            <div className="flex items-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl bg-blue-50 text-blue-700">
              <Route className="w-4 h-4 shrink-0" />
              <span>Travelled {formatDistance(distance as number)} from your Check In point.</span>
            </div>
          ) : (
            <p className="text-xs text-slate-500 px-1">
              This will start a new Claim from your current location — remember to Check Out once you reach or finish.
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
              placeholder={kind === 'in' ? 'e.g. Leaving now, expect ~1 hour' : 'e.g. Meeting done, heading back'}
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
