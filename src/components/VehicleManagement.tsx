/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "Book a Ride" — self-service tab for the logged-in
// account: request a vehicle (Book a Ride) and track where each request
// stands (Ride Status), including reporting the ride complete and asking
// for a time extension if running late. Talks to VehicleManagementRoutes.ts
// (server.ts registers it via registerVehicleManagementRoutes). Mirrors the
// read/write split and fetch-with-Bearer-token pattern AssetManagement.tsx
// already uses.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';
import { LiveRideMap } from './LiveRideMap';
import { RideDestinationPicker, RidePlaces } from './RideDestinationPicker';

interface Requisition {
  id: number;
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  estimated_duration_hours: number;
  expected_return_at: string | null;
  status: 'pending' | 'approved' | 'ongoing' | 'rejected' | 'cancelled' | 'completed';
  // Who the Approval Workflow is currently waiting on (comma-joined — ANY
  // ONE of them clears the step) — null once past 'pending'.
  pending_with: string | null;
  decided_by_name: string | null;
  rejection_reason: string | null;
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
  driver_mobile: string | null;
  // Set only when the driver is a real employee account (see
  // VehicleManagementRoutes.ts's validateVehicleAssignment) — that's what
  // unlocks "View Live Map" (LiveRideMap needs Employee Tracking pings from
  // both this and employee_user_id).
  driver_user_id: number | null;
  actual_return_at: string | null;
  returned_late: boolean | null;
  time_extension_status: 'none' | 'requested' | 'approved' | 'rejected';
  time_extension_note: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<Requisition['status'], string> = {
  pending: 'Pending HR/Admin Review',
  approved: 'Approved — Awaiting Vehicle Assignment',
  ongoing: 'Vehicle Assigned — Ride Ongoing',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed'
};

const STATUS_COLOR: Record<Requisition['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-teal-100 text-teal-800',
  ongoing: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-700',
  completed: 'bg-blue-100 text-blue-800'
};

interface AvailableVehicle {
  id: number;
  vehicle_no: string;
  model: string;
  vehicle_type: string | null;
}

// A directory row this component actually needs for the Vehicle Maintainer's
// employee picker — only ones with a login account (user_id) can be booked
// for, since vehicle_requisitions.employee_user_id is a users.id FK. See
// GET /api/employee-directory (EmployeeDirectoryRoutes.ts) for the full shape.
interface DirectoryEmployee {
  id: number;
  name: string;
  designation: string | null;
  user_id: number | null;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyForm = () => ({
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: todayLocal(),
  start_time: '',
  estimated_duration_hours: 1
});

const emptyDirectBookForm = () => ({
  employee_user_id: '',
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: '',
  start_time: '',
  estimated_duration_hours: 1,
  vehicle_id: '',
  driver_user_id: ''
});

interface VehicleManagementProps {
  // The logged-in account — only used here to decide whether the "Direct
  // Book" tab (the Vehicle Maintainer bypass) shows at all. A Superadmin
  // implicitly has every module, same convention as requireModule server-side.
  user?: { role?: string; module_permissions?: string[] } | null;
}

export function VehicleManagement({ user }: VehicleManagementProps) {
  const isVehicleMaintainer = user?.role === 'superadmin' || !!(user?.module_permissions || []).includes('vehicle_maintainer');
  const [tab, setTab] = useState<'book' | 'status' | 'assign' | 'maintainer'>('book');
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState(emptyForm());
  // Book a Ride is two steps: pick where from/to (RideDestinationPicker),
  // then the rest of the form. null = still on step 1.
  const [places, setPlaces] = useState<RidePlaces | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const [extendingFor, setExtendingFor] = useState<number | null>(null);
  const [extendNote, setExtendNote] = useState('');

  // "Approved by Me — Assign Vehicle" — flowchart's "গাড়ি ও ড্রাইভার
  // অ্যাসাইনমেন্ট" step, reachable here (no Admin Panel/Module Access
  // needed) by whoever's own approval action was the one that cleared a
  // requisition's Approval Workflow. See GET
  // /api/vehicles/requisitions/awaiting-my-assignment.
  const [awaitingAssignment, setAwaitingAssignment] = useState<Requisition[]>([]);
  const [availableVehicles, setAvailableVehicles] = useState<AvailableVehicle[]>([]);
  const [assigningFor, setAssigningFor] = useState<number | null>(null);
  const [assignForm, setAssignForm] = useState({ vehicle_id: '', driver_user_id: '' });

  // Fetched once on mount (not gated behind any tab) — the "who is this ride
  // for" employee picker on the Vehicle Maintainer's Direct Book form (needs
  // a name/designation, so it stays sourced from the Employee Directory).
  const [directoryEmployees, setDirectoryEmployees] = useState<DirectoryEmployee[]>([]);
  useEffect(() => {
    fetch(apiUrl('/api/employee-directory'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setDirectoryEmployees((Array.isArray(rows) ? rows : []).filter((e: DirectoryEmployee) => e.user_id)))
      .catch(() => {});
  }, []);

  // Driver picker — every login account (see GET /api/vehicles/driver-
  // candidates), NOT the Employee Directory: a driver only ever needs to be
  // a real users.id (validateVehicleAssignment in VehicleManagementRoutes.ts),
  // and an account created straight as a login (e.g. bulk-created via POST
  // /api/users/bulk) is never linked to an all_employees row, so it would be
  // invisible in the Directory despite being a perfectly real driver account.
  const [driverCandidates, setDriverCandidates] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    fetch(apiUrl('/api/vehicles/driver-candidates'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setDriverCandidates(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  // Live Ride Map (see LiveRideMap.tsx) — the requisition id currently shown
  // in the modal, or null when closed. Available from "Ride Status" (the
  // requester's own ongoing ride) and the Maintainer tab's "Live Rides" list.
  const [viewingMapFor, setViewingMapFor] = useState<number | null>(null);

  // Vehicle Maintainer bypass (see VehicleManagementRoutes.ts's
  // POST .../direct-book and PUT .../:id/direct-assign) — books+confirms a
  // ride for any employee, or pushes an already-submitted one straight to
  // Assigned, skipping the Approval Workflow entirely.
  const [bypassCandidates, setBypassCandidates] = useState<Requisition[]>([]);
  const [ongoingRides, setOngoingRides] = useState<Requisition[]>([]);
  const [directBookMode, setDirectBookMode] = useState<'new' | 'existing' | 'live'>('new');
  const [directBookForm, setDirectBookForm] = useState(emptyDirectBookForm());
  const [directBookSubmitting, setDirectBookSubmitting] = useState(false);
  const [directBookMessage, setDirectBookMessage] = useState<string | null>(null);
  const [bypassingFor, setBypassingFor] = useState<number | null>(null);
  const [bypassForm, setBypassForm] = useState({ vehicle_id: '', driver_user_id: '' });

  async function loadMaintainerData() {
    setLoading(true);
    setError(null);
    try {
      const [candRes, ongoingRes, vehRes] = await Promise.all([
        fetch(apiUrl('/api/vehicles/requisitions/bypass-candidates'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/requisitions/ongoing'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/available'), { headers: authHeaders() })
      ]);
      const candData = await candRes.json();
      const ongoingData = await ongoingRes.json();
      const vehData = await vehRes.json();
      if (!candRes.ok) throw new Error(candData.error || 'Failed to load pending ride requests.');
      if (!ongoingRes.ok) throw new Error(ongoingData.error || 'Failed to load ongoing rides.');
      if (!vehRes.ok) throw new Error(vehData.error || 'Failed to load available vehicles.');
      setBypassCandidates(candData);
      setOngoingRides(ongoingData);
      setAvailableVehicles(vehData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitDirectBook(e: React.FormEvent) {
    e.preventDefault();
    setDirectBookSubmitting(true);
    setDirectBookMessage(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions/direct-book'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          ...directBookForm,
          employee_user_id: Number(directBookForm.employee_user_id),
          vehicle_id: Number(directBookForm.vehicle_id),
          driver_user_id: Number(directBookForm.driver_user_id)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not book this ride.');
      setDirectBookMessage('Ride booked and confirmed directly.');
      setDirectBookForm(emptyDirectBookForm());
      loadMaintainerData();
    } catch (err: any) {
      setDirectBookMessage(err.message);
    } finally {
      setDirectBookSubmitting(false);
    }
  }

  async function bypassAssign(id: number) {
    if (!bypassForm.vehicle_id || !bypassForm.driver_user_id) {
      setError('Pick a vehicle and a driver.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/direct-assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ vehicle_id: Number(bypassForm.vehicle_id), driver_user_id: Number(bypassForm.driver_user_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not confirm this ride.');
      setBypassingFor(null);
      setBypassForm({ vehicle_id: '', driver_user_id: '' });
      loadMaintainerData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadRequisitions() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load your ride requests.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // silent = true skips the page-wide loading/error state — used for the
  // on-mount call below so the "Approved by Me" tab's count badge is
  // accurate the moment this screen opens (Book a Ride is the default tab),
  // instead of only refreshing once the person happens to click that tab —
  // without flashing a loading spinner over whichever tab they're actually
  // looking at.
  async function loadAwaitingAssignment(silent = false) {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [reqRes, vehRes] = await Promise.all([
        fetch(apiUrl('/api/vehicles/requisitions/awaiting-my-assignment'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/available'), { headers: authHeaders() })
      ]);
      const reqData = await reqRes.json();
      const vehData = await vehRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || 'Failed to load requests awaiting assignment.');
      if (!vehRes.ok) throw new Error(vehData.error || 'Failed to load available vehicles.');
      setAwaitingAssignment(reqData);
      setAvailableVehicles(vehData);
    } catch (err: any) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'status') loadRequisitions();
    if (tab === 'assign') loadAwaitingAssignment();
    if (tab === 'maintainer') loadMaintainerData();
  }, [tab]);

  // Runs once on mount, regardless of which tab is active, purely so the
  // "Approved by Me" tab shows its real count right away.
  useEffect(() => {
    loadAwaitingAssignment(true);
  }, []);

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...form, ...places })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      setSubmitMessage('Ride request submitted successfully.');
      setForm(emptyForm());
      setPlaces(null);
    } catch (err: any) {
      setSubmitMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRequisition(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/cancel`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not cancel.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function completeRide(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/complete`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not mark the ride completed.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function requestExtension(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/request-extension`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ note: extendNote })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not request an extension.');
      setExtendingFor(null);
      setExtendNote('');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function assignVehicle(id: number) {
    if (!assignForm.vehicle_id || !assignForm.driver_user_id) {
      setError('Pick a vehicle and a driver.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ vehicle_id: Number(assignForm.vehicle_id), driver_user_id: Number(assignForm.driver_user_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign a vehicle to this request.');
      setAssigningFor(null);
      setAssignForm({ vehicle_id: '', driver_user_id: '' });
      loadAwaitingAssignment();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          ['book', 'Book a Ride'],
          ['status', 'Ride Status'],
          ['assign', `Approved by Me${awaitingAssignment.length > 0 ? ` (${awaitingAssignment.length})` : ''}`],
          ...(isVehicleMaintainer ? [['maintainer', 'Direct Book'] as const] : [])
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-3 rounded bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}

      {tab === 'book' && !places && (
        <>
          {submitMessage && <div className="mb-3 rounded bg-green-50 text-green-800 text-sm px-3 py-2 max-w-xl">{submitMessage}</div>}
          <RideDestinationPicker
            onDone={(picked) => {
              setPlaces(picked);
              setSubmitMessage(null);
            }}
          />
        </>
      )}

      {tab === 'book' && places && (
        <form onSubmit={submitRequisition} className="space-y-4 max-w-xl">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex items-start justify-between gap-3">
            <div className="min-w-0 text-sm space-y-1.5">
              <div className="flex items-center gap-2 text-slate-700">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-600 shrink-0" />
                <span className="truncate">{places.pickup_location}</span>
              </div>
              <div className="flex items-center gap-2 text-slate-900 font-medium">
                <span className="w-2.5 h-2.5 rounded-sm bg-red-500 shrink-0" />
                <span className="truncate">{places.destination}</span>
              </div>
            </div>
            <button type="button" onClick={() => setPlaces(null)} className="text-xs font-medium text-blue-600 hover:underline shrink-0">
              Change
            </button>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Purpose</label>
            <textarea
              required
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              rows={2}
              placeholder="Why do you need the ride?"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ride Date</label>
              <input
                required
                type="date"
                value={form.ride_date}
                onChange={(e) => setForm({ ...form, ride_date: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
              <input
                required
                type="time"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Est. Duration (hrs)</label>
              <input
                required
                type="number"
                min={0.5}
                step="0.5"
                value={form.estimated_duration_hours}
                onChange={(e) => setForm({ ...form, estimated_duration_hours: Number(e.target.value) })}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          {submitMessage && <div className="text-sm text-gray-700">{submitMessage}</div>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full sm:w-auto px-4 py-2.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit Request'}
          </button>
        </form>
      )}

      {tab === 'status' && (
        <div className="space-y-3">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && requisitions.length === 0 && <div className="text-sm text-gray-500">No ride requests yet.</div>}
          {requisitions.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-800">
                  {r.pickup_location} → {r.destination}
                </div>
                <span className={`text-xs font-medium px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {r.ride_date} at {r.start_time} • Est. {r.estimated_duration_hours} hr{r.estimated_duration_hours === 1 ? '' : 's'}
              </div>
              <div className="text-sm text-gray-600 mt-2">{r.purpose}</div>

              {r.status === 'pending' && r.pending_with && (
                <div className="text-xs text-amber-700 mt-1">
                  Waiting on: <span className="font-medium">{r.pending_with}</span>
                </div>
              )}

              {r.status === 'rejected' && r.rejection_reason && (
                <div className="text-xs text-red-600 mt-2">Reason: {r.rejection_reason}</div>
              )}

              {(r.status === 'ongoing' || r.status === 'completed') && r.vehicle_no && (
                <div className="mt-2 rounded bg-green-50 text-green-800 text-xs px-3 py-2 space-y-0.5">
                  <div>Vehicle: {r.vehicle_model} ({r.vehicle_no})</div>
                  <div>Driver: {r.driver_name} — {r.driver_mobile}</div>
                  {r.expected_return_at && <div>Expected back by: {new Date(r.expected_return_at).toLocaleString()}</div>}
                </div>
              )}

              {r.status === 'ongoing' && r.time_extension_status !== 'none' && (
                <div className="text-xs text-amber-700 mt-1">
                  Time extension {r.time_extension_status}
                  {r.time_extension_note ? `: ${r.time_extension_note}` : ''}
                </div>
              )}

              {r.status === 'completed' && (
                <div className={`text-xs mt-2 px-3 py-2 rounded ${r.returned_late ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-600'}`}>
                  {r.returned_late ? 'Returned late' : 'Returned on time'}
                  {r.actual_return_at ? ` — ${new Date(r.actual_return_at).toLocaleString()}` : ''}
                </div>
              )}

              {r.status === 'pending' && (
                <button
                  onClick={() => cancelRequisition(r.id)}
                  className="mt-3 px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                >
                  Cancel Request
                </button>
              )}

              {r.status === 'ongoing' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.driver_user_id && (
                    <button
                      onClick={() => setViewingMapFor(r.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700"
                    >
                      View Live Map
                    </button>
                  )}
                  <button
                    onClick={() => completeRide(r.id)}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Ride Completed / Vehicle Returned
                  </button>
                  {r.time_extension_status === 'none' && (
                    <button
                      onClick={() => {
                        setExtendingFor(extendingFor === r.id ? null : r.id);
                        setExtendNote('');
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
                    >
                      Running Late — Request Extension
                    </button>
                  )}
                </div>
              )}

              {extendingFor === r.id && (
                <div className="mt-3 border-t pt-3 space-y-2">
                  <textarea
                    value={extendNote}
                    onChange={(e) => setExtendNote(e.target.value)}
                    rows={2}
                    placeholder="Why will you be late / how much more time do you need?"
                    className="w-full border rounded px-2 py-1.5 text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => requestExtension(r.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700"
                    >
                      Submit
                    </button>
                    <button
                      onClick={() => setExtendingFor(null)}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'assign' && (
        <div className="space-y-3">
          <div className="rounded bg-blue-50 text-blue-800 text-xs px-3 py-2">
            Ride requests you approved that are still waiting for a vehicle + driver — the flowchart's own "গাড়ি ও ড্রাইভার
            অ্যাসাইনমেন্ট" step, no Vehicle Management Module Access needed.
          </div>
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && awaitingAssignment.length === 0 && (
            <div className="text-sm text-gray-500">Nothing waiting on you right now.</div>
          )}
          {awaitingAssignment.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="font-semibold text-gray-800">
                {r.pickup_location} → {r.destination}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {r.ride_date} at {r.start_time} • Est. {r.estimated_duration_hours} hr{r.estimated_duration_hours === 1 ? '' : 's'}
              </div>
              <div className="text-sm text-gray-600 mt-2">{r.purpose}</div>

              <div className="mt-3">
                {assigningFor === r.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={assignForm.vehicle_id}
                      onChange={(e) => setAssignForm({ ...assignForm, vehicle_id: e.target.value })}
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="">Pick a vehicle…</option>
                      {availableVehicles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.model} ({v.vehicle_no})
                        </option>
                      ))}
                    </select>
                    <select
                      value={assignForm.driver_user_id}
                      onChange={(e) => setAssignForm({ ...assignForm, driver_user_id: e.target.value })}
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="">Pick a driver…</option>
                      {driverCandidates.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => assignVehicle(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white">
                      Confirm Assignment
                    </button>
                    <button
                      onClick={() => setAssigningFor(null)}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setAssigningFor(r.id);
                      setAssignForm({ vehicle_id: '', driver_user_id: '' });
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Assign Vehicle &amp; Driver
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'maintainer' && isVehicleMaintainer && (
        <div className="space-y-4">
          <div className="rounded bg-purple-50 text-purple-800 text-xs px-3 py-2">
            Vehicle Maintainer bypass — books/confirms a ride without going through the Supervisor / HR-Admin
            Approval Workflow. Use "Book New" for a ride nobody has submitted yet, or "Bypass Existing" to push an
            already-submitted request straight to Assigned.
          </div>

          <div className="flex gap-1 border-b border-gray-100">
            {([
              ['new', 'Book New'],
              ['existing', `Bypass Existing${bypassCandidates.length > 0 ? ` (${bypassCandidates.length})` : ''}`],
              ['live', `Live Rides${ongoingRides.length > 0 ? ` (${ongoingRides.length})` : ''}`]
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setDirectBookMode(key)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  directBookMode === key ? 'border-purple-600 text-purple-600' : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {loading && <div className="text-sm text-gray-500">Loading…</div>}

          {directBookMode === 'new' && (
            <form onSubmit={submitDirectBook} className="space-y-3 max-w-xl">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Employee</label>
                <select
                  required
                  value={directBookForm.employee_user_id}
                  onChange={(e) => setDirectBookForm({ ...directBookForm, employee_user_id: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  <option value="">Select an employee…</option>
                  {directoryEmployees.map((e) => (
                    <option key={e.user_id} value={e.user_id as number}>
                      {e.name}{e.designation ? ` — ${e.designation}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Purpose</label>
                <textarea
                  required
                  value={directBookForm.purpose}
                  onChange={(e) => setDirectBookForm({ ...directBookForm, purpose: e.target.value })}
                  rows={2}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pickup Location</label>
                  <input
                    required
                    value={directBookForm.pickup_location}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, pickup_location: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
                  <input
                    required
                    value={directBookForm.destination}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, destination: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ride Date</label>
                  <input
                    required
                    type="date"
                    value={directBookForm.ride_date}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, ride_date: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                  <input
                    required
                    type="time"
                    value={directBookForm.start_time}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, start_time: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Est. Duration (hrs)</label>
                  <input
                    required
                    type="number"
                    min={0.5}
                    step="0.5"
                    value={directBookForm.estimated_duration_hours}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, estimated_duration_hours: Number(e.target.value) })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
                  <select
                    required
                    value={directBookForm.vehicle_id}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, vehicle_id: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="">Pick a vehicle…</option>
                    {availableVehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.model} ({v.vehicle_no})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Driver</label>
                  <select
                    required
                    value={directBookForm.driver_user_id}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, driver_user_id: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="">Pick a driver…</option>
                    {driverCandidates.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">Must be a login account — needed for the Live Ride Map's location tracking.</p>
                </div>
              </div>
              {directBookMessage && <div className="text-sm text-gray-700">{directBookMessage}</div>}
              <button
                type="submit"
                disabled={directBookSubmitting}
                className="px-4 py-2 text-sm font-medium rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {directBookSubmitting ? 'Booking…' : 'Book & Confirm Directly'}
              </button>
            </form>
          )}

          {directBookMode === 'existing' && (
            <div className="space-y-3">
              {!loading && bypassCandidates.length === 0 && (
                <div className="text-sm text-gray-500">Nothing pending or approved right now.</div>
              )}
              {bypassCandidates.map((r) => (
                <div key={r.id} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-gray-800">
                      {r.pickup_location} → {r.destination}
                    </div>
                    <span className={`text-xs font-medium px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {r.ride_date} at {r.start_time} • Est. {r.estimated_duration_hours} hr{r.estimated_duration_hours === 1 ? '' : 's'}
                  </div>
                  <div className="text-sm text-gray-600 mt-2">{r.purpose}</div>

                  <div className="mt-3">
                    {bypassingFor === r.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={bypassForm.vehicle_id}
                          onChange={(e) => setBypassForm({ ...bypassForm, vehicle_id: e.target.value })}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          <option value="">Pick a vehicle…</option>
                          {availableVehicles.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.model} ({v.vehicle_no})
                            </option>
                          ))}
                        </select>
                        <select
                          value={bypassForm.driver_user_id}
                          onChange={(e) => setBypassForm({ ...bypassForm, driver_user_id: e.target.value })}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          <option value="">Pick a driver…</option>
                          {driverCandidates.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <button onClick={() => bypassAssign(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white">
                          Confirm Directly
                        </button>
                        <button
                          onClick={() => setBypassingFor(null)}
                          className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setBypassingFor(r.id);
                          setBypassForm({ vehicle_id: '', driver_user_id: '' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700"
                      >
                        Bypass & Assign Vehicle
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {directBookMode === 'live' && (
            <div className="space-y-3">
              {!loading && ongoingRides.length === 0 && (
                <div className="text-sm text-gray-500">No rides ongoing right now.</div>
              )}
              {ongoingRides.map((r) => (
                <div key={r.id} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-gray-800">
                      {r.pickup_location} → {r.destination}
                    </div>
                    <span className={`text-xs font-medium px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Vehicle: {r.vehicle_model} ({r.vehicle_no}) • Driver: {r.driver_name}
                    {!r.driver_user_id && ' (no tracked account — live map unavailable)'}
                  </div>
                  <button
                    onClick={() => setViewingMapFor(r.id)}
                    disabled={!r.driver_user_id}
                    className="mt-3 px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40"
                  >
                    View Live Map
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {viewingMapFor != null && <LiveRideMap requisitionId={viewingMapFor} onClose={() => setViewingMapFor(null)} />}
    </div>
  );
}
