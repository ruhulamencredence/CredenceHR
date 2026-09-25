/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Asset" — self-service tab for the logged-in account:
// what they currently hold (My Assets), requesting something new (New
// Requisition), and tracking where each request stands (Requisition
// Status). Talks to AssetManagementRoutes.ts (server.ts registers it via
// registerAssetManagementRoutes). Mirrors the read/write split and
// fetch-with-Bearer-token pattern already used throughout App.tsx.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

interface PendingClaim {
  id: number;
  issue_type: 'mismatch' | 'damaged' | 'missing' | 'other';
  description: string;
  status: 'pending' | 'resolved';
}

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
  pending_claim: PendingClaim | null;
}

const ISSUE_TYPE_LABEL: Record<PendingClaim['issue_type'], string> = {
  mismatch: 'Wrong item (doesn’t match requisition)',
  damaged: 'Damaged',
  missing: 'Missing part/accessory',
  other: 'Other'
};

// One line of a requisition — what's being asked for (item name), why
// (purpose), and how much (unit + quantity). "New Requisition" lets an
// Employee add as many of these as they need in a single submission
// instead of filing one request per item.
interface RequisitionItem {
  item_name: string;
  purpose: string;
  unit: string;
  quantity: number;
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
  items: RequisitionItem[];
  // Who the Approval Workflow is currently waiting on (comma-joined — ANY
  // ONE of them clears the step) — null once it's past 'pending'.
  pending_with: string | null;
}

const emptyItem = (): RequisitionItem => ({ item_name: '', purpose: '', unit: 'pcs', quantity: 1 });

const STATUS_LABEL: Record<Requisition['status'], string> = {
  pending: 'Pending Approval',
  manager_approved: 'Pending Approval',
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

interface AvailableAsset {
  id: number;
  asset_tag: string;
  name: string;
  category: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function AssetManagement() {
  const [tab, setTab] = useState<'my-assets' | 'requisition' | 'status' | 'fulfill'>('my-assets');
  const [myAssets, setMyAssets] = useState<AssignedAsset[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Approved by Me — Fulfill" — flowchart's "ইনভেন্টরির ইউজারকে মালামাল
  // প্রদান (Disburse)" step, reachable here (no Admin Panel/Module Access
  // needed) by whoever's own approval action was the one that cleared a
  // requisition's Approval Workflow. See GET
  // /api/assets/requisitions/awaiting-my-fulfillment.
  const [awaitingFulfillment, setAwaitingFulfillment] = useState<Requisition[]>([]);
  const [availableAssets, setAvailableAssets] = useState<AvailableAsset[]>([]);
  const [fulfillingFor, setFulfillingFor] = useState<number | null>(null);
  const [fulfillAssetId, setFulfillAssetId] = useState('');

  const [items, setItems] = useState<RequisitionItem[]>([emptyItem()]);
  const [meta, setMeta] = useState({ urgency: 'medium', target_date: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  // "Report Issue" — flowchart's "মালামাল কি ঠিক আছে? -> না (গরমিল/ড্যামেজ)"
  // branch: an inline form on the assignment being reported (assignmentId
  // null = no form open), instead of a separate modal.
  const [reportingFor, setReportingFor] = useState<number | null>(null);
  const [issueForm, setIssueForm] = useState<{ issue_type: PendingClaim['issue_type']; description: string }>({
    issue_type: 'mismatch',
    description: ''
  });
  const [reportingSubmitting, setReportingSubmitting] = useState(false);

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

  // silent = true skips the page-wide loading/error state — used for the
  // on-mount call below so the "Approved by Me" tab's count badge is
  // accurate the moment this screen opens (My Assets is the default tab),
  // instead of only refreshing once the person happens to click that tab —
  // without flashing a loading spinner over whichever tab they're actually
  // looking at.
  async function loadAwaitingFulfillment(silent = false) {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [reqRes, assetRes] = await Promise.all([
        fetch(apiUrl('/api/assets/requisitions/awaiting-my-fulfillment'), { headers: authHeaders() }),
        fetch(apiUrl('/api/assets/available'), { headers: authHeaders() })
      ]);
      const reqData = await reqRes.json();
      const assetData = await assetRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || 'Failed to load requests awaiting fulfillment.');
      if (!assetRes.ok) throw new Error(assetData.error || 'Failed to load available assets.');
      setAwaitingFulfillment(reqData);
      setAvailableAssets(assetData);
    } catch (err: any) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'my-assets') loadMyAssets();
    if (tab === 'status') loadRequisitions();
    if (tab === 'fulfill') loadAwaitingFulfillment();
  }, [tab]);

  // Runs once on mount, regardless of which tab is active, purely so the
  // "Approved by Me" tab shows its real count right away.
  useEffect(() => {
    loadAwaitingFulfillment(true);
  }, []);

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

  async function submitIssue(assignmentId: number) {
    if (!issueForm.description.trim()) {
      setError('Describe the issue.');
      return;
    }
    setReportingSubmitting(true);
    try {
      const res = await fetch(apiUrl(`/api/assets/assignments/${assignmentId}/report-issue`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(issueForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not report the issue.');
      setReportingFor(null);
      setIssueForm({ issue_type: 'mismatch', description: '' });
      loadMyAssets();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReportingSubmitting(false);
    }
  }

  function updateItem(index: number, patch: Partial<RequisitionItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      // Drop any fully-empty row (e.g. a trailing "+ Add Item" the person
      // never filled in) rather than failing the whole submission on it.
      const cleanItems = items
        .map((it) => ({ ...it, item_name: it.item_name.trim(), purpose: it.purpose.trim(), unit: it.unit.trim() }))
        .filter((it) => it.item_name || it.purpose);
      if (cleanItems.length === 0) throw new Error('Add at least one item.');
      for (const it of cleanItems) {
        if (!it.item_name) throw new Error('Every item needs a name.');
        if (!it.purpose) throw new Error('Every item needs a purpose.');
        if (!it.unit) throw new Error('Every item needs a unit.');
        if (!it.quantity || it.quantity <= 0) throw new Error('Every item needs a quantity greater than 0.');
      }

      const res = await fetch(apiUrl('/api/assets/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ items: cleanItems, ...meta })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      setSubmitMessage('Request submitted successfully.');
      setItems([emptyItem()]);
      setMeta({ urgency: 'medium', target_date: '' });
    } catch (err: any) {
      setSubmitMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function fulfillRequisition(id: number) {
    if (!fulfillAssetId) return;
    try {
      const res = await fetch(apiUrl(`/api/assets/requisitions/${id}/fulfill`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ asset_id: Number(fulfillAssetId) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not fulfill this request.');
      setFulfillingFor(null);
      setFulfillAssetId('');
      loadAwaitingFulfillment();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          ['my-assets', 'My Assets'],
          ['requisition', 'New Requisition'],
          ['status', 'Requisition Status'],
          ['fulfill', `Approved by Me${awaitingFulfillment.length > 0 ? ` (${awaitingFulfillment.length})` : ''}`]
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
            <div key={a.assignment_id} className="border rounded-lg p-4">
            <div className="flex items-start justify-between gap-3">
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
                {a.pending_claim ? (
                  <span className="px-3 py-1.5 text-xs font-medium rounded bg-amber-100 text-amber-800">
                    Issue Reported — Awaiting Resolution
                  </span>
                ) : !a.acknowledged_at ? (
                  <>
                    <button
                      onClick={() => acknowledge(a.assignment_id)}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Accept &amp; Acknowledge
                    </button>
                    <button
                      onClick={() => {
                        setReportingFor(reportingFor === a.assignment_id ? null : a.assignment_id);
                        setIssueForm({ issue_type: 'mismatch', description: '' });
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
                    >
                      Report Issue
                    </button>
                  </>
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

            {a.pending_claim && (
              <div className="mt-3 rounded bg-amber-50 text-amber-800 text-xs px-3 py-2">
                <span className="font-medium">{ISSUE_TYPE_LABEL[a.pending_claim.issue_type]}:</span> {a.pending_claim.description}
              </div>
            )}

            {reportingFor === a.assignment_id && (
              <div className="mt-3 border-t pt-3 space-y-2">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">What's wrong?</label>
                  <select
                    value={issueForm.issue_type}
                    onChange={(e) => setIssueForm((f) => ({ ...f, issue_type: e.target.value as PendingClaim['issue_type'] }))}
                    className="w-full border rounded px-2 py-1.5 text-sm"
                  >
                    {(Object.keys(ISSUE_TYPE_LABEL) as PendingClaim['issue_type'][]).map((k) => (
                      <option key={k} value={k}>
                        {ISSUE_TYPE_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Describe the issue</label>
                  <textarea
                    value={issueForm.description}
                    onChange={(e) => setIssueForm((f) => ({ ...f, description: e.target.value }))}
                    rows={2}
                    placeholder="e.g. Requested a laptop but received a monitor / screen is cracked"
                    className="w-full border rounded px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => submitIssue(a.assignment_id)}
                    disabled={reportingSubmitting}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {reportingSubmitting ? 'Submitting…' : 'Submit Report'}
                  </button>
                  <button
                    onClick={() => setReportingFor(null)}
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

      {tab === 'requisition' && (
        <form onSubmit={submitRequisition} className="space-y-4 max-w-3xl">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Items</label>
              <button
                type="button"
                onClick={addItem}
                className="text-xs font-medium text-blue-600 hover:text-blue-800"
              >
                + Add Item
              </button>
            </div>
            <div className="space-y-3">
              {items.map((it, idx) => (
                <div key={idx} className="border rounded-lg p-3">
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-12 sm:col-span-4">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Item Name</label>
                      <input
                        required
                        value={it.item_name}
                        onChange={(e) => updateItem(idx, { item_name: e.target.value })}
                        placeholder="e.g. Laptop, A4 Paper"
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="col-span-12 sm:col-span-4">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Purpose</label>
                      <input
                        required
                        value={it.purpose}
                        onChange={(e) => updateItem(idx, { purpose: e.target.value })}
                        placeholder="Why this item is needed"
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="col-span-6 sm:col-span-2">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Unit</label>
                      <input
                        required
                        value={it.unit}
                        onChange={(e) => updateItem(idx, { unit: e.target.value })}
                        placeholder="pcs, box, set"
                        list="asset-req-units"
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="col-span-5 sm:col-span-1">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Qty</label>
                      <input
                        required
                        type="number"
                        min={0.01}
                        step="any"
                        value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="col-span-1 flex items-end justify-end">
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          aria-label="Remove item"
                          className="w-7 h-7 rounded text-red-500 hover:bg-red-50 text-sm font-medium"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <datalist id="asset-req-units">
              <option value="pcs" />
              <option value="box" />
              <option value="set" />
              <option value="ream" />
              <option value="packet" />
              <option value="unit" />
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Urgency</label>
              <select
                value={meta.urgency}
                onChange={(e) => setMeta({ ...meta, urgency: e.target.value })}
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
                value={meta.target_date}
                onChange={(e) => setMeta({ ...meta, target_date: e.target.value })}
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
              {r.status === 'pending' && r.pending_with && (
                <div className="text-xs text-amber-700 mt-1">
                  Waiting on: <span className="font-medium">{r.pending_with}</span>
                </div>
              )}
              <div className="mt-2 space-y-1">
                {(r.items || []).map((it, idx) => (
                  <div key={idx} className="text-sm text-gray-600 flex items-baseline justify-between gap-2">
                    <span>
                      <span className="font-medium text-gray-800">{it.item_name}</span> — {it.purpose}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">
                      {it.quantity} {it.unit}
                    </span>
                  </div>
                ))}
              </div>
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

      {tab === 'fulfill' && (
        <div className="space-y-3">
          <div className="rounded bg-blue-50 text-blue-800 text-xs px-3 py-2">
            Requisitions you approved that are still waiting for a specific item to be handed over — no Asset Management Module
            Access needed.
          </div>
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && awaitingFulfillment.length === 0 && (
            <div className="text-sm text-gray-500">Nothing waiting on you right now.</div>
          )}
          {awaitingFulfillment.map((r) => {
            const requestedNames = (r.items || []).map((it) => it.item_name.toLowerCase());
            const matching = availableAssets.filter((a) => requestedNames.includes(a.category.toLowerCase()));
            const rest = availableAssets.filter((a) => !requestedNames.includes(a.category.toLowerCase()));
            return (
              <div key={r.id} className="border rounded-lg p-4">
                <div className="font-semibold text-gray-800">{r.asset_category}</div>
                <div className="mt-2 space-y-1">
                  {(r.items || []).map((it, idx) => (
                    <div key={idx} className="text-sm text-gray-600 flex items-baseline justify-between gap-2">
                      <span>
                        <span className="font-medium text-gray-800">{it.item_name}</span> — {it.purpose}
                      </span>
                      <span className="text-xs text-gray-500 shrink-0">
                        {it.quantity} {it.unit}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  {fulfillingFor === r.id ? (
                    <div className="flex items-center gap-2">
                      <select value={fulfillAssetId} onChange={(e) => setFulfillAssetId(e.target.value)} className="border rounded px-2 py-1 text-xs">
                        <option value="">Pick an item…</option>
                        {matching.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.asset_tag})
                          </option>
                        ))}
                        {rest.length > 0 && matching.length > 0 && <option disabled>──────────</option>}
                        {rest.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.asset_tag})
                          </option>
                        ))}
                      </select>
                      <button onClick={() => fulfillRequisition(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white">
                        Dispatch
                      </button>
                      <button
                        onClick={() => setFulfillingFor(null)}
                        className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setFulfillingFor(r.id);
                        setFulfillAssetId('');
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Fulfill / Hand Over
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}