/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Vehicle Management — HR/Admin side: vehicle inventory
// (add/edit), reviewing ride requests (approve with vehicle+driver
// assignment, or reject), deciding time-extension requests, and clearing
// the "late return with no advance notice" flag with a manual note.
// Gated behind the 'vehicle_management' AdminModuleKey the same way every
// other Admin Panel tab is (Admin Panel -> Users -> Module Access).

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

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
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';
  rejection_reason: string | null;
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
  driver_mobile: string | null;
  actual_return_at: string | null;
  returned_late: boolean | null;
  time_extension_status: 'none' | 'requested' | 'approved' | 'rejected';
  time_extension_note: string | null;
  hr_notice_flag: boolean;
  hr_manual_note: string | null;
  created_at: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function VehicleManagementAdmin() {
  const [tab, setTab] = useState<'requests' | 'inventory'>('requests');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newVehicle, setNewVehicle] = useState({ vehicle_no: '', model: '', vehicle_type: '' });

  const [approvingFor, setApprovingFor] = useState<number | null>(null);
  const [approveForm, setApproveForm] = useState({ vehicle_id: '', driver_name: '', driver_mobile: '' });

  const [rejectingFor, setRejectingFor] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [noticeFor, setNoticeFor] = useState<number | null>(null);
  const [noticeNote, setNoticeNote] = useState('');

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

  async function loadRequisitions() {
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load ride requests.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
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

  async function approve(id: number) {
    if (!approveForm.vehicle_id || !approveForm.driver_name.trim() || !approveForm.driver_mobile.trim()) {
      setError('Pick a vehicle and fill in the driver name & mobile number.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/approve`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ ...approveForm, vehicle_id: Number(approveForm.vehicle_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not approve this request.');
      setApprovingFor(null);
      setApproveForm({ vehicle_id: '', driver_name: '', driver_mobile: '' });
      loadRequisitions();
      loadVehicles();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function reject(id: number) {
    if (!rejectReason.trim()) {
      setError('Add a reason for rejecting this request.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/reject`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ rejection_reason: rejectReason })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reject this request.');
      setRejectingFor(null);
      setRejectReason('');
      loadRequisitions();
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
  const noticeCount = requisitions.filter((r) => r.hr_notice_flag).length;

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          ['requests', `Ride Requests${pendingCount > 0 ? ` (${pendingCount})` : ''}${noticeCount > 0 ? ` • ${noticeCount} flagged` : ''}`],
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
          {requisitions.length === 0 && <div className="text-sm text-gray-500">No ride requests yet.</div>}
          {requisitions.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-800">
                  {r.employee_name} — {r.pickup_location} → {r.destination}
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded bg-gray-100 text-gray-700">{r.status}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {r.ride_date} at {r.start_time} • Est. {r.estimated_duration_hours} hr{r.estimated_duration_hours === 1 ? '' : 's'}
              </div>
              <div className="text-sm text-gray-600 mt-2">{r.purpose}</div>

              {r.status === 'approved' && (
                <div className="mt-2 rounded bg-green-50 text-green-800 text-xs px-3 py-2 space-y-0.5">
                  <div>Vehicle: {r.vehicle_model} ({r.vehicle_no})</div>
                  <div>Driver: {r.driver_name} — {r.driver_mobile}</div>
                  {r.expected_return_at && <div>Expected back by: {new Date(r.expected_return_at).toLocaleString()}</div>}
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

              {r.status === 'pending' && (
                <div className="mt-3 space-y-2">
                  {approvingFor === r.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={approveForm.vehicle_id}
                        onChange={(e) => setApproveForm({ ...approveForm, vehicle_id: e.target.value })}
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
                        value={approveForm.driver_name}
                        onChange={(e) => setApproveForm({ ...approveForm, driver_name: e.target.value })}
                        className="border rounded px-2 py-1 text-xs"
                      />
                      <input
                        placeholder="Driver mobile"
                        value={approveForm.driver_mobile}
                        onChange={(e) => setApproveForm({ ...approveForm, driver_mobile: e.target.value })}
                        className="border rounded px-2 py-1 text-xs"
                      />
                      <button onClick={() => approve(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white">
                        Confirm Approval
                      </button>
                      <button
                        onClick={() => setApprovingFor(null)}
                        className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : rejectingFor === r.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        placeholder="Rejection reason"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="border rounded px-2 py-1 text-xs flex-1 min-w-[200px]"
                      />
                      <button onClick={() => reject(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white">
                        Confirm Rejection
                      </button>
                      <button
                        onClick={() => setRejectingFor(null)}
                        className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setApprovingFor(r.id);
                          setApproveForm({ vehicle_id: '', driver_name: '', driver_mobile: '' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        Approve — Assign Vehicle &amp; Driver
                      </button>
                      <button
                        onClick={() => {
                          setRejectingFor(r.id);
                          setRejectReason('');
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded border border-red-300 text-red-700 hover:bg-red-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'inventory' && (
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
    </div>
  );
}
