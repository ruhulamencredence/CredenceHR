/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Vehicle Management -> Pick-ups and Drop & pick up report.
//   Pick-ups (layer "pickups"): every drop & pick up ride whose pick-up is
//     still to come or under way, soonest first — give it a car, change its
//     time. Server: GET /api/vehicles/pickups.
//   Report (layer "trip_report"): between two dates, how rides went — round
//     trips, drop & pick ups, cars let go mid-ride, empty runs, free car
//     time, late pick-ups — and per person. GET /api/vehicles/trip-report.
// Both explicit-only ticks (src/types.ts EXPLICIT_ONLY_LAYERS).

import { useCallback, useEffect, useState } from 'react';
import { FileDown, RefreshCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';
import { DriverOption } from '../lib/driverPicker';
import { TripRide, TripBadge, PickupAssignPopup, PickupTimePopup, clock, pickupWhenText } from './RideTrip';

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
const getJson = async (path: string) => {
  const res = await fetch(apiUrl(path), { headers: authHeaders() });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(d?.error || 'Could not load.');
  return d;
};

interface PickupRow extends TripRide {
  employee_name: string | null;
  person: { designation?: string | null; department?: string | null; employee_code?: string | null } | null;
}

const minsText = (m: number | null | undefined) => {
  if (m == null) return '—';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
};

export function VehiclePickups() {
  const [rows, setRows] = useState<PickupRow[] | null>(null);
  const [err, setErr] = useState('');
  const [pop, setPop] = useState<{ kind: 'assign' | 'time'; r: PickupRow } | null>(null);
  const [cars, setCars] = useState<{ vehicles: { id: number; vehicle_no: string; model?: string | null }[]; drivers: DriverOption[] }>({ vehicles: [], drivers: [] });
  const load = useCallback(async () => {
    try {
      setRows(await getJson('/api/vehicles/pickups'));
      setErr('');
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load());
  const openAssign = async (r: PickupRow) => {
    try {
      const [v, d] = await Promise.all([getJson('/api/vehicles/available'), getJson('/api/vehicles/driver-picker')]);
      setCars({ vehicles: Array.isArray(v) ? v : [], drivers: Array.isArray(d) ? d : [] });
      setPop({ kind: 'assign', r });
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const noCar = (rows || []).filter((r) => r.status === 'dropped' && !(r.pickup_mode === 'call' && !r.pickup_called_at)).length;
  const calls = (rows || []).filter((r) => r.pickup_mode === 'call' && !r.pickup_called_at).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm text-slate-800">Pick-ups to come</b>
        {noCar > 0 && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">{noCar} without a car</span>}
        {calls > 0 && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{calls} waiting for a call</span>}
        <button type="button" onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      {err && <div className="rounded-lg bg-rose-50 text-rose-700 text-sm px-3 py-2">{err}</div>}
      {rows === null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center">No pick-ups waiting. A drop &amp; pick up ride shows here once its passenger is dropped.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-[13px] min-w-[820px]">
            <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2.5 text-left">Pick up</th>
                <th className="px-3 py-2.5 text-left">Who · from</th>
                <th className="px-3 py-2.5 text-left">Car · driver</th>
                <th className="px-3 py-2.5 text-left">Trip</th>
                <th className="px-3 py-2.5 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const call = r.pickup_mode === 'call' && !r.pickup_called_at;
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <b>{call ? 'When called' : clock(r.pickup_called_at || r.pickup_at)}</b>
                      <div className="text-[11px] text-slate-500">{r.pickup_called_at ? 'asked "now"' : call ? '"I\'ll tell you"' : r.released_mid_ride ? 'car let go mid-ride' : 'set at booking'}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <b>{r.employee_name || '—'}</b>
                      <div className="text-[11px] text-slate-500">{[r.person?.designation, r.person?.department].filter(Boolean).join(' · ')}</div>
                      <div className="text-[11px] text-slate-600">
                        {r.pickup_from || r.destination} → {r.return_to || r.pickup_location}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {r.leg === 'pickup' ? (
                        <>
                          {r.vehicle_no}
                          <div className="text-[11px] text-slate-500">
                            {r.driver_name}
                            {r.status === 'ongoing' ? (r.picked_up_at ? ' · picked up' : ' · on the way') : ' · not set off'}
                          </div>
                        </>
                      ) : (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">No car yet</span>
                      )}
                      {r.drop_vehicle_no && <div className="text-[11px] text-slate-400 mt-0.5">Drop: {r.drop_vehicle_no}{r.drop_driver_name ? ` · ${r.drop_driver_name}` : ''}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <TripBadge r={r} />
                      {r.release_reason && <div className="text-[11px] text-pink-700 mt-0.5">“{r.release_reason}”</div>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1.5">
                      {r.status === 'dropped' && (
                        <button type="button" onClick={() => void openAssign(r)} className="text-xs font-semibold px-3 py-1.5 rounded-full text-white" style={{ background: 'var(--g-accent, #f26b1d)' }}>
                          Give a car
                        </button>
                      )}
                      {(r.status === 'dropped' || r.status === 'assigned') && (
                        <button type="button" onClick={() => setPop({ kind: 'time', r })} className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700">
                          Change time
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pop?.kind === 'assign' && <PickupAssignPopup r={pop.r} vehicles={cars.vehicles} drivers={cars.drivers} onClose={() => setPop(null)} onDone={() => { setPop(null); void load(); }} />}
      {pop?.kind === 'time' && <PickupTimePopup r={pop.r} onClose={() => setPop(null)} onDone={() => { setPop(null); void load(); }} />}
      <p className="text-[11px] text-slate-400">Pick-up times are Dhaka time. {rows?.length ? `${rows.length} in all · next: ${pickupWhenText(rows[0])}` : ''}</p>
    </div>
  );
}

interface ReportData {
  from: string;
  to: string;
  totals: {
    rides: number;
    round: number;
    dropPickup: number;
    oneWay: number;
    released: number;
    emptyRuns: number;
    freeMinutes: number;
    pickupLateAvg: number | null;
    notNeeded: number;
    calledNow: number;
    waitedMinutes: number;
  };
  people: {
    userId: number;
    name: string;
    rides: number;
    round: number;
    dropPickup: number;
    oneWay: number;
    released: number;
    calledNow: number;
    notNeeded: number;
    waitedMinutes: number;
    person: { designation?: string | null; department?: string | null; employee_code?: string | null } | null;
  }[];
}

const monthStart = () => {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  return `${d.slice(0, 8)}01`;
};

export function VehicleTripReport() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }));
  const [data, setData] = useState<ReportData | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    setData(null);
    getJson(`/api/vehicles/trip-report?from=${from}&to=${to}`)
      .then((d) => !off && (setData(d), setErr('')))
      .catch((e) => !off && setErr(e.message));
    return () => {
      off = true;
    };
  }, [from, to]);
  const exportExcel = async () => {
    if (!data) return;
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.json_to_sheet(
      data.people.map((p) => ({
        Person: p.name,
        'Employee ID': p.person?.employee_code || '',
        Designation: p.person?.designation || '',
        Department: p.person?.department || '',
        Rides: p.rides,
        'Round trip': p.round,
        'Drop & pick up': p.dropPickup,
        'One way': p.oneWay,
        'Released mid-ride': p.released,
        '"Pick me up now"': p.calledNow,
        'Pick-up not needed': p.notNeeded,
        'Car waited (min)': p.waitedMinutes
      }))
    );
    ws['!cols'] = new Array(12).fill({ wch: 16 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'By person');
    void saveWorkbookCrossPlatform(wb, `Drop_and_pick_up_${data.from}_to_${data.to}.xlsx`);
  };
  const t = data?.totals;
  const tiles: [string, string][] = t
    ? [
        [String(t.rides), 'Rides'],
        [String(t.dropPickup), 'Drop & pick up'],
        [String(t.released), 'Released mid-ride'],
        [String(t.emptyRuns), 'Empty runs (car alone)'],
        [minsText(t.freeMinutes), 'Car free between drop & pick-up'],
        [t.pickupLateAvg == null ? '—' : minsText(t.pickupLateAvg), 'Pick-up late on average'],
        [String(t.calledNow), '"Pick me up now"'],
        [String(t.notNeeded), 'Pick-ups not needed'],
        [minsText(t.waitedMinutes), 'Car waited (round trips)']
      ]
    : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-0.5 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-0.5 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <button type="button" onClick={() => void exportExcel()} disabled={!data} className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 text-white font-medium disabled:opacity-50">
          <FileDown className="w-3.5 h-3.5" /> Export Excel
        </button>
      </div>
      {err && <div className="rounded-lg bg-rose-50 text-rose-700 text-sm px-3 py-2">{err}</div>}
      {!data && !err && <p className="text-sm text-slate-400">Loading…</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {tiles.map(([v, k]) => (
              <div key={k} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-lg font-bold tabular-nums text-slate-900">{v}</div>
                <div className="text-[11px] text-slate-500">{k}</div>
              </div>
            ))}
          </div>
          <div className="text-sm font-semibold text-slate-800 pt-1">By person <span className="text-xs font-normal text-slate-500">— who lets the car go and calls it back most</span></div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-[13px] min-w-[760px]">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2.5 text-left">Person</th>
                  <th className="px-3 py-2.5 text-left">Rides</th>
                  <th className="px-3 py-2.5 text-left">Drop &amp; pick up</th>
                  <th className="px-3 py-2.5 text-left">Released mid-ride</th>
                  <th className="px-3 py-2.5 text-left">"Pick me up now"</th>
                  <th className="px-3 py-2.5 text-left">Not needed</th>
                  <th className="px-3 py-2.5 text-left">Car waited</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {data.people.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-400">No rides in these dates.</td>
                  </tr>
                )}
                {data.people.map((p) => (
                  <tr key={p.userId}>
                    <td className="px-3 py-2.5">
                      <b>{p.name}</b>
                      <div className="text-[11px] text-slate-500">{[p.person?.employee_code, p.person?.designation, p.person?.department].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-2.5">{p.rides}</td>
                    <td className="px-3 py-2.5">{p.dropPickup}</td>
                    <td className="px-3 py-2.5">{p.released ? <span className="font-bold text-pink-700">{p.released}</span> : 0}</td>
                    <td className="px-3 py-2.5">{p.calledNow}</td>
                    <td className="px-3 py-2.5">{p.notNeeded}</td>
                    <td className="px-3 py-2.5">{minsText(p.waitedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            Rides by their ride date that got a car. Empty runs: the car going back alone after a drop, and coming out alone for a pick-up. Car waited: a round trip's start to return.
          </p>
        </>
      )}
    </div>
  );
}

