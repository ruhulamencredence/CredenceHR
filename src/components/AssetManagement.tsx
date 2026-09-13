/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Profile -> "Asset Management" — self-service tab for the logged-in
// account: what they currently hold (My Assets), requesting something new
// (New Requisition), and tracking where each request stands (Requisition
// Status). Talks to AssetManagementRoutes.ts (server.ts registers it via
// registerAssetManagementRoutes). Mirrors the read/write split and
// fetch-with-Bearer-token pattern already used throughout App.tsx.
//
// NOT wired into ProfilePage.tsx yet — that file wasn't part of this export.
// See CHANGES_asset_management.md for the exact snippet to drop into it.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

interface AssignedAsset {
  assignment_id: number;
  asset_id: number;
  asset_tag: string;
  name: string;
  category: string;
  serial_number: string | null;
  assigned_date: string;
  condition_on_assign: 'new' | 'good';
  acknowledged_at: string | null;
  return_requested_at: string | null;
}

interface Requisition {
  id: number;
  asset_category: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  target_date: string | null;
  status: 'pending' | 'manager_approved' | 'approved' | 'rejected' | 'dispatched' | 'fulfilled';
  manager_name: string | null;
  manager_remarks: string | null;
  rejection_reason: string | null;
  asset_name: string | null;
  asset_tag: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<Requisition['status'], string> = {
  pending: 'Pending (Line Manager)',
  manager_approved: 'Pending (IT/Admin)',
  approved: 'Approved — awaiting dispatch',
  rejected: 'Rejected',
  dispatched: 'Dispatched — please acknowledge',
  fulfilled: 'Fulfilled'
};

const STATUS_COLOR: Record<Requisition['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  manager_approved: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  dispatched: 'bg-blue-100 text-blue-800',
  fulfilled: 'bg-gray-100 text-gray-700'
};

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function AssetManagement() {
  const [tab, setTab] = useState<'my-assets' | 'requisition' | 'status'>('my-assets');
  const [myAssets, setMyAssets] = useState<AssignedAsset[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({ asset_category: '', reason: '', urgency: 'medium', target_date: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  async function loadMyAssets() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/assets/my'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load your assets.');
      setMyAssets(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadRequisitions() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/assets/requisitions/my'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load your requisitions.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'my-assets') loadMyAssets();
    if (tab === 'status') loadRequisitions();
  }, [tab]);

  async function acknowledge(assignmentId: number) {
    try {
      const res = await fetch(apiUrl(`/api/assets/assignments/${assignmentId}/acknowledge`), {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not acknowledge.');
      loadMyAssets();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function requestReturn(assignmentId: number) {
    try {
      const res = await fetch(apiUrl(`/api/assets/assignments/${assignmentId}/request-return`), {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit return request.');
      loadMyAssets();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const res = await fetch(apiUrl('/api/assets/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      setSubmitMessage('Request submitted successfully.');
      setForm({ asset_category: '', reason: '', urgency: 'medium', target_date: '' });
    } catch (err: any) {
      setSubmitMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          ['my-assets', 'My Assets'],
          ['requisition', 'New Requisition'],
          ['status', 'Requisition Status']
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

      {tab === 'my-assets' && (
        <div className="space-y-3">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && myAssets.length === 0 && (
            <div className="text-sm text-gray-500">You don't have any assets assigned right now.</div>
          )}
          {myAssets.map((a) => (
            <div key={a.assignment_id} className="border rounded-lg p-4 flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-800">{a.name}</div>
                <div className="text-xs text-gray-500">
                  Tag: {a.asset_tag} • Category: {a.category}
                  {a.serial_number ? ` • S/N: ${a.serial_number}` : ''}
                </div>
                <div className="text-xs text-gray-500">Handed over: {a.assigned_date} • Condition: {a.condition_on_assign}</div>
                {a.return_requested_at && <div className="text-xs text-amber-600 mt-1">Return requested — awaiting IT/Admin.</div>}
              </div>
              <div className="flex flex-col gap-2 items-end shrink-0">
                {!a.acknowledged_at ? (
                  <button
                    onClick={() => acknowledge(a.assignment_id)}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Accept &amp; Acknowledge
                  </button>
                ) : (
                  <span className="px-3 py-1.5 text-xs font-medium rounded bg-green-100 text-green-800">Acknowledged</span>
                )}
                {!a.return_requested_at && (
                  <button
                    onClick={() => requestReturn(a.assignment_id)}
                    className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    Request Return / Replace
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'requisition' && (
        <form onSubmit={submitRequisition} className="space-y-4 max-w-xl">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Asset Type</label>
            <input
              required
              value={form.asset_category}
              onChange={(e) => setForm({ ...form, asset_category: e.target.value })}
              placeholder="e.g. Laptop, Monitor, Headset"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason for Request</label>
            <textarea
              required
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={3}
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Urgency</label>
              <select
                value={form.urgency}
                onChange={(e) => setForm({ ...form, urgency: e.target.value })}
                className="w-full border rounded px-3 py-2 text-sm"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Date</label>
              <input
                type="date"
                value={form.target_date}
                onChange={(e) => setForm({ ...form, target_date: e.target.value })}
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
          {!loading && requisitions.length === 0 && <div className="text-sm text-gray-500">No requisitions yet.</div>}
          {requisitions.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-800">{r.asset_category}</div>
                <span className={`text-xs font-medium px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">Requested: {r.created_at} • Urgency: {r.urgency}</div>
              <div className="text-sm text-gray-600 mt-2">{r.reason}</div>
              {r.status === 'rejected' && r.rejection_reason && (
                <div className="text-xs text-red-600 mt-2">Reason: {r.rejection_reason}</div>
              )}
              {r.asset_name && (
                <div className="text-xs text-gray-500 mt-2">
                  Assigned item: {r.asset_name} ({r.asset_tag})
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
