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
//
// Page chrome (blue-tinted background, white rounded-2xl card, icon/title
// header, ModulePath + Back) mirrors LeaveApplication.tsx's design exactly,
// so "My Asset" feels like the same product as "Leave Application" instead
// of an older, plainer screen. Tabs use the same rounded-full segmented
// control as Leave Application's Review/Approved/Rejected tabs, and every
// list below uses the same bordered-rounded-xl card + pill status badge
// pattern as Leave Application's card list.

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, Package, Inbox, Clock, CheckCircle2, XCircle, AlertTriangle, X
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';

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

// Pill status badge — same shape/size as Leave Application's StatusBadge
// (rounded-full, 10px bold text, tinted bg + border + icon), just extended
// to cover a Requisition's extra in-between states.
const RequisitionStatusBadge: React.FC<{ status: Requisition['status'] }> = ({ status }) => {
  const theme: Record<Requisition['status'], string> = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    manager_approved: 'bg-amber-50 text-amber-700 border-amber-200',
    approved: 'bg-blue-50 text-blue-700 border-blue-200',
    rejected: 'bg-rose-50 text-rose-700 border-rose-200',
    dispatched: 'bg-blue-50 text-blue-700 border-blue-200',
    fulfilled: 'bg-emerald-50 text-emerald-700 border-emerald-200'
  };
  const Icon =
    status === 'rejected' ? XCircle :
    status === 'fulfilled' ? CheckCircle2 :
    status === 'approved' || status === 'dispatched' ? CheckCircle2 : Clock;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${theme[status]}`}>
      <Icon className="w-2.5 h-2.5" /> {STATUS_LABEL[status]}
    </span>
  );
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

type AssetTab = 'my-assets' | 'requisition' | 'status' | 'fulfill';

interface AssetManagementProps {
  onBack: () => void;
}

export function AssetManagement({ onBack }: AssetManagementProps) {
  const [tab, setTab] = useState<AssetTab>('my-assets');
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

  const TABS: { key: AssetTab; label: string; count?: number }[] = [
    { key: 'my-assets', label: 'My Assets' },
    { key: 'requisition', label: 'New Requisition' },
    { key: 'status', label: 'Status' },
    { key: 'fulfill', label: 'Approved by Me', count: awaitingFulfillment.length }
  ];

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        <ModulePath path={['Self Service', 'My Asset']} />
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-100">
            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <Package className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900">My Asset</h1>
              <p className="text-xs text-slate-500">What you hold, what you've requested, and what's waiting on you.</p>
            </div>
          </div>

          {/* Segmented control — same rounded-full/bg-slate-100 pattern as
              Leave Application's Review/Approved/Rejected tabs. */}
          <div className="mx-4 mt-4 flex items-center gap-1.5 rounded-full bg-slate-100 p-1.5 text-xs font-semibold overflow-x-auto">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-full whitespace-nowrap transition-colors ${
                    active ? 'text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                  style={active ? { background: 'var(--g-accent)' } : undefined}
                >
                  {t.label}
                  {typeof t.count === 'number' && t.count > 0 && (
                    <span
                      className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                        active ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {t.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {error && (
            <div className="mx-4 mt-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5">
              {error}
            </div>
          )}

          <div className="p-4">
            {tab === 'my-assets' && (
              loading ? (
                <div className="flex justify-center py-14">
                  <Spinner size={20} className="text-slate-400" />
                </div>
              ) : myAssets.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 text-center py-10 text-slate-400">
                  <Inbox className="w-6 h-6 text-slate-300" />
                  <p className="text-xs font-semibold text-slate-500">You don't have any assets assigned right now.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {myAssets.map((a) => (
                    <div key={a.assignment_id} className="border border-slate-200 rounded-xl p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-bold text-slate-900">{a.name}</div>
                          <p className="text-[10px] uppercase tracking-wide text-slate-400 mt-1">
                            Tag: {a.asset_tag} • Category: {a.category}
                            {a.serial_number ? ` • S/N: ${a.serial_number}` : ''}
                          </p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Handed over: {a.assigned_date} • Condition: {a.condition_on_assign}
                          </p>
                          {a.return_requested_at && (
                            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
                              <Clock className="w-3 h-3" /> Return requested — awaiting IT/Admin.
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-2 items-end shrink-0">
                          {a.pending_claim ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                              <AlertTriangle className="w-2.5 h-2.5" /> Issue Reported
                            </span>
                          ) : !a.acknowledged_at ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                              <Clock className="w-2.5 h-2.5" /> Awaiting your Ack
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <CheckCircle2 className="w-2.5 h-2.5" /> Acknowledged
                            </span>
                          )}
                        </div>
                      </div>

                      {a.pending_claim && (
                        <div className="mt-2.5 pt-2.5 border-t border-slate-100 text-[11px] text-amber-700">
                          <span className="font-semibold">{ISSUE_TYPE_LABEL[a.pending_claim.issue_type]}:</span> {a.pending_claim.description}
                        </div>
                      )}

                      {!a.pending_claim && (
                        <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-2">
                          {!a.acknowledged_at && (
                            <>
                              <button
                                onClick={() => acknowledge(a.assignment_id)}
                                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg text-white transition-colors"
                                style={{ background: 'var(--g-accent)' }}
                              >
                                Accept &amp; Acknowledge
                              </button>
                              <button
                                onClick={() => {
                                  setReportingFor(reportingFor === a.assignment_id ? null : a.assignment_id);
                                  setIssueForm({ issue_type: 'mismatch', description: '' });
                                }}
                                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors"
                              >
                                Report Issue
                              </button>
                            </>
                          )}
                          {!a.return_requested_at && (
                            <button
                              onClick={() => requestReturn(a.assignment_id)}
                              className="px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                            >
                              Request Return / Replace
                            </button>
                          )}
                        </div>
                      )}

                      {reportingFor === a.assignment_id && (
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2.5">
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1">What's wrong?</label>
                            <select
                              value={issueForm.issue_type}
                              onChange={(e) => setIssueForm((f) => ({ ...f, issue_type: e.target.value as PendingClaim['issue_type'] }))}
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            >
                              {(Object.keys(ISSUE_TYPE_LABEL) as PendingClaim['issue_type'][]).map((k) => (
                                <option key={k} value={k}>
                                  {ISSUE_TYPE_LABEL[k]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1">Describe the issue</label>
                            <textarea
                              value={issueForm.description}
                              onChange={(e) => setIssueForm((f) => ({ ...f, description: e.target.value }))}
                              rows={2}
                              placeholder="e.g. Requested a laptop but received a monitor / screen is cracked"
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => submitIssue(a.assignment_id)}
                              disabled={reportingSubmitting}
                              className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                            >
                              {reportingSubmitting ? 'Submitting…' : 'Submit Report'}
                            </button>
                            <button
                              onClick={() => setReportingFor(null)}
                              className="px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === 'requisition' && (
              <form onSubmit={submitRequisition} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Items</label>
                    <button
                      type="button"
                      onClick={addItem}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                    >
                      + Add Item
                    </button>
                  </div>
                  <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                    {/* Column header — shown once, only where the grid
                        actually lays out side-by-side (sm+). Below that,
                        columns stack full-width, so each row keeps its own
                        compact label instead (see the sm:hidden labels
                        below). */}
                    <div className="hidden sm:grid grid-cols-12 gap-2.5 px-3.5 pt-3 pb-1.5">
                      <div className="col-span-4 text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Item Name</div>
                      <div className="col-span-4 text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Purpose</div>
                      <div className="col-span-2 text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Unit</div>
                      <div className="col-span-1 text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Qty</div>
                      <div className="col-span-1" />
                    </div>
                    {items.map((it, idx) => (
                      <div key={idx} className="p-3.5">
                        <div className="grid grid-cols-12 gap-2.5">
                          <div className="col-span-12 sm:col-span-4">
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1 sm:hidden">Item Name</label>
                            <input
                              required
                              value={it.item_name}
                              onChange={(e) => updateItem(idx, { item_name: e.target.value })}
                              placeholder="e.g. Laptop, A4 Paper"
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            />
                          </div>
                          <div className="col-span-12 sm:col-span-4">
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1 sm:hidden">Purpose</label>
                            <input
                              required
                              value={it.purpose}
                              onChange={(e) => updateItem(idx, { purpose: e.target.value })}
                              placeholder="Why this item is needed"
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            />
                          </div>
                          <div className="col-span-6 sm:col-span-2">
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1 sm:hidden">Unit</label>
                            <input
                              required
                              value={it.unit}
                              onChange={(e) => updateItem(idx, { unit: e.target.value })}
                              placeholder="pcs, box, set"
                              list="asset-req-units"
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            />
                          </div>
                          <div className="col-span-5 sm:col-span-1">
                            <label className="block text-[10px] uppercase tracking-wide text-slate-400 mb-1 sm:hidden">Qty</label>
                            <input
                              required
                              type="number"
                              min={0.01}
                              step="any"
                              value={it.quantity}
                              onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                            />
                          </div>
                          <div className="col-span-1 flex items-end justify-end">
                            {items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeItem(idx)}
                                aria-label="Remove item"
                                className="w-7 h-7 rounded-lg text-rose-500 hover:bg-rose-50 flex items-center justify-center transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
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
                    <label className="block text-[10px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Urgency</label>
                    <select
                      value={meta.urgency}
                      onChange={(e) => setMeta({ ...meta, urgency: e.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Target Date</label>
                    <input
                      type="date"
                      value={meta.target_date}
                      onChange={(e) => setMeta({ ...meta, target_date: e.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    />
                  </div>
                </div>
                {submitMessage && <div className="text-xs text-slate-600">{submitMessage}</div>}
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Submit Request'}
                </button>
              </form>
            )}

            {tab === 'status' && (
              loading ? (
                <div className="flex justify-center py-14">
                  <Spinner size={20} className="text-slate-400" />
                </div>
              ) : requisitions.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 text-center py-10 text-slate-400">
                  <Inbox className="w-6 h-6 text-slate-300" />
                  <p className="text-xs font-semibold text-slate-500">No requisitions yet.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {requisitions.map((r) => (
                    <div key={r.id} className="border border-slate-200 rounded-xl p-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-bold text-slate-900">{r.asset_category}</div>
                        <RequisitionStatusBadge status={r.status} />
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">Requested: {r.created_at} • Urgency: {r.urgency}</p>
                      {r.status === 'pending' && r.pending_with && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
                          <Clock className="w-3 h-3" /> Waiting on: <span className="font-semibold">{r.pending_with}</span>
                        </div>
                      )}
                      <div className="mt-2.5 pt-2.5 border-t border-slate-100 space-y-1">
                        {(r.items || []).map((it, idx) => (
                          <div key={idx} className="text-xs text-slate-600 flex items-baseline justify-between gap-2">
                            <span>
                              <span className="font-semibold text-slate-800">{it.item_name}</span> — {it.purpose}
                            </span>
                            <span className="text-[11px] text-slate-500 shrink-0">
                              {it.quantity} {it.unit}
                            </span>
                          </div>
                        ))}
                      </div>
                      {r.status === 'rejected' && r.rejection_reason && (
                        <div className="mt-2 text-[11px] text-rose-600">
                          <span className="font-semibold">Reason:</span> {r.rejection_reason}
                        </div>
                      )}
                      {r.asset_name && (
                        <div className="mt-2 text-[11px] text-slate-500">
                          Assigned item: {r.asset_name} ({r.asset_tag})
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === 'fulfill' && (
              <div className="space-y-3">
                <div className="rounded-xl bg-blue-50 border border-blue-200 text-blue-800 text-xs px-3.5 py-2.5">
                  Requisitions you approved that are still waiting for a specific item to be handed over — no Asset
                  Management Module Access needed.
                </div>
                {loading ? (
                  <div className="flex justify-center py-14">
                    <Spinner size={20} className="text-slate-400" />
                  </div>
                ) : awaitingFulfillment.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 text-center py-10 text-slate-400">
                    <Inbox className="w-6 h-6 text-slate-300" />
                    <p className="text-xs font-semibold text-slate-500">Nothing waiting on you right now.</p>
                  </div>
                ) : (
                  awaitingFulfillment.map((r) => {
                    const requestedNames = (r.items || []).map((it) => it.item_name.toLowerCase());
                    const matching = availableAssets.filter((a) => requestedNames.includes(a.category.toLowerCase()));
                    const rest = availableAssets.filter((a) => !requestedNames.includes(a.category.toLowerCase()));
                    return (
                      <div key={r.id} className="border border-slate-200 rounded-xl p-3.5">
                        <div className="text-xs font-bold text-slate-900">{r.asset_category}</div>
                        <div className="mt-2.5 pt-2.5 border-t border-slate-100 space-y-1">
                          {(r.items || []).map((it, idx) => (
                            <div key={idx} className="text-xs text-slate-600 flex items-baseline justify-between gap-2">
                              <span>
                                <span className="font-semibold text-slate-800">{it.item_name}</span> — {it.purpose}
                              </span>
                              <span className="text-[11px] text-slate-500 shrink-0">
                                {it.quantity} {it.unit}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3">
                          {fulfillingFor === r.id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <select
                                value={fulfillAssetId}
                                onChange={(e) => setFulfillAssetId(e.target.value)}
                                className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                              >
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
                              <button
                                onClick={() => fulfillRequisition(r.id)}
                                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                              >
                                Dispatch
                              </button>
                              <button
                                onClick={() => setFulfillingFor(null)}
                                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
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
                              className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            >
                              Fulfill / Hand Over
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}