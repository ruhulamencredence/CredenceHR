/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveTick } from '../lib/liveRefresh';
import { useCachedState } from '../lib/screenCache';
import React, { useEffect, useState } from 'react';
import { Car, MapPin, ChevronRight } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { BookRideTarget } from '../lib/quickAccess';

interface BookRideCardProps {
  token: string;
  userId: number;
  onOpen: (tab: BookRideTarget) => void;
  className?: string;
}

export interface Ride {
  id: number;
  employee_user_id: number;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  status: 'pending' | 'approved' | 'assigned' | 'ongoing' | 'rejected' | 'cancelled' | 'completed' | 'expired';
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
}

export const ACTIVE_LABEL: Record<string, { text: string; color: string }> = {
  pending: { text: 'Awaiting approval', color: 'bg-yellow-100 text-yellow-800' },
  approved: { text: 'Awaiting vehicle', color: 'bg-teal-100 text-teal-800' },
  assigned: { text: 'Car assigned — not started', color: 'bg-indigo-100 text-indigo-800' },
  ongoing: { text: 'Ride ongoing', color: 'bg-green-100 text-green-800' }
};

// This account's own rides still in progress (awaiting approval, awaiting a
// vehicle, or ongoing), newest first.
export function useActiveRides(token: string, userId: number): Ride[] | null {
  // Last copy from this device first (screenCache.ts), then the fresh list.
  const [active, setActive] = useCachedState<Ride[] | null>('rides-active', null);
  // Live refresh: the ride's status updates without a page reload.
  const liveTick = useLiveTick();
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/vehicles/requisitions'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setActive(rows.filter((r: Ride) => Number(r.employee_user_id) === Number(userId) && ACTIVE_LABEL[r.status]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, userId, liveTick]);
  return active;
}

// The card's background: a quiet drawn street map (blocks, a park, a
// river, a dashed route to a red pin) on the right, fading out to the left
// so the text stays clear. Colours come from .ride-map in index.css (light
// and dark). Purely decorative.
const RideMap: React.FC = () => (
  <svg
    className="ride-map absolute inset-0 w-full h-full pointer-events-none"
    viewBox="0 0 420 258"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
    style={{ opacity: 0.9, WebkitMaskImage: 'linear-gradient(90deg, transparent 25%, #000 70%)', maskImage: 'linear-gradient(90deg, transparent 25%, #000 70%)' }}
  >
    <rect width="420" height="258" fill="var(--rm-land)" />
    <path d="M-10 190 C 80 170, 120 230, 210 205 S 330 150, 440 175 L440 215 C 330 190, 300 250, 210 245 S 80 210,-10 232Z" fill="var(--rm-water)" />
    <rect x="268" y="18" width="70" height="46" rx="6" fill="var(--rm-park)" />
    <rect x="34" y="96" width="54" height="40" rx="6" fill="var(--rm-park)" />
    <g fill="var(--rm-block)">
      <rect x="110" y="18" width="62" height="40" rx="4" />
      <rect x="190" y="18" width="60" height="40" rx="4" />
      <rect x="356" y="18" width="70" height="46" rx="4" />
      <rect x="110" y="84" width="62" height="52" rx="4" />
      <rect x="190" y="84" width="60" height="52" rx="4" />
      <rect x="268" y="84" width="70" height="52" rx="4" />
      <rect x="356" y="84" width="70" height="52" rx="4" />
      <rect x="-6" y="18" width="94" height="58" rx="4" />
    </g>
    <g stroke="var(--rm-road)" strokeWidth="9" fill="none" strokeLinecap="round">
      <path d="M-10 78 H440" />
      <path d="M-10 146 H440" />
      <path d="M100 -10 V170" />
      <path d="M181 -10 V160" />
      <path d="M259 -10 V150" />
      <path d="M347 -10 V160" />
      <path d="M20 270 C 60 200, 140 170, 181 146" strokeWidth="7" />
    </g>
    <path d="M60 236 C 70 200, 120 160, 181 146 S 259 112, 300 78" stroke="var(--rm-route)" strokeWidth="3.5" fill="none" strokeDasharray="7 6" strokeLinecap="round" />
    <circle cx="60" cy="236" r="6" fill="#fff" stroke="var(--rm-route)" strokeWidth="3" />
    <path d="M300 56 c-8 0 -13 6 -13 13 c0 9 13 21 13 21 s13 -12 13 -21 c0 -7 -5 -13 -13 -13z" fill="#ef4444" />
    <circle cx="300" cy="69" r="4.5" fill="#fff" />
  </svg>
);

// Web Dashboard quick access to Book a Ride (VehicleManagement.tsx): a
// "Where are you going?" shortcut plus this account's own current ride, if
// any, so its status is one glance away.
export const BookRideCard: React.FC<BookRideCardProps> = ({ token, userId, onOpen, className = '' }) => {
  const active = (useActiveRides(token, userId) || []).slice(0, 2);

  return (
    <div className={`relative bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col ${className}`}>
      <RideMap />
      <div className="relative px-5 pt-5 pb-4 sm:px-6 flex items-start justify-between gap-3">
        <div className="relative z-10">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Car className="w-4 h-4 text-blue-600" /> Book a Ride
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">Request an office vehicle</p>
          <button type="button" onClick={() => onOpen('status')} className="mt-1.5 text-xs font-medium text-blue-600 hover:underline">
            Ride Status
          </button>
        </div>
      </div>

      <div className="relative p-5 pt-1 sm:px-6 space-y-3 flex-1">
        <button
          type="button"
          onClick={() => onOpen('book')}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-white/80 backdrop-blur-sm border border-slate-200 shadow-[0_4px_14px_-6px_rgba(15,23,42,0.18)] text-left hover:border-blue-300 hover:bg-white transition-colors"
        >
          <MapPin className="w-5 h-5 text-red-500 shrink-0" />
          <span className="flex-1 text-sm text-slate-500">Where are you going?</span>
          <ChevronRight className="w-4 h-4 text-slate-400" />
        </button>

        {active.length === 0 ? (
          <p className="text-xs text-slate-400 px-1">No ride in progress.</p>
        ) : (
          active.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onOpen('status')}
              className="w-full text-left px-3.5 py-2.5 rounded-xl bg-white/80 backdrop-blur-sm border border-slate-200 hover:bg-white transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-800 truncate">
                  {r.pickup_location} → {r.destination}
                </span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${ACTIVE_LABEL[r.status].color}`}>
                  {ACTIVE_LABEL[r.status].text}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5 truncate">
                {String(r.ride_date).slice(0, 10)} at {r.start_time}
                {(r.status === 'ongoing' || r.status === 'assigned') && r.vehicle_no ? ` · ${r.vehicle_model || ''} (${r.vehicle_no})${r.driver_name ? ` · ${r.driver_name}` : ''}` : ''}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};
