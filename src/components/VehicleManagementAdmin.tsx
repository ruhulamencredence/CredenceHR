/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Vehicle Management — HR/Admin side: vehicle inventory
// (add/edit), a read-only ride-request status board, assigning a vehicle +
// driver once a request has cleared the Approval Workflow, deciding
// time-extension requests, and clearing the "late return with no advance
// notice" flag with a manual note. Gated behind the 'vehicle_management'
// AdminModuleKey the same way every other Admin Panel tab is (Admin Panel ->
// Users -> Module Access).
//
// Approve/Reject itself is NOT done here — a ride request routes through the
// same Dynamic Approval Engine every other module uses (Admin Panel ->
// Approvals, or "My Approvals" for whoever the Template's Layer 1 names),
// configurable from Admin Panel -> Approvals -> Templates (request type
// "Vehicle Requisition", Layer 1 = "Supervisor Approval", Layer 2 =
// "HR/Admin Review"). See the design note above
// registerVehicleManagementRoutes in VehicleManagementRoutes.ts.
//
// Also has the flowchart's "জরুরি/HR Direct" initiator path ("Emergency
// Requisition" tab below) — HR/Admin manually files a request on someone
// else's behalf, optionally naming a specific Supervisor-Layer approver
// instead of relying on that employee's own auto-resolved Direct/Department
// Supervisor (POST /api/vehicles/requisitions/admin-create).

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';
import { User } from '../types';
import { LiveRideMap } from './LiveRideMap';
import { RideDetails } from './RideDetails';

import { SearchSelect } from './Combobox';
import { DriverOption, driverOptionLabel, sortDrivers } from '../lib/driverPicker';
import { VehicleDriversPanel } from './VehicleDriversPanel';
import { confirmDialog } from '../lib/confirmDialog';
import { DurationPicker } from './DurationPicker';
import { formatDuration } from '../lib/rideDuration';
interface VehicleManagementAdminProps {
  // Same `users` list AdminPanel already fetches for ApprovalTemplateManager
  // (GET /api/users, gated behind the 'users' module) — reused here purely
  // client-side for the Emergency Requisition tab's Employee/Supervisor
  // pickers, no extra fetch needed. Empty for an admin who only holds
  // 'vehicle_management' and not 'users' — same limitation
  // ApprovalTemplateManager's own approver picker already has.
  users: User[];
}

interface Vehicle {
  id: number;
  vehicle_no: string;
  model: string;
  vehicle_type: string | null;
  status: 'available' | 'on_ride' | 'maintenance';
}

interface Requisition {
  id: number;
  employee_name: string;
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  estimated_duration_hours: number;
  expected_return_at: string | null;
  status: 'pending' | 'approved' | 'assigned' | 'ongoing' | 'rejected' | 'cancelled' | 'completed' | 'expired';
  // Who the Approval Workflow is currently waiting on (comma-joined — ANY
  // ONE of them clears the step) — null once past 'pending', or for a
  // legacy requisition with no approval_requests row at all.
  pending_with: string | null;
  rejection_reason: string | null;
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
  driver_mobile: string | null;
  // Start Ride: set once an assigned ride is started.
  started_at: string | null;
  started_by_name: string | null;
  actual_return_at: string | null;
  returned_late: boolean | null;
  time_extension_status: 'none' | 'requested' | 'approved' | 'rejected';
  time_extension_note: string | null;
  hr_notice_flag: boolean;
  hr_manual_note: string | null;
  created_at: string;
}

// One ride request in this account's own approval queue.
interface MyRideApproval {
  id: number; // approval_requests.id
  final: boolean; // on the Template's last Layer — may approve and assign in one go
  bypass: boolean; // that Layer is "Vehicle Maintainer": assigning IS the approval
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const emptyEmergencyForm = () => ({
  employee_user_id: '',
  supervisor_user_id: '',
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: '',
  start_time: '',
  estimated_duration_hours: 1
});

export function VehicleManagementAdmin(_props: VehicleManagementAdminProps) {
  // Driver / Employee / Supervisor pickers. Fetched here from GET
  // /api/vehicles/driver-candidates (any logged-in account may call it)
  // instead of reusing the `users` prop, which comes from GET /api/users and
  // is empty for anyone without the 'users' module.
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [viewingMapFor, setViewingMapFor] = useState<number | null>(null);
  const [viewingDetailsFor, setViewingDetailsFor] = useState<number | null>(null);
  // Drivers for a ride: Inventory -> Drivers once it is in use (driverPicker.ts).
  const [driverOptions, setDriverOptions] = useState<DriverOption[]>([]);
  const loadDriverOptions = () =>
    fetch(apiUrl('/api/vehicles/driver-picker'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setDriverOptions(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  useEffect(() => {
    fetch(apiUrl('/api/vehicles/driver-candidates'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setPeople(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    void loadDriverOptions();
  }, []);

  const [tab, setTab] = useState<'requests' | 'emergency' | 'inventory'>('requests');
  // Inventory: Vehicles | Drivers (VehicleDriversPanel.tsx).
  const [inventoryView, setInventoryView] = useState<'vehicles' | 'drivers'>('vehicles');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newVehicle, setNewVehicle] = useState({ vehicle_no: '', model: '', vehicle_type: '' });

  const [assigningFor, setAssigningFor] = useState<number | null>(null);
  const [assignForm, setAssignForm] = useState({ vehicle_id: '', driver_user_id: '' });

  const [noticeFor, setNoticeFor] = useState<number | null>(null);
  const [noticeNote, setNoticeNote] = useState('');

  const [emergencyForm, setEmergencyForm] = useState(emptyEmergencyForm());
  const [emergencySubmitting, setEmergencySubmitting] = useState(false);
  const [emergencyMessage, setEmergencyMessage] = useState<string | null>(null);

  // Ride deadline rules (vehicle_ride_settings): a waiting request expires
  // grace_minutes after its start time; approvers are reminded
  // reminder_minutes before it. Only a Superadmin edits them.
  const [rideRules, setRideRules] = useState<{ grace_minutes: number; reminder_minutes: number; can_change: boolean } | null>(null);
  const [rideRulesDraft, setRideRulesDraft] = useState({ grace_minutes: '30', reminder_minutes: '60' });
  const [rideRulesMsg, setRideRulesMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(apiUrl('/api/vehicles/ride-settings'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setRideRules(d);
        setRideRulesDraft({ grace_minutes: String(d.grace_minutes), reminder_minutes: String(d.reminder_minutes) });
      })
      .catch(() => {});
  }, []);

  async function saveRideRules() {
    setRideRulesMsg(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/ride-settings'), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ grace_minutes: Number(rideRulesDraft.grace_minutes), reminder_minutes: Number(rideRulesDraft.reminder_minutes) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');
      setRideRules((prev) => (prev ? { ...prev, grace_minutes: data.grace_minutes, reminder_minutes: data.reminder_minutes } : prev));
      setRideRulesMsg('Saved.');
    } catch (err: any) {
      setRideRulesMsg(err.message);
    }
  }

  async function loadVehicles() {
    try {
      const res = await fetch(apiUrl('/api/vehicles'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load vehicles.');
      setVehicles(data);
    } catch (err: any) {
      setError(err.message);
    }
  }

// Live refresh: reload when a request changes (src/lib/liveRefresh.ts).
useLiveRefresh(() => loadRequisitions());
  async function loadRequisitions() {
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load ride requests.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    }
    void loadMyQueue();
  }

  // The ride requests waiting on THIS account's approval (its own queue,
  // GET /api/my-approvals) — those cards get Approve / Reject here, and on
  // the final Layer "Approve & assign vehicle" too. The server checks again
  // that the request is waiting on this account (performApprovalAction,
  // PUT .../approve-and-assign).
  const [myQueue, setMyQueue] = useState<Map<number, MyRideApproval>>(new Map());
  const [decideFor, setDecideFor] = useState<number | null>(null); // assign form open (Approve & assign)
  const [decideRemarks, setDecideRemarks] = useState<Record<number, string>>({});
  const [decideForm, setDecideForm] = useState({ vehicle_id: '', driver_user_id: '' });
  const [actingId, setActingId] = useState<number | null>(null);
  async function loadMyQueue() {
    try {
      const res = await fetch(apiUrl('/api/my-approvals'), { headers: authHeaders() });
      const data = await res.json();
      const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      setMyQueue(
        new Map(
          list
            .filter((i) => i.source_type === 'vehicle_requisition')
            .map((i) => [Number(i.source_id), { id: Number(i.id), final: Number(i.current_step) >= Number(i.total_steps), bypass: !!i.vehicle_maintainer_bypass }])
        )
      );
    } catch {
      setMyQueue(new Map());
    }
  }
  async function decide(r: Requisition, a: MyRideApproval, action: 'approved' | 'rejected') {
    const remarks = (decideRemarks[r.id] || '').trim();
    if (action === 'rejected') {
      if (!remarks) return setError('Write why in Remarks before rejecting.');
      if (!(await confirmDialog(`Reject ${r.employee_name}'s ride request (${r.pickup_location} → ${r.destination})?`, { tone: 'danger' }))) return;
    }
    setActingId(r.id);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/my-approvals/${a.id}/act`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action, remarks: remarks || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save your decision.');
      setDecideRemarks((m) => ({ ...m, [r.id]: '' }));
      await loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActingId(null);
    }
  }
  async function approveAndAssign(r: Requisition) {
    if (!decideForm.vehicle_id || !decideForm.driver_user_id) return setError('Pick a vehicle and a driver.');
    setActingId(r.id);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${r.id}/approve-and-assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          vehicle_id: Number(decideForm.vehicle_id),
          driver_user_id: Number(decideForm.driver_user_id),
          remarks: (decideRemarks[r.id] || '').trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not approve and assign this ride.');
      setDecideFor(null);
      setDecideForm({ vehicle_id: '', driver_user_id: '' });
      await loadRequisitions();
      loadVehicles();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActingId(null);
    }
  }

  useEffect(() => {
    loadVehicles();
    loadRequisitions();
  }, []);

  async function addVehicle(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles'), { method: 'POST', headers: authHeaders(), body: JSON.stringify(newVehicle) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add vehicle.');
      setNewVehicle({ vehicle_no: '', model: '', vehicle_type: '' });
      loadVehicles();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitEmergencyRequisition(e: React.FormEvent) {
    e.preventDefault();
    setEmergencySubmitting(true);
    setEmergencyMessage(null);
    try {
      if (!emergencyForm.employee_user_id) throw new Error('Pick who this ride is for.');
      const res = await fetch(apiUrl('/api/vehicles/requisitions/admin-create'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          ...emergencyForm,
          employee_user_id: Number(emergencyForm.employee_user_id),
          supervisor_user_id: emergencyForm.supervisor_user_id ? Number(emergencyForm.supervisor_user_id) : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit this requisition.');
      setEmergencyMessage('Requisition submitted successfully.');
      setEmergencyForm(emptyEmergencyForm());
      loadRequisitions();
    } catch (err: any) {
      setEmergencyMessage(err.message);
    } finally {
      setEmergencySubmitting(false);
    }
  }

  async function assign(id: number) {
    if (!assignForm.vehicle_id || !assignForm.driver_user_id) {
      setError('Pick a vehicle and a driver.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          vehicle_id: Number(assignForm.vehicle_id),
          driver_user_id: Number(assignForm.driver_user_id)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign a vehicle to this request.');
      setAssigningFor(null);
      setAssignForm({ vehicle_id: '', driver_user_id: '' });
      loadRequisitions();
      loadVehicles();
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Start Ride: an assigned ride becomes ongoing (live map + tracking on).
  async function startRide(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/start`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start this ride.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Calls off a ride that hasn't started: approved and still waiting for a
  // vehicle, or given a vehicle but never started (the vehicle is freed).
  async function cancelRide(r: Requisition) {
    const msg =
      r.status === 'assigned'
        ? `Cancel ride #${r.id}? The vehicle is freed for another booking, and the rider and driver are told.`
        : `Cancel ride request #${r.id}? It is approved but has no vehicle yet — the rider is told.`;
    if (!(await confirmDialog(msg, { tone: 'danger' }))) return;
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${r.id}/cancel`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not cancel this ride.');
      loadRequisitions();
      loadVehicles();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function decideExtension(id: number, decision: 'approved' | 'rejected') {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/extension-decision`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ decision })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not decide on this extension request.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function resolveNotice(id: number) {
    if (!noticeNote.trim()) {
      setError('Add a note before clearing this flag.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/resolve-notice`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ hr_manual_note: noticeNote })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not resolve this notice.');
      setNoticeFor(null);
      setNoticeNote('');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const availableVehicles = vehicles.filter((v) => v.status === 'available');
  const pendingCount = requisitions.filter((r) => r.status === 'pending').length;
  const awaitingAssignCount = requisitions.filter((r) => r.status === 'approved').length;
  const noticeCount = requisitions.filter((r) => r.hr_notice_flag).length;

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          [
            'requests',
            `Ride Requests${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}${
              awaitingAssignCount > 0 ? ` • ${awaitingAssignCount} to assign` : ''
            }${noticeCount > 0 ? ` • ${noticeCount} flagged` : ''}`
          ],
          ['emergency', 'Emergency Requisition'],
          ['inventory', 'Vehicle Inventory']
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-3 rounded bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}

      {tab === 'requests' && (
        <div className="space-y-3">
          <div className="rounded bg-blue-50 text-blue-800 text-xs px-3 py-2">
            A request waiting on <b>you</b> has Approve / Reject right on its card (on the last Layer also "Approve &amp; assign
            vehicle", which confirms the ride at once); everyone else's are status only. Once a request is Approved, Assign Vehicle
            &amp; Driver. Who approves each Layer is set in Admin Panel → Approvals → Templates (request type "Vehicle Requisition").
          </div>
          {rideRules && (
            <div className="border rounded-lg p-3 flex flex-wrap items-end gap-3 text-xs text-gray-600">
              <div className="min-w-[220px] flex-1">
                <div className="font-semibold text-gray-800 text-sm">Ride deadline</div>
                A request still waiting on approval or a vehicle expires {rideRules.grace_minutes} min after its start time; approvers and
                Vehicle Maintainers get a reminder {rideRules.reminder_minutes} min before it. A ride given a vehicle but never started is
                closed {rideRules.grace_minutes} min after its planned end, and the vehicle is freed.
              </div>
              {rideRules.can_change && (
                <>
                  <label>
                    <span className="block mb-0.5">Grace time (min)</span>
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={rideRulesDraft.grace_minutes}
                      onChange={(e) => setRideRulesDraft({ ...rideRulesDraft, grace_minutes: e.target.value })}
                      className="w-24 border rounded px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label>
                    <span className="block mb-0.5">Reminder before (min)</span>
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={rideRulesDraft.reminder_minutes}
                      onChange={(e) => setRideRulesDraft({ ...rideRulesDraft, reminder_minutes: e.target.value })}
                      className="w-24 border rounded px-2 py-1.5 text-sm"
                    />
                  </label>
                  <button type="button" onClick={saveRideRules} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
                    Save
                  </button>
                  {rideRulesMsg && <span className={rideRulesMsg === 'Saved.' ? 'text-emerald-600' : 'text-red-600'}>{rideRulesMsg}</span>}
                </>
              )}
            </div>
          )}
          {requisitions.length === 0 && <div className="text-sm text-gray-500">No ride requests yet.</div>}
          {requisitions.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-800">
                  {r.employee_name} — {r.pickup_location} → {r.destination}
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded bg-gray-100 text-gray-700">{r.status === 'assigned' ? 'assigned — not started' : r.status}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {r.ride_date} at {r.start_time} • Est. {formatDuration(r.estimated_duration_hours)}
              </div>
              <div className="text-sm text-gray-600 mt-2">{r.purpose}</div>

              {r.status === 'pending' && (
                <div className="text-xs text-amber-700 mt-1">
                  Waiting on: <span className="font-medium">{r.pending_with || 'no approver configured for this Layer'}</span>
                </div>
              )}

              {r.status === 'pending' && myQueue.get(r.id) && (() => {
                const a = myQueue.get(r.id)!;
                const busy = actingId === r.id;
                return (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                    <div className="text-xs font-semibold text-amber-900">Waiting on you{a.final ? ' — last approval' : ''}</div>
                    <textarea
                      value={decideRemarks[r.id] || ''}
                      onChange={(e) => setDecideRemarks((m) => ({ ...m, [r.id]: e.target.value }))}
                      rows={2}
                      maxLength={1000}
                      placeholder="Remarks (needed to reject)"
                      className="w-full border rounded px-2 py-1.5 text-xs bg-white"
                    />
                    {decideFor === r.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <SearchSelect
                          value={decideForm.vehicle_id}
                          onChange={(e) => setDecideForm({ ...decideForm, vehicle_id: e.target.value })}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          <option value="">Pick a vehicle…</option>
                          {availableVehicles.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.model} ({v.vehicle_no})
                            </option>
                          ))}
                        </SearchSelect>
                        <SearchSelect
                          value={decideForm.driver_user_id}
                          onChange={(e) => setDecideForm({ ...decideForm, driver_user_id: e.target.value })}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          <option value="">Pick a driver…</option>
                          {sortDrivers(driverOptions, decideForm.vehicle_id).map((d) => (
                            <option key={d.id} value={d.id}>
                              {driverOptionLabel(d, decideForm.vehicle_id)}
                            </option>
                          ))}
                        </SearchSelect>
                        <button
                          onClick={() => void approveAndAssign(r)}
                          disabled={busy}
                          className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {busy ? 'Saving…' : a.bypass ? 'Assign & confirm ride' : 'Approve & confirm ride'}
                        </button>
                        <button onClick={() => setDecideFor(null)} className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 bg-white">
                          Back
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {a.final && (
                          <button
                            onClick={() => {
                              setDecideFor(r.id);
                              setDecideForm({ vehicle_id: '', driver_user_id: '' });
                            }}
                            disabled={busy}
                            className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {a.bypass ? 'Assign Vehicle & Driver' : 'Approve & assign vehicle'}
                          </button>
                        )}
                        {!a.bypass && (
                          <button
                            onClick={() => void decide(r, a, 'approved')}
                            disabled={busy}
                            className={`px-3 py-1.5 text-xs font-medium rounded disabled:opacity-50 ${a.final ? 'border border-green-600 text-green-700 bg-white hover:bg-green-50' : 'bg-green-600 text-white hover:bg-green-700'}`}
                          >
                            {busy ? 'Saving…' : a.final ? 'Approve only' : 'Approve'}
                          </button>
                        )}
                        <button
                          onClick={() => void decide(r, a, 'rejected')}
                          disabled={busy}
                          className="px-3 py-1.5 text-xs font-medium rounded border border-rose-300 text-rose-700 bg-white hover:bg-rose-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {(r.status === 'assigned' || r.status === 'ongoing' || r.status === 'completed') && r.vehicle_no && (
                <div className="mt-2 rounded bg-green-50 text-green-800 text-xs px-3 py-2 space-y-0.5">
                  <div>Vehicle: {r.vehicle_model} ({r.vehicle_no})</div>
                  <div>Driver: {r.driver_name} — {r.driver_mobile}</div>
                  {r.expected_return_at && <div>Expected back by: {new Date(r.expected_return_at).toLocaleString()}</div>}
                  {r.started_at && <div>Started: {new Date(r.started_at).toLocaleString()}{r.started_by_name ? ` by ${r.started_by_name}` : ''}</div>}
                  {r.status === 'assigned' && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <button
                        onClick={() => startRide(r.id)}
                        className="px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        Start Ride
                      </button>
                      <button
                        onClick={() => cancelRide(r)}
                        className="px-2.5 py-1 text-xs font-medium rounded border border-rose-300 text-rose-700 bg-white hover:bg-rose-50"
                      >
                        Cancel Ride
                      </button>
                    </div>
                  )}
                  {r.status === 'ongoing' && (
                    <button
                      onClick={() => setViewingMapFor(r.id)}
                      className="mt-1.5 px-2.5 py-1 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700"
                    >
                      View Live Map
                    </button>
                  )}
                </div>
              )}

              {r.status === 'rejected' && r.rejection_reason && (
                <div className="text-xs text-red-600 mt-2">Reason: {r.rejection_reason}</div>
              )}

              {r.status === 'completed' && (
                <div className={`text-xs mt-2 px-3 py-2 rounded ${r.returned_late ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-600'}`}>
                  {r.returned_late ? 'Returned late' : 'Returned on time'}
                  {r.actual_return_at ? ` — ${new Date(r.actual_return_at).toLocaleString()}` : ''}
                </div>
              )}

              {r.status === 'completed' && (
                <button
                  onClick={() => setViewingDetailsFor(r.id)}
                  className="mt-2 px-2.5 py-1 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700"
                >
                  View Ride Details & Map
                </button>
              )}

              {r.time_extension_status === 'requested' && (
                <div className="mt-2 rounded bg-amber-50 text-amber-800 text-xs px-3 py-2">
                  <div className="font-medium mb-1">Time extension requested{r.time_extension_note ? `: ${r.time_extension_note}` : ''}</div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => decideExtension(r.id, 'approved')}
                      className="px-2.5 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700"
                    >
                      Approve Extension
                    </button>
                    <button
                      onClick={() => decideExtension(r.id, 'rejected')}
                      className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                    >
                      Reject Extension
                    </button>
                  </div>
                </div>
              )}

              {r.hr_notice_flag && (
                <div className="mt-2 rounded bg-red-50 text-red-800 text-xs px-3 py-2">
                  <div className="font-medium mb-1">Late return — no advance notice from the requester.</div>
                  {noticeFor === r.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={noticeNote}
                        onChange={(e) => setNoticeNote(e.target.value)}
                        rows={2}
                        placeholder="Manual note for the record"
                        className="w-full border rounded px-2 py-1.5 text-xs"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => resolveNotice(r.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700"
                        >
                          Save Note &amp; Clear Flag
                        </button>
                        <button
                          onClick={() => setNoticeFor(null)}
                          className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setNoticeFor(r.id);
                        setNoticeNote('');
                      }}
                      className="px-2.5 py-1 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700"
                    >
                      Add Manual Note
                    </button>
                  )}
                </div>
              )}
              {!r.hr_notice_flag && r.hr_manual_note && (
                <div className="text-xs text-gray-500 mt-2">HR note: {r.hr_manual_note}</div>
              )}

              {r.status === 'approved' && (
                <div className="mt-3">
                  {assigningFor === r.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <SearchSelect
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
                      </SearchSelect>
                      <SearchSelect
                        value={assignForm.driver_user_id}
                        onChange={(e) => setAssignForm({ ...assignForm, driver_user_id: e.target.value })}
                        className="border rounded px-2 py-1 text-xs"
                      >
                        <option value="">Pick a driver…</option>
                        {sortDrivers(driverOptions, assignForm.vehicle_id).map((d) => (
                          <option key={d.id} value={d.id}>
                            {driverOptionLabel(d, assignForm.vehicle_id)}
                          </option>
                        ))}
                      </SearchSelect>
                      <button onClick={() => assign(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white">
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
                  {assigningFor !== r.id && (
                    <button
                      onClick={() => cancelRide(r)}
                      className="ml-2 px-3 py-1.5 text-xs font-medium rounded border border-rose-300 text-rose-700 hover:bg-rose-50"
                    >
                      Cancel Ride
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'emergency' && (
        <div className="space-y-4 max-w-xl">
          <div className="rounded bg-blue-50 text-blue-800 text-xs px-3 py-2">
            Flowchart's "জরুরি/HR Direct" path — file a ride request on someone else's behalf (an emergency, or they can't do it
            themselves). Optionally name a specific Supervisor-Layer approver instead of that employee's own auto-resolved
            Supervisor; the "HR/Admin Review" Layer after it works the same as any other request.
          </div>
          <form onSubmit={submitEmergencyRequisition} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Requesting For</label>
                <SearchSelect
                  required
                  value={emergencyForm.employee_user_id}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, employee_user_id: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  <option value="">Select an employee…</option>
                  {people.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </SearchSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Supervisor Approver <span className="text-gray-400 font-normal">(optional override)</span>
                </label>
                <SearchSelect
                  value={emergencyForm.supervisor_user_id}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, supervisor_user_id: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  <option value="">Use their own Supervisor (default)</option>
                  {people.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </SearchSelect>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Purpose</label>
              <textarea
                required
                value={emergencyForm.purpose}
                onChange={(e) => setEmergencyForm({ ...emergencyForm, purpose: e.target.value })}
                rows={2}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pickup Location</label>
                <input
                  required
                  value={emergencyForm.pickup_location}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, pickup_location: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
                <input
                  required
                  value={emergencyForm.destination}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, destination: e.target.value })}
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
                  min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}
                  value={emergencyForm.ride_date}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, ride_date: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                <input
                  required
                  type="time"
                  value={emergencyForm.start_time}
                  onChange={(e) => setEmergencyForm({ ...emergencyForm, start_time: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Est. Duration</label>
                <DurationPicker
                  value={emergencyForm.estimated_duration_hours}
                  onChange={(h) => setEmergencyForm({ ...emergencyForm, estimated_duration_hours: h })}
                  className="border rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            {emergencyMessage && <div className="text-sm text-gray-700">{emergencyMessage}</div>}
            <button
              type="submit"
              disabled={emergencySubmitting}
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {emergencySubmitting ? 'Submitting…' : 'Submit Requisition'}
            </button>
          </form>
        </div>
      )}

      {tab === 'inventory' && (
        <div className="inline-flex rounded-xl bg-slate-100 p-1 mb-4" role="tablist">
          {(['vehicles', 'drivers'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={inventoryView === k}
              onClick={() => setInventoryView(k)}
              className={`px-4 py-1.5 text-sm font-semibold rounded-lg ${inventoryView === k ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
            >
              {k === 'vehicles' ? `Vehicles (${vehicles.length})` : 'Drivers'}
            </button>
          ))}
        </div>
      )}
      {tab === 'inventory' && inventoryView === 'drivers' && <VehicleDriversPanel vehicles={vehicles} onChanged={() => void loadDriverOptions()} />}
      {tab === 'inventory' && inventoryView === 'vehicles' && (
        <div className="space-y-6">
          <form onSubmit={addVehicle} className="grid grid-cols-4 gap-3 items-end max-w-3xl">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Vehicle No.</label>
              <input
                required
                value={newVehicle.vehicle_no}
                onChange={(e) => setNewVehicle({ ...newVehicle, vehicle_no: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
              <input
                required
                value={newVehicle.model}
                onChange={(e) => setNewVehicle({ ...newVehicle, model: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Type</label>
              <input
                placeholder="Car, Microbus…"
                value={newVehicle.vehicle_type}
                onChange={(e) => setNewVehicle({ ...newVehicle, vehicle_type: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <button type="submit" className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white whitespace-nowrap">
              Add
            </button>
          </form>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="py-2">Vehicle No.</th>
                <th>Model</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="py-2">{v.vehicle_no}</td>
                  <td>{v.model}</td>
                  <td>{v.vehicle_type || '—'}</td>
                  <td>{v.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewingMapFor !== null && <LiveRideMap requisitionId={viewingMapFor} onClose={() => setViewingMapFor(null)} />}
      {viewingDetailsFor !== null && <RideDetails requisitionId={viewingDetailsFor} onClose={() => setViewingDetailsFor(null)} />}
    </div>
  );
}
