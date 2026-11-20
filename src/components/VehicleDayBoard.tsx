/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Vehicle Management -> Ride Requests -> Day board: every car as a row, the
// rides it is booked for on one day as bars (with the gap kept around each),
// rides already done that day, and cars in maintenance. Cars are booked by
// time (VehicleManagementRoutes.ts, claimVehicle), so a car with a ride at
// 10:00 can still take one at 15:00 — this shows where the free time is.
// GET /api/vehicles/day-board?date=YYYY-MM-DD (Vehicle Management module).

import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { apiUrl } from '../lib/api';

interface BoardRide {
  requisition_id: number;
  start: string;
  end: string;
  status: string;
  who: string;
  leg: string | null;
}
interface BoardVehicle {
  id: number;
  vehicle_no: string;
  model: string;
  vehicle_type: string | null;
  status: string;
  rides: BoardRide[];
}

const dhakaToday = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
const shiftDay = (d: string, by: number) => new Date(Date.parse(`${d}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const hm = (iso: string) => new Date(Date.parse(iso) + 6 * 3600e3).toISOString().slice(11, 16);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  return `${DOW[x.getUTCDay()]}, ${String(x.getUTCDate()).padStart(2, '0')}-${MON[x.getUTCMonth()]}-${x.getUTCFullYear()}`;
};

const STYLE: Record<string, string> = {
  assigned: 'bg-amber-50 border-amber-400 text-amber-800',
  ongoing: 'bg-emerald-50 border-emerald-500 text-emerald-800',
  completed: 'bg-slate-100 border-slate-300 text-slate-500'
};

export const VehicleDayBoard: React.FC<{ authHeaders: () => HeadersInit; reloadKey?: unknown }> = ({ authHeaders, reloadKey }) => {
  const [day, setDay] = useState(dhakaToday());
  const [data, setData] = useState<{ date: string; gap_minutes: number; vehicles: BoardVehicle[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setError('');
    fetch(apiUrl(`/api/vehicles/day-board?date=${day}`), { headers: authHeaders() })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the day board.');
        if (alive) setData(d);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [day, reloadKey, authHeaders]);

  // The hours shown: 06:00–22:00, stretched to fit any ride outside them.
  const from = Date.parse(`${day}T00:00:00+06:00`);
  let firstH = 6;
  let lastH = 22;
  for (const v of data?.vehicles || [])
    for (const r of v.rides) {
      firstH = Math.min(firstH, Math.max(0, Math.floor((Date.parse(r.start) - from) / 3600e3)));
      lastH = Math.max(lastH, Math.min(24, Math.ceil((Date.parse(r.end) - from) / 3600e3)));
    }
  const span = (lastH - firstH) * 3600e3;
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - from - firstH * 3600e3) / span) * 100));
  const gapMs = (data?.gap_minutes ?? 30) * 60e3;
  const hours: number[] = [];
  for (let h = firstH; h <= lastH; h += 1) hours.push(h);

  return (
    <div className="border rounded-lg p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-gray-800 text-sm flex items-center gap-1.5">
            <CalendarDays className="w-4 h-4" /> Day board — {dayLabel(day)}
          </div>
          <div className="text-xs text-gray-500">
            Each car is booked only for its rides' time and a {data?.gap_minutes ?? 30} min gap around them; the rest of the day it can take other rides.
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))} className="p-1.5 rounded border hover:bg-gray-50">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="border rounded px-2 py-1 text-sm" />
          <button type="button" aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))} className="p-1.5 rounded border hover:bg-gray-50">
            <ChevronRight className="w-4 h-4" />
          </button>
          {day !== dhakaToday() && (
            <button type="button" onClick={() => setDay(dhakaToday())} className="px-2 py-1 rounded border text-xs font-medium hover:bg-gray-50">
              Today
            </button>
          )}
        </div>
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {data && data.vehicles.length === 0 && <div className="text-sm text-gray-500">No vehicles yet — add one in Vehicle Inventory.</div>}
      {data && data.vehicles.length > 0 && (
        <div className="overflow-x-auto">
          <div className="min-w-[640px]" role="table" aria-label="Day board">
            <div className="grid grid-cols-[140px_1fr] text-[10.5px] text-gray-500" role="row">
              <div role="columnheader" className="px-2 py-1">Vehicle</div>
              <div role="columnheader" className="relative h-6">
                {hours.map((h) => (
                  <span key={h} className="absolute top-1 -translate-x-1/2 tabular-nums" style={{ left: `${pct(from + h * 3600e3)}%` }}>
                    {String(h).padStart(2, '0')}
                  </span>
                ))}
              </div>
            </div>
            {data.vehicles.map((v) => (
              <div key={v.id} className="grid grid-cols-[140px_1fr] border-t" role="row">
                <div role="rowheader" className="px-2 py-2 min-w-0">
                  <div className="text-xs font-semibold text-gray-800 truncate">{v.vehicle_no}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {v.model}
                    {v.status === 'on_ride' ? ' · on the road' : ''}
                  </div>
                </div>
                <div role="cell" className="relative h-12">
                  {hours.map((h) => (
                    <span key={h} aria-hidden="true" className="absolute inset-y-0 w-px bg-gray-100" style={{ left: `${pct(from + h * 3600e3)}%` }} />
                  ))}
                  {v.status === 'maintenance' ? (
                    <div className="absolute inset-y-2 inset-x-0 rounded border border-gray-300 bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_6px,#e5e7eb_6px,#e5e7eb_12px)] text-[11px] text-gray-500 flex items-center px-2">
                      Maintenance — not given to rides
                    </div>
                  ) : (
                    v.rides.map((r) => {
                      const s = Date.parse(r.start);
                      const e = Date.parse(r.end);
                      const left = pct(s);
                      const width = Math.max(0.8, pct(e) - left);
                      return (
                        <React.Fragment key={`${r.requisition_id}-${r.leg || ''}-${r.status}`}>
                          {r.status !== 'completed' && gapMs > 0 && (
                            <div
                              aria-hidden="true"
                              className="absolute inset-y-3 bg-orange-100 rounded"
                              style={{ left: `${pct(s - gapMs)}%`, width: `${Math.max(0, pct(e + gapMs) - pct(s - gapMs))}%` }}
                            />
                          )}
                          <div
                            className={`absolute inset-y-2 rounded border text-[11px] font-medium px-1.5 flex items-center overflow-hidden whitespace-nowrap ${STYLE[r.status] || STYLE.assigned}`}
                            style={{ left: `${left}%`, width: `${width}%` }}
                            title={`Ride #${r.requisition_id}${r.who ? ` · ${r.who}` : ''} · ${hm(r.start)}–${hm(r.end)} · ${r.status}${r.leg === 'pickup' ? ' (pick-up)' : ''}`}
                          >
                            {hm(r.start)}–{hm(r.end)} {r.who}
                          </div>
                        </React.Fragment>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-amber-50 border border-amber-400" /> Booked</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-emerald-50 border border-emerald-500" /> On the road</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-slate-100 border border-slate-300" /> Done</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-orange-100" /> Gap kept free</span>
      </div>
    </div>
  );
};
