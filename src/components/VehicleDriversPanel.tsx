/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Vehicle Management -> Inventory -> Drivers (VehicleManagementRoutes.ts).
// Everyone with the module sees the list; adding, changing and removing a
// driver needs the "Manage drivers" layer (can_manage from the server, which
// checks it again on every change). A driver is always an Employee: name,
// ID, designation, department and mobile come from the Employee record —
// only the driving license and the usual vehicle are kept here.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Pencil, Trash2, X, UserRound } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';

interface Driver {
  id: number;
  employee_id: number;
  user_id: number | null;
  name: string;
  employee_code: string;
  designation: string;
  department: string;
  mobile: string;
  license_no: string;
  license_type: string;
  license_expiry: string | null;
  license_days_left: number | null;
  license_state: 'valid' | 'expiring' | 'expired' | 'unknown';
  usual_vehicle_id: number | null;
  usual_vehicle: string | null;
  is_active: boolean;
  note: string;
  now: 'free' | 'assigned' | 'on_ride';
}
interface EmployeeOption {
  id: number;
  name: string;
  employee_code: string;
  designation: string;
  department: string;
  mobile: string;
  has_login: boolean;
}
interface VehicleLite {
  id: number;
  vehicle_no: string;
  model: string;
}

const LICENSE_TYPES = ['Light', 'Medium', 'Heavy', 'Motorcycle', 'Professional'];
const headers = (): Record<string, string> => {
  try {
    return { Authorization: `Bearer ${localStorage.getItem('mpr_token') || ''}`, 'Content-Type': 'application/json' };
  } catch {
    return { 'Content-Type': 'application/json' };
  }
};
const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-') : '—');
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();

const nowPill = (d: Driver) =>
  !d.is_active
    ? { text: 'Inactive', cls: 'bg-slate-100 text-slate-600' }
    : d.license_state === 'expired'
      ? { text: 'License expired', cls: 'bg-rose-50 text-rose-700' }
      : d.now === 'on_ride'
        ? { text: 'On a ride', cls: 'bg-blue-50 text-blue-700' }
        : d.now === 'assigned'
          ? { text: 'Ride booked', cls: 'bg-indigo-50 text-indigo-700' }
          : { text: 'Available', cls: 'bg-emerald-50 text-emerald-700' };

export const VehicleDriversPanel: React.FC<{ vehicles: VehicleLite[]; onChanged?: () => void }> = ({ vehicles, onChanged }) => {
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'active' | 'inactive' | 'license'>('all');
  const [editing, setEditing] = useState<Driver | 'new' | null>(null);

  const load = () =>
    fetch(apiUrl('/api/vehicles/drivers'), { headers: headers() })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load drivers.');
        setDrivers(d.drivers || []);
        setCanManage(!!d.can_manage);
      })
      .catch((e) => {
        setError(e.message);
        setDrivers([]);
      });
  useEffect(() => {
    void load();
  }, []);

  const list = drivers || [];
  const stats = {
    active: list.filter((d) => d.is_active).length,
    onRide: list.filter((d) => d.is_active && d.now === 'on_ride').length,
    expiring: list.filter((d) => d.is_active && d.license_state === 'expiring').length,
    expired: list.filter((d) => d.is_active && d.license_state === 'expired').length
  };
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return list.filter((d) => {
      if (show === 'active' && !d.is_active) return false;
      if (show === 'inactive' && d.is_active) return false;
      if (show === 'license' && !(d.license_state === 'expired' || d.license_state === 'expiring')) return false;
      return !term || [d.name, d.employee_code, d.mobile, d.license_no, d.department, d.designation].some((t) => (t || '').toLowerCase().includes(term));
    });
  }, [list, q, show]);

  const remove = async (d: Driver) => {
    if (!(await confirmDialog(`Remove ${d.name} from Drivers? Rides already given keep them as the driver; they just can't be picked again.`, { tone: 'danger' }))) return;
    const r = await fetch(apiUrl(`/api/vehicles/drivers/${d.id}`), { method: 'DELETE', headers: headers() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return setError(data.error || 'Could not remove the driver.');
    await load();
    onChanged?.();
  };

  return (
    <div className="space-y-4">
      {error && <div className="rounded bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ['Active drivers', stats.active, ''],
          ['On a ride now', stats.onRide, ''],
          ['License ends in 30 days', stats.expiring, 'text-amber-600'],
          ['License expired', stats.expired, 'text-rose-600']
        ].map(([label, n, cls]) => (
          <div key={label as string} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <p className="text-[11px] text-slate-500">{label}</p>
            <p className={`text-lg font-bold ${cls}`}>{n as number}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, Employee ID, mobile, license no…"
            aria-label="Search drivers"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <select value={show} onChange={(e) => setShow(e.target.value as any)} aria-label="Show" className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white">
          <option value="all">All drivers</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="license">License ending / expired</option>
        </select>
        {canManage && (
          <button type="button" onClick={() => setEditing('new')} className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="w-4 h-4" /> Add Driver
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 bg-slate-50 border-b">
              <th className="px-4 py-2.5">Driver</th>
              <th className="px-4 py-2.5">Mobile</th>
              <th className="px-4 py-2.5">License</th>
              <th className="px-4 py-2.5">Usual vehicle</th>
              <th className="px-4 py-2.5">Now</th>
              {canManage && <th className="px-4 py-2.5 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {drivers === null ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  {list.length === 0
                    ? 'No drivers yet. Until one is added, any account can be picked as a ride’s driver.'
                    : 'No driver matches.'}
                </td>
              </tr>
            ) : (
              shown.map((d) => {
                const pill = nowPill(d);
                return (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center shrink-0">{initials(d.name)}</span>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-800 truncate">{d.name}</p>
                          <p className="text-[11px] text-slate-500 truncate">{[d.employee_code, d.designation, d.department].filter(Boolean).join(' · ')}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{d.mobile || '—'}</td>
                    <td className="px-4 py-2.5">
                      <p className="whitespace-nowrap">{[d.license_no, d.license_type].filter(Boolean).join(' · ') || '—'}</p>
                      <p
                        className={`text-[11px] whitespace-nowrap ${
                          d.license_state === 'expired' ? 'text-rose-600' : d.license_state === 'expiring' ? 'text-amber-600' : 'text-slate-500'
                        }`}
                      >
                        {d.license_expiry
                          ? d.license_state === 'expired'
                            ? `expired ${fmt(d.license_expiry)}`
                            : d.license_state === 'expiring'
                              ? `ends ${fmt(d.license_expiry)} · ${d.license_days_left} days`
                              : `valid till ${fmt(d.license_expiry)}`
                          : 'no expiry date'}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">{d.usual_vehicle || '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block text-[11px] font-semibold rounded-full px-2.5 py-0.5 whitespace-nowrap ${pill.cls}`}>{pill.text}</span>
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <button type="button" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`} className="p-1.5 rounded-lg text-slate-500 hover:text-blue-600 hover:bg-blue-50">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => remove(d)} aria-label={`Remove ${d.name}`} className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <DriverForm
          driver={editing === 'new' ? null : editing}
          vehicles={vehicles}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
};

const DriverForm: React.FC<{ driver: Driver | null; vehicles: VehicleLite[]; onClose: () => void; onSaved: () => void }> = ({ driver, vehicles, onClose, onSaved }) => {
  const [options, setOptions] = useState<EmployeeOption[] | null>(driver ? [] : null);
  const [employeeId, setEmployeeId] = useState('');
  const [form, setForm] = useState({
    license_no: driver?.license_no || '',
    license_type: driver?.license_type || '',
    license_expiry: driver?.license_expiry || '',
    usual_vehicle_id: driver?.usual_vehicle_id ? String(driver.usual_vehicle_id) : '',
    is_active: driver ? driver.is_active : true,
    note: driver?.note || ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (driver) return;
    fetch(apiUrl('/api/vehicles/drivers/employee-options'), { headers: headers() })
      .then((r) => r.json())
      .then((rows) => setOptions(Array.isArray(rows) ? rows : []))
      .catch(() => setOptions([]));
  }, [driver]);
  const picked = options?.find((o) => String(o.id) === employeeId) || null;

  const save = async () => {
    setError('');
    if (!driver && !employeeId) return setError('Pick an employee.');
    if (!driver && picked && !picked.has_login) return setError('This employee has no login, so their rides can’t be tracked. Give them a login first (Employees).');
    setBusy(true);
    try {
      const body = { ...form, usual_vehicle_id: form.usual_vehicle_id ? Number(form.usual_vehicle_id) : null, ...(driver ? {} : { employee_id: Number(employeeId) }) };
      const r = await fetch(apiUrl(driver ? `/api/vehicles/drivers/${driver.id}` : '/api/vehicles/drivers'), {
        method: driver ? 'PUT' : 'POST',
        headers: headers(),
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save.');
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full px-3 py-2 text-sm bg-white/90 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400';
  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={() => !busy && onClose()}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full">
          <X className="w-4 h-4" />
        </button>
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-lg font-bold text-slate-900">{driver ? 'Edit Driver' : 'Add Driver'}</h3>
          <p className="text-xs text-slate-500">Name, mobile and department come from the Employee record.</p>
        </div>
        <div className="px-6 py-2 space-y-3">
          {!driver ? (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Employee</label>
              <SearchSelect value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={input} aria-label="Employee">
                <option value="">— Select employee —</option>
                {(options || []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {[o.name, o.employee_code, o.designation, o.department].filter(Boolean).join(' · ')}
                    {o.has_login ? '' : ' — no login'}
                  </option>
                ))}
              </SearchSelect>
              {options === null && <p className="text-[11px] text-slate-400 mt-1">Loading employees…</p>}
            </div>
          ) : null}
          {(driver || picked) && (
            <div className="liquid-glass-inset rounded-2xl px-4 py-3 flex items-center gap-3">
              <span className="w-10 h-10 rounded-full bg-violet-100 text-violet-700 font-bold flex items-center justify-center shrink-0">
                <UserRound className="w-5 h-5" />
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-slate-900 truncate">
                  {(driver || picked)!.name} {((driver || picked) as any).employee_code ? `· ${((driver || picked) as any).employee_code}` : ''}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {[(driver || picked)!.designation, (driver || picked)!.department, (driver || picked)!.mobile].filter(Boolean).join(' · ')}
                  {picked && !picked.has_login ? ' · no login' : ''}
                </p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Driving License No.</label>
              <input value={form.license_no} onChange={(e) => setForm({ ...form, license_no: e.target.value })} className={input} maxLength={60} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">License type</label>
              <select value={form.license_type} onChange={(e) => setForm({ ...form, license_type: e.target.value })} className={input}>
                <option value="">—</option>
                {LICENSE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">License valid till</label>
              <input type="date" value={form.license_expiry} onChange={(e) => setForm({ ...form, license_expiry: e.target.value })} className={input} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Usual vehicle (optional)</label>
              <SearchSelect value={form.usual_vehicle_id} onChange={(e) => setForm({ ...form, usual_vehicle_id: e.target.value })} className={input} aria-label="Usual vehicle">
                <option value="">— None —</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.vehicle_no} — {v.model}
                  </option>
                ))}
              </SearchSelect>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Note (optional)</label>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={input} maxLength={255} />
          </div>
          {driver && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Active — can be given rides
            </label>
          )}
          {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
        </div>
        <div className="px-6 pb-6 pt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip px-4 py-2 text-sm font-semibold text-slate-700 rounded-full disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : driver ? 'Save' : 'Add Driver'}
          </button>
        </div>
      </div>
    </div>
  );
};
