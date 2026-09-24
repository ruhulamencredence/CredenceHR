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

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const emptyForm = () => ({
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: '',
  start_time: '',
  estimated_duration_hours: 1
});

export function VehicleManagement() {
  const [tab, setTab] = useState<'book' | 'status' | 'assign'>('book');
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState(emptyForm());
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
  const [assignForm, setAssignForm] = useState({ vehicle_id: '', driver_name: '', driver_mobile: '' });

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

  async function loadAwaitingAssignment() {
    setLoading(true);
    setError(null);
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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'status') loadRequisitions();
    if (tab === 'assign') loadAwaitingAssignment();
  }, [tab]);

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      setSubmitMessage('Ride request submitted successfully.');
      setForm(emptyForm());
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
    if (!assignForm.vehicle_id || !assignForm.driver_name.trim() || !assignForm.driver_mobile.trim()) {
      setError('Pick a vehicle and fill in the driver name & mobile number.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ ...assignForm, vehicle_id: Number(assignForm.vehicle_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign a vehicle to this request.');
      setAssigningFor(null);
      setAssignForm({ vehicle_id: '', driver_name: '', driver_mobile: '' });
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
          ['assign', `Approved by Me${awaitingAssignment.length > 0 ? ` (${awaitingAssignment.length})` : ''}`]
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

      {tab === 'book' && (
        <form onSubmit={submitRequisition} className="space-y-4 max-w-xl">
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pickup Location</label>
              <input
                required
                value={form.pickup_location}
                onChange={(e) => setForm({ ...form, pickup_location: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
              <input
                required
                value={form.destination}
                onChange={(e) => setForm({ ...form, destination: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
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
            className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
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
                    <input
                      placeholder="Driver name"
                      value={assignForm.driver_name}
                      onChange={(e) => setAssignForm({ ...assignForm, driver_name: e.target.value })}
                      className="border rounded px-2 py-1 text-xs"
                    />
                    <input
                      placeholder="Driver mobile"
                      value={assignForm.driver_mobile}
                      onChange={(e) => setAssignForm({ ...assignForm, driver_mobile: e.target.value })}
                      className="border rounded px-2 py-1 text-xs"
                    />
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
                      setAssignForm({ vehicle_id: '', driver_name: '', driver_mobile: '' });
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
    </div>
  );
}
