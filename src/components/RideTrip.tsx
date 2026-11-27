/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride -> Trip: Round trip (car waits) / Drop & pick up later / One
// way, the pieces every ride screen shares — the picker (booking form and
// the "Change trip" popup), the badge, the two legs, the passenger's and the
// driver's pick-up buttons, and the popups behind them. Server:
// VehicleManagementRoutes.ts ("Drop & pick up").

import React, { useState } from 'react';
import { X, Repeat, ArrowRight, Check } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { SearchSelect } from './Combobox';
import { DriverOption, driverOptionLabel, sortDrivers, driverBusy } from '../lib/driverPicker';
import { pickupTimeOf, slotClash, busyLabel, type SlotBooking } from '../lib/vehicleSlots';

export type TripType = 'round' | 'drop_pickup' | 'one_way';
export interface TripValue {
  trip_type: TripType;
  pickup_mode: 'time' | 'call';
  pickup_time: string;
  pickup_date?: string;
}
export const emptyTrip = (): TripValue => ({ trip_type: 'round', pickup_mode: 'time', pickup_time: '' });

// The ride fields these pieces read (a subset of the API's ride).
export interface TripRide {
  id: number;
  status: string;
  trip_type?: TripType;
  trip_type_asked?: TripType | null;
  trip_changed_by_name?: string | null;
  pickup_mode?: 'time' | 'call' | null;
  pickup_at?: string | null;
  pickup_from?: string | null;
  return_to?: string | null;
  leg?: 'pickup' | null;
  dropped_at?: string | null;
  drop_vehicle_no?: string | null;
  drop_vehicle_id?: number | null;
  drop_driver_user_id?: number | null;
  drop_driver_name?: string | null;
  released_mid_ride?: boolean;
  release_reason?: string | null;
  pickup_called_at?: string | null;
  pickup_started_at?: string | null;
  picked_up_at?: string | null;
  pickup_cancelled_at?: string | null;
  started_at?: string | null;
  vehicle_no?: string | null;
  driver_name?: string | null;
  destination?: string;
  pickup_location?: string;
  ride_date?: string;
  start_time?: string;
}

export const TRIP_OPTIONS: { key: TripType; title: string; sub: string }[] = [
  { key: 'round', title: 'Round trip — car waits', sub: 'The car stays with you and brings you back.' },
  { key: 'drop_pickup', title: 'Drop & pick up later', sub: 'The car drops you, goes back, and comes again for you.' },
  { key: 'one_way', title: 'One way', sub: 'Only the drop. You come back on your own.' }
];
export const tripTitle = (t?: string | null) => TRIP_OPTIONS.find((o) => o.key === t)?.title || TRIP_OPTIONS[0].title;
const SHORT: Record<TripType, string> = { round: 'Round trip', drop_pickup: 'Drop & pick up', one_way: 'One way' };

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
export async function rideCall(path: string, method: string, body?: any) {
  const res = await fetch(apiUrl(`/api/vehicles/requisitions${path}`), { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// "4:30 PM" (and the date when it isn't today), Dhaka time.
export const clock = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  return day === today ? t : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' })}, ${t}`;
};
export const pickupWhenText = (r: TripRide) => (r.pickup_mode === 'call' && !r.pickup_called_at ? 'when you call' : r.pickup_called_at ? `now (asked ${clock(r.pickup_called_at)})` : clock(r.pickup_at));
// HH:MM of a stored pick-up time, Dhaka, for an <input type="time">.
const hhmm = (v?: string | null) => (v ? new Date(new Date(v).getTime() + 6 * 3600e3).toISOString().slice(11, 16) : '');

export function TripBadge({ r }: { r: TripRide }) {
  const t = (r.trip_type || 'round') as TripType;
  if (t === 'round' && !r.released_mid_ride) return null;
  const cls = r.released_mid_ride ? 'bg-pink-50 text-pink-700 border-pink-200' : t === 'drop_pickup' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-bold ${cls}`}>
      {t === 'drop_pickup' ? <Repeat className="w-3 h-3" /> : <ArrowRight className="w-3 h-3" />}
      {r.released_mid_ride ? 'Released mid-ride' : SHORT[t]}
    </span>
  );
}

// Booking form / Change trip: the three choices and, for a drop & pick up,
// when to come back.
export function TripPicker({ value, onChange, rideDate }: { value: TripValue; onChange: (v: TripValue) => void; rideDate?: string }) {
  return (
    <div>
      <div className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Trip</div>
      <div className="space-y-1.5" role="radiogroup" aria-label="Trip">
        {TRIP_OPTIONS.map((o) => {
          const on = value.trip_type === o.key;
          return (
            <div key={o.key}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ ...value, trip_type: o.key })}
                className={`w-full flex items-start gap-2.5 rounded-2xl border-[1.5px] px-3 py-2.5 text-left transition-colors ${
                  on ? 'border-[color:var(--g-accent)] bg-[var(--g-accent-soft)]' : 'border-slate-200 bg-white/80 hover:bg-white'
                }`}
              >
                <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? 'border-[color:var(--g-accent)]' : 'border-slate-400'}`}>
                  {on && <span className="w-2 h-2 rounded-full bg-[var(--g-accent)]" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-slate-900">{o.title}</span>
                  <span className="block text-[11.5px] text-slate-500">{o.sub}</span>
                </span>
              </button>
              {on && o.key === 'drop_pickup' && (
                <div className="mt-1.5 ml-7 space-y-1.5">
                  <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-[12px] font-semibold">
                    {(
                      [
                        ['time', 'At a time'],
                        ['call', "I'll tell you"]
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => onChange({ ...value, pickup_mode: k })}
                        className={`flex-1 rounded-[10px] px-2 py-1.5 ${value.pickup_mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {value.pickup_mode === 'time' ? (
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="text-[11px] text-slate-500">
                        Pick-up time
                        <input
                          type="time"
                          required
                          value={value.pickup_time}
                          onChange={(e) => onChange({ ...value, pickup_time: e.target.value })}
                          className="mt-0.5 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900"
                        />
                      </label>
                      <label className="text-[11px] text-slate-500">
                        Day
                        <input
                          type="date"
                          min={rideDate}
                          value={value.pickup_date || rideDate || ''}
                          onChange={(e) => onChange({ ...value, pickup_date: e.target.value })}
                          className="mt-0.5 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900"
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="text-[11.5px] text-slate-500">Press "Pick me up now" in Ride Status when you're done — the car comes then.</p>
                  )}
                  <p className="text-[11px] text-slate-500">From your destination, back to where you started.</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The two legs of a drop & pick up.
export function TripLegs({ r }: { r: TripRide }) {
  if ((r.trip_type || 'round') !== 'drop_pickup') return null;
  const dropDone = !!r.dropped_at;
  const pickupOn = r.leg === 'pickup';
  const done = r.status === 'completed';
  const dot = (state: 'done' | 'now' | 'later', n: string) => (
    <span
      className={`w-5 h-5 rounded-full shrink-0 inline-flex items-center justify-center text-[10px] font-bold ${
        state === 'done' ? 'bg-emerald-600 text-white' : state === 'now' ? 'bg-[var(--g-accent)] text-white' : 'bg-slate-200 text-slate-500'
      }`}
    >
      {state === 'done' ? <Check className="w-3 h-3" /> : n}
    </span>
  );
  return (
    <div className="mt-2.5 rounded-2xl bg-slate-50/80 border border-slate-200/70 px-3 py-2.5 space-y-2 text-[12.5px]">
      <div className="flex gap-2">
        {dot(dropDone ? 'done' : 'now', '1')}
        <div className="min-w-0">
          <b className="text-slate-800">Drop</b>
          <span className="text-slate-500">
            {' '}
            · {r.drop_vehicle_no || (!pickupOn ? r.vehicle_no : '') || '—'}
            {r.drop_driver_name || (!pickupOn && r.driver_name) ? ` · ${r.drop_driver_name || r.driver_name}` : ''}
            {dropDone ? ` · dropped ${clock(r.dropped_at)}` : ''}
          </span>
          {r.released_mid_ride && r.release_reason && <div className="text-[11.5px] text-pink-700">Car let go: “{r.release_reason}”</div>}
        </div>
      </div>
      <div className="flex gap-2">
        {dot(done && !r.pickup_cancelled_at ? 'done' : dropDone ? 'now' : 'later', '2')}
        <div className="min-w-0">
          <b className="text-slate-800">Pick up</b>
          <span className="text-slate-500">
            {' '}
            · {r.pickup_cancelled_at ? 'not needed' : pickupWhenText(r)}
            {r.pickup_from ? ` · from ${r.pickup_from}` : ''}
          </span>
          {pickupOn && (
            <div className="text-[11.5px] text-slate-600">
              {r.vehicle_no || '—'}
              {r.driver_name ? ` · ${r.driver_name}` : ''}
              {r.picked_up_at ? ` · picked up ${clock(r.picked_up_at)}` : r.status === 'ongoing' ? ' · on the way' : ' · car given'}
            </div>
          )}
          {r.status === 'dropped' && <div className="text-[11.5px] text-amber-700">Waiting for a car to be given</div>}
        </div>
      </div>
    </div>
  );
}

// The house popup shell (liquid-glass, CLAUDE.md -> Popup style).
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useBackButtonClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[120] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4 max-sm:pt-[max(0.75rem,calc(var(--native-safe-area-inset-top,env(safe-area-inset-top,0px))_+_0.5rem))]" onClick={onClose}>
      <div className="w-full max-w-md max-h-full flex" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full p-5 overflow-y-auto">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-base font-bold text-slate-900">{title}</h3>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
const field = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900';
const primary = 'liquid-glass-button rounded-full px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50';

// Approver / Vehicle Management / the passenger: change the trip before the ride starts.
export function ChangeTripPopup({ r, onClose, onDone }: { r: TripRide; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<TripValue>({
    trip_type: (r.trip_type || 'round') as TripType,
    pickup_mode: (r.pickup_mode || 'time') as 'time' | 'call',
    pickup_time: hhmm(r.pickup_at),
    pickup_date: r.pickup_at ? new Date(new Date(r.pickup_at).getTime() + 6 * 3600e3).toISOString().slice(0, 10) : undefined
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rideDate = String(r.ride_date || '').slice(0, 10);
  return (
    <Sheet title={`Trip — ride #${r.id}`} onClose={onClose}>
      {r.trip_type_asked && r.trip_type_asked !== r.trip_type && <p className="mb-2 text-[11.5px] text-slate-500">Asked: {tripTitle(r.trip_type_asked)}</p>}
      <TripPicker value={v} onChange={setV} rideDate={rideDate} />
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
        <button
          type="button"
          disabled={busy || (v.trip_type === 'drop_pickup' && v.pickup_mode === 'time' && !v.pickup_time)}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await rideCall(`/${r.id}/trip`, 'PUT', { ...v, pickup_date: v.pickup_date || rideDate });
              onDone();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
          className={primary}
        >
          {busy ? 'Saving…' : 'Save trip'}
        </button>
      </div>
    </Sheet>
  );
}

// A round trip under way: let the car go (pick up later, or not at all).
export function ReleaseCarPopup({ r, onClose, onDone }: { r: TripRide; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'time' | 'call' | 'none'>('time');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Sheet title="Release the car" onClose={onClose}>
      <p className="text-[12.5px] text-slate-600 mb-3">The car goes back now and comes again for you — the ride becomes Drop &amp; pick up. Vehicle Management is told.</p>
      <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-[12px] font-semibold mb-2">
        {(
          [
            ['time', 'At a time'],
            ['call', "I'll tell you"],
            ['none', 'Not needed']
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`flex-1 rounded-[10px] px-2 py-1.5 ${mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'time' && (
        <label className="block text-[11px] text-slate-500 mb-2">
          Pick-up time (today)
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`mt-0.5 ${field}`} />
        </label>
      )}
      {mode === 'none' && <p className="text-[11.5px] text-slate-500 mb-2">You come back on your own — the ride closes now.</p>}
      <label className="block text-xs font-semibold text-slate-700 mb-1">Reason (required)</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="e.g. Meeting runs till evening" className={`${field} resize-none`} />
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
        <button
          type="button"
          disabled={busy || reason.trim().length < 3 || (mode === 'time' && !time)}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await rideCall(`/${r.id}/release`, 'POST', { mode, pickup_time: time, reason: reason.trim() });
              onDone();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
          className={primary}
        >
          {busy ? 'Saving…' : 'Release car'}
        </button>
      </div>
    </Sheet>
  );
}

// Change the pick-up time (or "I'll tell you").
export function PickupTimePopup({ r, onClose, onDone }: { r: TripRide; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'time' | 'call'>((r.pickup_mode as any) || 'time');
  const [time, setTime] = useState(hhmm(r.pickup_at));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Sheet title="Pick-up time" onClose={onClose}>
      <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-[12px] font-semibold mb-2">
        {(
          [
            ['time', 'At a time'],
            ['call', "I'll tell you"]
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`flex-1 rounded-[10px] px-2 py-1.5 ${mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'time' && <input type="time" aria-label="Pick-up time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />}
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
        <button
          type="button"
          disabled={busy || (mode === 'time' && !time)}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await rideCall(`/${r.id}/pickup-time`, 'PUT', { pickup_mode: mode, pickup_time: time });
              onDone();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
          className={primary}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  );
}

// Give the pick-up a car and driver — the drop's by default.
export function PickupAssignPopup({
  r,
  vehicles,
  drivers,
  onClose,
  onDone
}: {
  r: TripRide;
  vehicles: { id: number; vehicle_no: string; model?: string | null; bookings?: SlotBooking[]; gap_minutes?: number }[];
  drivers: DriverOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  // The pick-up's own time (pickup_at, or now when called): cars and drivers booked then can't be picked.
  const t = pickupTimeOf({ id: r.id, pickup_at: (r as any).pickup_at });
  const clashOf = (v: { bookings?: SlotBooking[]; gap_minutes?: number }) => slotClash(v, t);
  const sameCar = vehicles.some((v) => v.id === r.drop_vehicle_id && !clashOf(v)) ? String(r.drop_vehicle_id) : '';
  const [vehicleId, setVehicleId] = useState(sameCar);
  const [driverId, setDriverId] = useState(r.drop_driver_user_id ? String(r.drop_driver_user_id) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Sheet title={`Pick-up car — ride #${r.id}`} onClose={onClose}>
      <p className="text-[12.5px] text-slate-600 mb-3">
        Pick up {pickupWhenText(r)} from {r.pickup_from || r.destination}, back to {r.return_to || r.pickup_location}.
        {r.drop_vehicle_no ? ` Dropped with ${r.drop_vehicle_no}${r.drop_driver_name ? ` (${r.drop_driver_name})` : ''}.` : ''}
      </p>
      <label className="block text-xs font-semibold text-slate-700 mb-1">Vehicle</label>
      <SearchSelect aria-label="Vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={field}>
        <option value="">— Select vehicle —</option>
        {[...vehicles]
          .sort((a, b) => Number(!!clashOf(a)) - Number(!!clashOf(b)))
          .map((v) => {
            const c = clashOf(v);
            return (
              <option key={v.id} value={String(v.id)} disabled={!!c}>
                {`${v.vehicle_no}${v.model ? ` — ${v.model}` : ''}${v.id === r.drop_vehicle_id ? ' · the drop car' : ''}${c ? ` — ${busyLabel(c, t)}` : ' — Free at this time'}`}
              </option>
            );
          })}
      </SearchSelect>
      {!sameCar && r.drop_vehicle_id && <p className="mt-1 text-[11px] text-amber-700">The drop car isn't free now — pick another.</p>}
      <label className="block text-xs font-semibold text-slate-700 mt-3 mb-1">Driver</label>
      <SearchSelect aria-label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} className={field}>
        <option value="">— Select driver —</option>
        {sortDrivers(drivers, vehicleId, t).map((d) => (
          <option key={d.id} value={String(d.id)} disabled={!!driverBusy(d, t)}>
            {driverOptionLabel(d, vehicleId, t)}
          </option>
        ))}
      </SearchSelect>
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
        <button
          type="button"
          disabled={busy || !vehicleId || !driverId}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await rideCall(`/${r.id}/pickup-assign`, 'PUT', { vehicle_id: Number(vehicleId), driver_user_id: Number(driverId) });
              onDone();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
          className={primary}
        >
          {busy ? 'Saving…' : 'Give car'}
        </button>
      </div>
    </Sheet>
  );
}

