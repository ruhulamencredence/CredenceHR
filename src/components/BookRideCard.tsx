/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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
  status: 'pending' | 'approved' | 'ongoing' | 'rejected' | 'cancelled' | 'completed';
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
}

export const ACTIVE_LABEL: Record<string, { text: string; color: string }> = {
  pending: { text: 'Awaiting approval', color: 'bg-yellow-100 text-yellow-800' },
  approved: { text: 'Awaiting vehicle', color: 'bg-teal-100 text-teal-800' },
  ongoing: { text: 'Ride ongoing', color: 'bg-green-100 text-green-800' }
};

// This account's own rides still in progress (awaiting approval, awaiting a
// vehicle, or ongoing), newest first.
export function useActiveRides(token: string, userId: number): Ride[] | null {
  const [active, setActive] = useState<Ride[] | null>(null);
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
  }, [token, userId]);
  return active;
}

// Web Dashboard quick access to Book a Ride (VehicleManagement.tsx): a
// "Where are you going?" shortcut plus this account's own current ride, if
// any, so its status is one glance away.
export const BookRideCard: React.FC<BookRideCardProps> = ({ token, userId, onOpen, className = '' }) => {
  const active = (useActiveRides(token, userId) || []).slice(0, 2);

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Car className="w-4 h-4 text-blue-600" /> Book a Ride
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">Request an office vehicle</p>
        </div>
        <button type="button" onClick={() => onOpen('status')} className="text-xs font-medium text-blue-600 hover:underline shrink-0">
          Ride Status
        </button>
      </div>

      <div className="p-5 sm:px-6 space-y-3 flex-1">
        <button
          type="button"
          onClick={() => onOpen('book')}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-slate-50 border border-slate-200 text-left hover:border-blue-300 hover:bg-white transition-colors"
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
              className="w-full text-left px-3.5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors"
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
                {r.status === 'ongoing' && r.vehicle_no ? ` · ${r.vehicle_model || ''} (${r.vehicle_no})${r.driver_name ? ` · ${r.driver_name}` : ''}` : ''}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};
