/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, MapPin, Route, LogIn, LogOut } from 'lucide-react';
import { ClaimRecord } from '../types';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface ClaimLocationMapProps {
  claim: ClaimRecord;
  onClose: () => void;
}

const CLAIM_ZOOM = 15;

// Same green "start" / blue "current or destination" pins ClaimMapConfirm.tsx uses
// while checking in/out, reused here so a completed Claim's history looks the same
// visual language as the live confirm screen did.
const startPinIcon = L.divIcon({
  className: '',
  html: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#059669"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 30],
  popupAnchor: [0, -26]
});

const endPinIcon = L.divIcon({
  className: '',
  html: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#7F00FF"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 30],
  popupAnchor: [0, -26]
});

// User Dashboard -> My Claims -> tap any claim: shows exactly where that Movement
// Claim's Check In happened (and Check Out too, if it's already completed) on a map,
// with the same point A -> point B line + distance ClaimMapConfirm shows live while
// checking out. Read-only — just a Close button, no confirm/submit here.
export default function ClaimLocationMap({ claim, onClose }: ClaimLocationMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [ready, setReady] = useState(false);

  useBackButtonClose(true, onClose);

  const hasCheckOut = claim.check_out_lat != null && claim.check_out_lng != null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const startLatLng: [number, number] = [Number(claim.check_in_lat), Number(claim.check_in_lng)];
    const map = L.map(mapContainerRef.current, { center: startLatLng, zoom: CLAIM_ZOOM });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    L.marker(startLatLng, { icon: startPinIcon }).addTo(map).bindPopup('Checked in here');
    const bounds: L.LatLngExpression[] = [startLatLng];

    if (hasCheckOut) {
      const endLatLng: [number, number] = [Number(claim.check_out_lat), Number(claim.check_out_lng)];
      L.marker(endLatLng, { icon: endPinIcon }).addTo(map).bindPopup('Checked out here');
      bounds.push(endLatLng);
      L.polyline([startLatLng, endLatLng], { color: '#7F00FF', weight: 3, dashArray: '6 6' }).addTo(map);
    }

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rendered via a portal straight onto document.body instead of in place —
  // same reasoning as NewConveyanceClaimModal: one of this popup's callers
  // (MyClaimsCard.tsx's mobile "liquid glass" card) has a backdrop-blur-xl
  // ancestor, which the CSS spec makes a containing block for any
  // `position: fixed` descendant (same as `transform`/`filter`) — without
  // the portal this popup was pinned to that CARD's box instead of the
  // viewport, drifting/clipping as the card's own height changed with its
  // content. A portal escapes that ancestor entirely, for every caller.
  return createPortal(
    // z-[60] — deliberately above the Movement Claims page's own floating
    // "Add Check In/Out" button and its Check In/Out sheet (both z-50 in
    // UserPanel.tsx). At equal z-50 this popup and that button sit in the
    // same stacking context, so the button — mounted later in the DOM —
    // painted on top and covered this popup's Close button. Bumping this
    // popup above every z-50 element it can be opened over (My Claims list,
    // Claims review panel) fixes the overlap without touching the button.
    <div className="fixed inset-0 z-[60] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[92vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100 shrink-0">
              <MapPin className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900">Movement Location</h3>
              <p className="text-xs text-slate-500 truncate">{claim.purpose}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          <div className="relative">
            <div ref={mapContainerRef} className="w-full h-72 sm:h-80 rounded-xl border border-slate-200 overflow-hidden" />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-50 rounded-xl">
                <MapPin className="w-5 h-5 text-slate-300 animate-pulse" />
              </div>
            )}
          </div>

          {hasCheckOut && claim.distance_km != null && (
            <div className="flex items-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl bg-blue-50 text-blue-700">
              <Route className="w-4 h-4 shrink-0" />
              <span>Travelled {claim.distance_km} km from Check In to Check Out.</span>
            </div>
          )}

          <div className="space-y-2 text-xs text-slate-600">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                <LogIn className="w-3.5 h-3.5" /> Check In &middot; {formatDate(claim.check_in_at)}{' '}
                {new Date(claim.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {claim.check_out_at ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
                  <LogOut className="w-3.5 h-3.5" /> Check Out &middot; {formatDate(claim.check_out_at)}{' '}
                  {new Date(claim.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ) : (
              <p className="text-slate-400">Not checked out yet — only the Check In location is available.</p>
            )}
          </div>
        </div>

        <div className="p-5 border-t border-slate-200 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}