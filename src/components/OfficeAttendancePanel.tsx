/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Fingerprint, RefreshCw, LogIn, LogOut, AlertTriangle, Search, X, CheckCircle2, Settings, Plus, Pencil, Trash2 } from 'lucide-react';
import { OfficeAttendanceRow } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import { Spinner } from './Spinner';

interface OfficeAttendancePanelProps {
  token: string;
}

// Local to this file on purpose — this is just what GET /api/zk-devices
// (already existed) returns; no server/types.ts change needed to show it.
interface ZkDeviceStatus {
  id: number;
  name: string;
  ip_address: string;
  port: number;
  serial_number: string | null;
  is_active: number;
  last_synced_at: string | null;
  last_sync_status: string | null;
}

const emptyDeviceForm = { name: '', ip_address: '', port: '4370', serial_number: '', is_active: true };

function timeOnly(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Admin Panel -> Office Attendance. Raw ZKTeco biometric punches, pulled
// automatically off the office terminals every 15s during 08:00-11:00 &
// 17:59-20:00, plus one full pull at 15:00 & 02:00 (see zkSync.ts), and
// summarized here as one row per employee per day: first punch = Check In,
// last punch = Check Out. Separate from the project-based Remote Attendance
// module — this one has no GPS/project tied to it at all, it's just "were
// they in the office".
export const OfficeAttendancePanel: React.FC<OfficeAttendancePanelProps> = ({ token }) => {
  const [rows, setRows] = useState<OfficeAttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(todayDateOnlyString());
  const [toDate, setToDate] = useState(todayDateOnlyString());
  const [search, setSearch] = useState('');

  // Per-column filters shown in the table header row — separate from the
  // global name/department/designation search box above, and combined with
  // it (AND) so a user can e.g. type "sales" in the global box AND still
  // narrow to one Department + one Date from the loaded range.
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  // Per-device sync status — GET /api/zk-devices already existed (used by
  // the Admin Panel's device-registry screen); this just also reads it here
  // to show which devices are done vs still syncing.
  const [devices, setDevices] = useState<ZkDeviceStatus[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const syncStartRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single-device "Sync" (the small button on one device's badge), separate
  // from the all-devices "Sync Now" above. Only one device id is ever
  // in-flight at a time, tracked here with its own start timestamp so that
  // badge's "syncing…" state doesn't get confused with the others.
  const [singleSyncDeviceId, setSingleSyncDeviceId] = useState<number | null>(null);
  const singleSyncStartRef = useRef<number>(0);
  const anySyncing = syncing || singleSyncDeviceId !== null;

  // Device registry management (Add / Edit / Delete) — this is what the
  // "add one from ... -> Devices" hint below points at. Same GET
  // /api/zk-devices this panel already polled for sync-status badges is
  // reused as the list here; POST/PUT/DELETE drive the actual CRUD, so a
  // new terminal's IP no longer needs a manual SQL INSERT against
  // zk_devices.
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [deviceForm, setDeviceForm] = useState(emptyDeviceForm);
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [deviceFormOpen, setDeviceFormOpen] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const [deviceFormError, setDeviceFormError] = useState<string | null>(null);
  const [deletingDeviceId, setDeletingDeviceId] = useState<number | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/zk-devices'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return; // best-effort — don't block the page on this panel
      setDevices(await res.json());
    } catch {
      // best-effort — device panel just skips this tick on a network hiccup
    } finally {
      setDevicesLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(apiUrl(`/api/office-attendance?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load office attendance');
      }
      setRows(await res.json());
    } catch (err: any) {
      setError(err.message || 'Failed to load office attendance');
    } finally {
      setLoading(false);
    }
  }, [token, fromDate, toDate]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Client-side, since the whole date range is already loaded — filters by
  // employee name, department, or designation, matching any of the three so
  // typing "sales" finds both an employee named Sales-something and anyone
  // in the Sales department.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const eq = employeeFilter.trim().toLowerCase();
    const dept = departmentFilter.trim();
    return rows.filter(r => {
      if (q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.department || '').toLowerCase().includes(q) &&
        !(r.designation || '').toLowerCase().includes(q)
      ) return false;
      if (eq && !r.name.toLowerCase().includes(eq)) return false;
      if (dept && (r.department || '') !== dept) return false;
      if (dateFilter && r.attendance_date !== dateFilter) return false;
      return true;
    });
  }, [rows, search, employeeFilter, departmentFilter, dateFilter]);

  // Distinct Department / Date values from the currently loaded range, used
  // to populate the two column-filter dropdowns below. Kept in sync with
  // `rows`, not `filteredRows`, so choosing one filter doesn't shrink the
  // options offered by the others.
  const departmentOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.department).filter((d): d is string => !!d))).sort(),
    [rows]
  );
  const dateOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.attendance_date))).sort(),
    [rows]
  );

  const hasColumnFilters = !!(employeeFilter || departmentFilter || dateFilter);
  const clearColumnFilters = () => {
    setEmployeeFilter('');
    setDepartmentFilter('');
    setDateFilter('');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    syncStartRef.current = Date.now();

    // Devices sync in parallel on the backend now, and each one updates its
    // own zk_devices row (last_synced_at) the moment ITS pull finishes —
    // independently of the others. So polling GET /api/zk-devices while this
    // request is in flight shows live per-device "done" vs "still syncing"
    // status, even though the POST below only resolves once every device is
    // finished. No server change needed — this just reads what was already
    // there sooner and more often.
    pollRef.current = setInterval(fetchDevices, 1500);

    try {
      const res = await fetch(apiUrl('/api/zk-devices/sync-now'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Sync failed');
      }
      const results: { device: string; ok: boolean; count: number; error?: string }[] = await res.json();
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        setSyncMessage(`Synced ${results.length - failed.length}/${results.length} devices — ${failed.map(f => f.device).join(', ')} unreachable`);
      } else {
        setSyncMessage(`Synced ${results.length} device${results.length === 1 ? '' : 's'} successfully`);
      }
      await fetchRows();
      await fetchDevices();
    } catch (err: any) {
      setError(err.message || 'Sync failed');
    } finally {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setSyncing(false);
    }
  };

  // Pulls just ONE device — hits the new /api/zk-devices/:id/sync-now
  // (reuses the same syncZkDevice() the all-device sync calls per device),
  // so an admin who only cares about one terminal isn't stuck waiting on
  // every other device too.
  const handleSyncOneDevice = async (device: ZkDeviceStatus) => {
    setSingleSyncDeviceId(device.id);
    setSyncMessage(null);
    setError(null);
    singleSyncStartRef.current = Date.now();
    pollRef.current = setInterval(fetchDevices, 1500);

    try {
      const res = await fetch(apiUrl(`/api/zk-devices/${device.id}/sync-now`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Sync failed');
      if (result.ok) {
        setSyncMessage(`Synced ${device.name} successfully (${result.count} log${result.count === 1 ? '' : 's'})`);
      } else {
        setSyncMessage(`${device.name} sync failed — ${result.error || 'unreachable'}`);
      }
      await fetchRows();
      await fetchDevices();
    } catch (err: any) {
      setError(err.message || `Sync failed for ${device.name}`);
    } finally {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setSingleSyncDeviceId(null);
    }
  };

  const openAddDeviceForm = () => {
    setEditingDeviceId(null);
    setDeviceForm(emptyDeviceForm);
    setDeviceFormError(null);
    setDeviceFormOpen(true);
  };

  const openEditDeviceForm = (device: ZkDeviceStatus) => {
    setEditingDeviceId(device.id);
    setDeviceForm({
      name: device.name,
      ip_address: device.ip_address,
      port: String(device.port),
      serial_number: device.serial_number || '',
      is_active: !!device.is_active
    });
    setDeviceFormError(null);
    setDeviceFormOpen(true);
  };

  const closeDeviceForm = () => {
    setDeviceFormOpen(false);
    setDeviceFormError(null);
  };

  const handleSaveDevice = async () => {
    if (!deviceForm.name.trim() || !deviceForm.ip_address.trim()) {
      setDeviceFormError('Name and IP address are required.');
      return;
    }
    setDeviceSaving(true);
    setDeviceFormError(null);
    try {
      const body = {
        name: deviceForm.name.trim(),
        ip_address: deviceForm.ip_address.trim(),
        port: Number(deviceForm.port) || 4370,
        serial_number: deviceForm.serial_number.trim() || null,
        is_active: deviceForm.is_active
      };
      const res = await fetch(
        apiUrl(editingDeviceId ? `/api/zk-devices/${editingDeviceId}` : '/api/zk-devices'),
        {
          method: editingDeviceId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body)
        }
      );
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to save device');
      await fetchDevices();
      closeDeviceForm();
    } catch (err: any) {
      setDeviceFormError(err.message || 'Failed to save device');
    } finally {
      setDeviceSaving(false);
    }
  };

  const handleDeleteDevice = async (device: ZkDeviceStatus) => {
    if (!window.confirm(`Delete "${device.name}" (${device.ip_address})? Its already-synced punch history is deleted too. This cannot be undone.`)) return;
    setDeletingDeviceId(device.id);
    try {
      const res = await fetch(apiUrl(`/api/zk-devices/${device.id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to delete device');
      await fetchDevices();
    } catch (err: any) {
      setError(err.message || `Failed to delete ${device.name}`);
    } finally {
      setDeletingDeviceId(null);
    }
  };

  // Overall % across devices for the progress bar below — a device counts as
  // "done" once its last_synced_at moves past the moment this run started
  // (same signal already used per-badge above), so this stays in lockstep
  // with the individual device badges without any extra polling.
  const syncTotal = devices.length;
  const syncDone = devices.filter(d => {
    const ts = d.last_synced_at ? new Date(d.last_synced_at).getTime() : 0;
    return ts >= syncStartRef.current;
  }).length;
  const syncPct = syncTotal > 0 ? Math.round((syncDone / syncTotal) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Fingerprint className="w-5 h-5 text-emerald-600" /> Office Attendance
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {filteredRows.length} record{filteredRows.length === 1 ? '' : 's'}
            {(search.trim() || hasColumnFilters) && rows.length !== filteredRows.length ? ` of ${rows.length}` : ''} from the office biometric terminals
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDeviceModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <Settings className="w-3.5 h-3.5" /> Manage Devices
          </button>
          <button
            onClick={handleSyncNow}
            disabled={anySyncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {syncing ? <Spinner size={14} /> : <RefreshCw className="w-3.5 h-3.5" />} {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {syncing && syncTotal > 0 && (
        <div className="w-full">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
            <span>Syncing devices…</span>
            <span>{syncDone}/{syncTotal} ({syncPct}%)</span>
          </div>
          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${syncPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {devices.map(d => {
          const lastSyncTs = d.last_synced_at ? new Date(d.last_synced_at).getTime() : 0;
          const isThisDeviceSolo = singleSyncDeviceId === d.id;
          const isPendingThisRun =
            (syncing && lastSyncTs < syncStartRef.current) ||
            (isThisDeviceSolo && lastSyncTs < singleSyncStartRef.current);
          const isError = !isPendingThisRun && (d.last_sync_status || '').startsWith('error');
          const badgeClass = isPendingThisRun
            ? 'bg-amber-50 border-amber-200 text-amber-700'
            : isError
              ? 'bg-rose-50 border-rose-200 text-rose-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-700';
          return (
            <span key={d.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border ${badgeClass}`}>
              {isPendingThisRun ? <Spinner size={12} /> : isError ? <AlertTriangle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              <span className="font-medium">{d.name}</span>
              <span className="text-slate-400">
                {isPendingThisRun ? 'syncing…' : d.last_synced_at ? timeOnly(d.last_synced_at) : 'never synced'}
              </span>
              <button
                onClick={() => handleSyncOneDevice(d)}
                disabled={anySyncing}
                title={`Sync only ${d.name}`}
                className="ml-0.5 text-slate-400 hover:text-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-3 h-3 ${isThisDeviceSolo ? 'animate-spin' : ''}`} />
              </button>
            </span>
          );
        })}
        {!devicesLoading && devices.length === 0 && (
          <span className="text-xs text-slate-400">
            No devices registered yet —{' '}
            <button onClick={() => setShowDeviceModal(true)} className="text-emerald-600 hover:underline">
              add one from Manage Devices
            </button>.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
        <span className="text-xs font-medium text-emerald-700">Date range:</span>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
        <button
          onClick={fetchRows}
          className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
        >
          Apply
        </button>
        {loading && <span className="text-xs text-slate-400">Loading…</span>}
      </div>

      <div className="relative w-full sm:w-72">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, department, designation…"
          className="w-full text-sm border border-slate-200 rounded-lg pl-8 pr-8 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            title="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {syncMessage && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{syncMessage}</div>
      )}
      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          {/* Sticky under the app header (Navbar is sticky top-0 h-16 — see
              Navbar.tsx), same pattern as the User Management list (Admin
              Panel -> Users) — both rows of this thead stay pinned below the
              nav while the table body scrolls underneath. */}
          <thead className="sticky top-16 z-10 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Employee</th>
              <th className="text-left px-3 py-2 font-medium">Department</th>
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Check In</th>
              <th className="text-left px-3 py-2 font-medium">Check Out</th>
              <th className="text-left px-3 py-2 font-medium">Punches</th>
            </tr>
            <tr className="bg-white border-b border-slate-100">
              <th className="px-3 py-1.5">
                <input
                  type="text"
                  value={employeeFilter}
                  onChange={e => setEmployeeFilter(e.target.value)}
                  placeholder="Filter…"
                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-normal focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
              </th>
              <th className="px-3 py-1.5">
                <select
                  value={departmentFilter}
                  onChange={e => setDepartmentFilter(e.target.value)}
                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-normal focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <option value="">All</option>
                  {departmentOptions.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </th>
              <th className="px-3 py-1.5">
                <select
                  value={dateFilter}
                  onChange={e => setDateFilter(e.target.value)}
                  className="w-full text-xs border border-slate-200 rounded px-2 py-1 font-normal focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <option value="">All</option>
                  {dateOptions.map(d => <option key={d} value={d}>{formatDate(d)}</option>)}
                </select>
              </th>
              <th className="px-3 py-1.5" colSpan={2} />
              <th className="px-3 py-1.5">
                {hasColumnFilters && (
                  <button
                    onClick={clearColumnFilters}
                    className="text-[11px] text-emerald-600 hover:underline whitespace-nowrap"
                  >
                    Clear filters
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-400">
                  No punches in this range. Make sure employees have a Device PIN mapped
                  (Admin Panel -&gt; Employees) and the devices have synced at least once.
                </td>
              </tr>
            )}
            {!loading && rows.length > 0 && filteredRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-400">
                  No matches for the current filters.{' '}
                  <button
                    onClick={() => { setSearch(''); clearColumnFilters(); }}
                    className="text-emerald-600 hover:underline"
                  >
                    Clear all filters
                  </button>
                </td>
              </tr>
            )}
            {filteredRows.map((r, i) => (
              <tr key={`${r.employee_id}-${r.attendance_date}-${i}`} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                <td className="px-3 py-2 text-slate-500">{r.department || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{formatDate(r.attendance_date)}</td>
                <td className="px-3 py-2 text-emerald-700">
                  <span className="flex items-center gap-1"><LogIn className="w-3 h-3" /> {timeOnly(r.check_in_at)}</span>
                </td>
                <td className="px-3 py-2 text-slate-600">
                  <span className="flex items-center gap-1"><LogOut className="w-3 h-3" /> {timeOnly(r.check_out_at)}</span>
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {r.punch_count}
                  {r.punch_count % 2 !== 0 && (
                    <span className="ml-1.5 text-[10px] text-amber-600" title="Odd punch count — a check-in or check-out may be missing">⚠</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Manage Devices modal — the ZKTeco device registry (zk_devices),
          full CRUD from the interface instead of a manual SQL INSERT
          whenever a new terminal's IP needs registering. */}
      {showDeviceModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
              <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-emerald-600" /> Manage ZKTeco Devices
              </h3>
              <button
                onClick={() => { setShowDeviceModal(false); closeDeviceForm(); }}
                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-3">
              {!deviceFormOpen && (
                <button
                  onClick={openAddDeviceForm}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-dashed border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Device
                </button>
              )}

              {deviceFormOpen && (
                <div className="border border-emerald-200 bg-emerald-50/50 rounded-xl p-3.5 space-y-2.5">
                  <p className="text-xs font-semibold text-emerald-700">
                    {editingDeviceId ? 'Edit Device' : 'Add Device'}
                  </p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="col-span-2">
                      <label className="text-[11px] text-slate-500">Device Name</label>
                      <input
                        type="text"
                        value={deviceForm.name}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="e.g. Device 2 — Main Gate"
                        className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500">IP Address</label>
                      <input
                        type="text"
                        value={deviceForm.ip_address}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, ip_address: e.target.value }))}
                        placeholder="192.168.1.201"
                        className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500">Port</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={deviceForm.port}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, port: e.target.value.replace(/\D/g, '') }))}
                        placeholder="4370"
                        className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[11px] text-slate-500">Serial Number (optional)</label>
                      <input
                        type="text"
                        value={deviceForm.serial_number}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, serial_number: e.target.value }))}
                        className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      />
                    </div>
                    <label className="col-span-2 flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={deviceForm.is_active}
                        onChange={(e) => setDeviceForm((f) => ({ ...f, is_active: e.target.checked }))}
                        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-400"
                      />
                      Active (included in Sync Now / the scheduled pulls)
                    </label>
                  </div>

                  {deviceFormError && (
                    <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">{deviceFormError}</p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handleSaveDevice}
                      disabled={deviceSaving}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {deviceSaving && <Spinner size={12} />} {editingDeviceId ? 'Save Changes' : 'Add Device'}
                    </button>
                    <button
                      onClick={closeDeviceForm}
                      disabled={deviceSaving}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {devicesLoading && <p className="text-xs text-slate-400">Loading devices…</p>}
                {!devicesLoading && devices.length === 0 && (
                  <p className="text-xs text-slate-400">No devices registered yet — add one above.</p>
                )}
                {devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 border border-slate-200 rounded-xl px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate flex items-center gap-1.5">
                        {d.name}
                        {!d.is_active && (
                          <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">Paused</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 truncate">{d.ip_address}:{d.port}{d.serial_number ? ` · SN: ${d.serial_number}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openEditDeviceForm(d)}
                        title="Edit"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-emerald-700"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteDevice(d)}
                        disabled={deletingDeviceId === d.id}
                        title="Delete"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                      >
                        {deletingDeviceId === d.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OfficeAttendancePanel;