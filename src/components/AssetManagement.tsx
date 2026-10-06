/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Asset" — self-service tab for the logged-in account:
// what they currently hold (My Assets), tracking where each request stands
// (Status), and requesting something new via the "+ New Requisition" popup.
// Talks to AssetManagementRoutes.ts (server.ts registers it via
// registerAssetManagementRoutes). Mirrors the read/write split and
// fetch-with-Bearer-token pattern already used throughout App.tsx.
//
// Web: same page design as Book a Ride (VehicleManagement.tsx) — round back
// arrow + title, underline tabs, full width, table-style lists on desktop.
// Native app: page chrome (blue-tinted background, white rounded-2xl card,
// icon/title header) mirrors the Leave Application page's
// design exactly, so "My Asset" feels like the same product as "Leave
// Application" instead of an older, plainer screen. Tabs use the same
// rounded-full segmented control as Leave Application's Review/Approved/
// Rejected tabs, every list below uses the same bordered-rounded-xl card +
// pill status badge pattern as Leave Application's card list, and
// "+ New Requisition" opens NewAssetRequisitionModal — the same "+ Add New"
// popup-button treatment as Leave Application, instead of what used to be a
// third in-page tab.

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  ArrowLeft, Package, Inbox, Clock, CheckCircle2, XCircle, AlertTriangle, Plus
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { NewAssetRequisitionModal } from './NewAssetRequisitionModal';
import { AssetFulfillModal } from './AssetFulfillModal';
import { AssetRequisitionHistoryModal } from './AssetRequisitionHistoryModal';
import { useWideWeb } from '../lib/useWideWeb';
import { takeQuickAccessTab } from '../lib/quickAccess';

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
  // Set when the item came through the typed Fulfill & Hand Over form.
  quantity?: number | string | null;
  unit?: string | null;
  handover_note?: string | null;
}

// "5 reams" — only shown for items handed over with a quantity.
const qtyLabel = (a: AssignedAsset) => (a.quantity != null && a.quantity !== '' ? `${Number(a.quantity)} ${a.unit || 'pcs'}` : null);

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
  // Supervisor edits (see AssetRequisitionEditItemsModal).
  source?: string | null;
  original_quantity?: number | string | null;
}

// Small marker next to an item the Supervisor added or changed.
const SupervisorEditMark: React.FC<{ it: RequisitionItem }> = ({ it }) =>
  it.source === 'supervisor' ? (
    <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">Added by Supervisor</span>
  ) : it.original_quantity != null && Number(it.original_quantity) !== Number(it.quantity) ? (
    <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">
      Qty {Number(it.original_quantity)} → {Number(it.quantity)}
    </span>
  ) : null;

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

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

type AssetTab = 'my-assets' | 'status' | 'fulfill';

// Web list columns (same table-style rows as Book a Ride's Ride Status).
const ASSET_LIST_COLS = 'grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_260px]';
const REQ_LIST_COLS = 'grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.4fr)]';

interface AssetManagementProps {
  onBack: () => void;
}

export function AssetManagement({ onBack }: AssetManagementProps) {
  // Web gets Book a Ride's page design; the Android APK keeps the card
  // design so it reads as one native screen.
  const isNativeApp = Capacitor.isNativePlatform();
  // Desktop web browser only: My Assets / Status as table-style lists, same
  // as Book a Ride's Ride Status list (VehicleManagement.tsx).
  const wideWeb = useWideWeb();
  // Phone layout (APK, or a narrow browser): the app's themed card design.
  const phoneUI = !wideWeb;
  // One-shot request from the Dashboard's My Asset quick access: a tab, or
  // 'new' to open the New Requisition popup straight away.
  const [quickAccess] = useState(() => takeQuickAccessTab('myAsset'));
  const [tab, setTab] = useState<AssetTab>(quickAccess === 'status' ? 'status' : 'my-assets');
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
  // Requisition whose Fulfill & Hand Over form is open (AssetFulfillModal).
  const [fulfillingFor, setFulfillingFor] = useState<Requisition | null>(null);
  // Requisition whose History is open (AssetRequisitionHistoryModal).
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  // Issues reported on items THIS account handed over — only returned when
  // the server's FULFILLER_CAN_RESOLVE_CLAIMS switch is on (currently off,
  // so this section stays hidden).
  const [myClaims, setMyClaims] = useState<{ enabled: boolean; claims: any[] }>({ enabled: false, claims: [] });
  const [claimNote, setClaimNote] = useState<Record<number, string>>({});
  const loadMyClaims = () =>
    fetch(apiUrl('/api/assets/assignment-claims/mine'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMyClaims({ enabled: !!d.enabled, claims: Array.isArray(d.claims) ? d.claims : [] }))
      .catch(() => {});
  const resolveMyClaim = async (id: number) => {
    const note = (claimNote[id] || '').trim();
    if (!note) return setError('Add a note on how the issue was resolved.');
    const res = await fetch(apiUrl(`/api/assets/assignment-claims/${id}/resolve`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ resolution_note: note })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error || 'Could not resolve this issue.');
    loadMyClaims();
  };

  // "+ New Requisition" — popup button next to the page title (same
  // "+ Add New" treatment as Leave Application), opening
  // NewAssetRequisitionModal instead of the old in-page "New Requisition"
  // tab. onSubmitted below refreshes Status and jumps to it so the new
  // request is visible right away.
  const [showNewRequisitionModal, setShowNewRequisitionModal] = useState(quickAccess === 'new');

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
      const reqRes = await fetch(apiUrl('/api/assets/requisitions/awaiting-my-fulfillment'), { headers: authHeaders() });
      const reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || 'Failed to load requests awaiting fulfillment.');
      setAwaitingFulfillment(reqData);
    } catch (err: any) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'my-assets') loadMyAssets();
    if (tab === 'status') loadRequisitions();
    if (tab === 'fulfill') {
      loadAwaitingFulfillment();
      loadMyClaims();
    }
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

  const renderReportForm = (a: AssignedAsset) =>
    reportingFor === a.assignment_id && (
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
    );

  const TABS: { key: AssetTab; label: string; count?: number }[] = [
    { key: 'my-assets', label: 'My Assets' },
    { key: 'status', label: 'Status' },
    { key: 'fulfill', label: 'Approved by Me', count: awaitingFulfillment.length }
  ];

  return (
    // Web: same page design as Book a Ride (App.tsx's vehicleManagement
    // wrapper + VehicleManagement.tsx) — round back arrow + title, underline
    // tabs, full width, table-style lists. The native app keeps the card
    // design below.
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className={isNativeApp ? 'w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8' : 'w-full px-4 lg:px-8 pt-3 pb-28 md:pb-8'}>
        {!isNativeApp && <ModulePath path={['Self Service', 'My Asset']} />}
        {!isNativeApp && (
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onBack}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
                style={{ color: 'var(--g-text-muted)' }}
                aria-label="Back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="text-base font-bold flex items-center gap-2">
                <Package className="w-5 h-5 text-blue-600 shrink-0" /> My Asset
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setShowNewRequisitionModal(true)}
              className="hidden md:flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" /> New Requisition
            </button>
          </div>
        )}

        {/* Liquid glass on mobile (soft blue-tint gradient + backdrop-blur +
            big rounded corners) — same mobile treatment as Leave
            Application's (LeaveReviewPage.tsx) card. Desktop's md: overrides
            keep the original plain white panel untouched. */}
        <div
          className={
            phoneUI
              ? 'bg-gradient-to-br from-violet-100/60 via-white/60 to-white/40 border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.7)] overflow-hidden'
              : 'w-full'
          }
        >
          {isNativeApp && (
          <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <Package className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">My Asset</h1>
                <p className="text-xs text-slate-500">What you hold, what you've requested, and what's waiting on you.</p>
              </div>
            </div>
            {/* "+ New Requisition" — desktop only here now. Mobile/APK moves
                this to the floating bottom-right button below, same
                design/position as Leave Application's (LeaveReviewPage.tsx)
                floating "Submit Leave" button. */}
            <button
              type="button"
              onClick={() => setShowNewRequisitionModal(true)}
              className="hidden md:flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" /> New Requisition
            </button>
          </div>
          )}

          {!phoneUI && (
            <div className="flex gap-1 border-b border-gray-200 mb-4">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {t.label}
                  {typeof t.count === 'number' && t.count > 0 ? ` (${t.count})` : ''}
                </button>
              ))}
            </div>
          )}

          {phoneUI && (
          /* Segmented control — same rounded-full track as Leave
              Application's Review/Approved/Rejected tabs; mobile gets the
              same translucent bg-white/50 + blur glass treatment as the
              outer card, desktop keeps the solid slate-100 track. */
          <div className="mx-4 mt-4 flex items-center gap-1.5 rounded-full bg-white/60 border border-white/70 p-1.5 text-xs font-semibold overflow-x-auto">
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
          )}

          {error && (
            <div className={`${phoneUI ? 'mx-4 mt-4' : 'mb-3'} rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5`}>
              {error}
            </div>
          )}

          <div className={phoneUI ? 'p-4' : ''}>
            {tab === 'my-assets' && wideWeb && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className={`grid ${ASSET_LIST_COLS} gap-4 px-5 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500`}>
                  <div>Asset</div>
                  <div>Tag / Serial</div>
                  <div>Handed Over</div>
                  <div>Status</div>
                  <div className="text-right">Actions</div>
                </div>
                {loading && <div className="px-5 py-4 text-sm text-gray-500">Loading…</div>}
                {!loading && myAssets.length === 0 && (
                  <div className="px-5 py-4 text-sm text-gray-500">You don't have any assets assigned right now.</div>
                )}
                {!loading &&
                  myAssets.map((a) => (
                    <div key={a.assignment_id} className="px-5 py-3.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60">
                      <div className={`grid ${ASSET_LIST_COLS} gap-4 items-start`}>
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 truncate" title={a.name}>
                            {a.name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {qtyLabel(a) ? `Qty: ${qtyLabel(a)} · ` : ''}
                            {a.category}
                          </div>
                          {a.handover_note && <div className="text-xs text-slate-400 truncate" title={a.handover_note}>{a.handover_note}</div>}
                        </div>
                        <div className="min-w-0 text-sm text-slate-700">
                          <div className="truncate">{a.asset_tag}</div>
                          <div className="text-xs text-slate-500 truncate">{a.serial_number ? `S/N: ${a.serial_number}` : '—'}</div>
                        </div>
                        <div className="text-sm text-slate-700">
                          {a.assigned_date}
                          <div className="text-xs text-slate-500 capitalize">Condition: {a.condition_on_assign}</div>
                        </div>
                        <div className="min-w-0 space-y-1">
                          {a.pending_claim ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                              <AlertTriangle className="w-3 h-3" /> Issue Reported
                            </span>
                          ) : !a.acknowledged_at ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">
                              <Clock className="w-3 h-3" /> Awaiting your Ack
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-green-100 text-green-800">
                              <CheckCircle2 className="w-3 h-3" /> Acknowledged
                            </span>
                          )}
                          {a.pending_claim && (
                            <div className="text-xs text-amber-700">
                              {ISSUE_TYPE_LABEL[a.pending_claim.issue_type]}: {a.pending_claim.description}
                            </div>
                          )}
                          {a.return_requested_at && <div className="text-xs text-amber-700">Return requested — awaiting IT/Admin.</div>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {!a.pending_claim && !a.acknowledged_at && (
                            <>
                              <button
                                onClick={() => acknowledge(a.assignment_id)}
                                className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                              >
                                Accept
                              </button>
                              <button
                                onClick={() => {
                                  setReportingFor(reportingFor === a.assignment_id ? null : a.assignment_id);
                                  setIssueForm({ issue_type: 'mismatch', description: '' });
                                }}
                                className="px-2.5 py-1 text-xs font-medium rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
                              >
                                Report Issue
                              </button>
                            </>
                          )}
                          {!a.pending_claim && !a.return_requested_at && (
                            <button
                              onClick={() => requestReturn(a.assignment_id)}
                              className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                            >
                              Return / Replace
                            </button>
                          )}
                        </div>
                      </div>
                      {renderReportForm(a)}
                    </div>
                  ))}
              </div>
            )}

            {tab === 'my-assets' && !wideWeb && (
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
                          {qtyLabel(a) && <p className="text-[11px] font-semibold text-slate-700 mt-0.5">Qty: {qtyLabel(a)}</p>}
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Handed over: {a.assigned_date} • Condition: {a.condition_on_assign}
                          </p>
                          {a.handover_note && <p className="text-[11px] text-slate-500 mt-0.5">Note: {a.handover_note}</p>}
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

                      {renderReportForm(a)}
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === 'status' && wideWeb && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className={`grid ${REQ_LIST_COLS} gap-4 px-5 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500`}>
                  <div>Requisition</div>
                  <div>Items</div>
                  <div>Requested</div>
                  <div>Status</div>
                  <div>Assigned Item</div>
                </div>
                {loading && <div className="px-5 py-4 text-sm text-gray-500">Loading…</div>}
                {!loading && requisitions.length === 0 && <div className="px-5 py-4 text-sm text-gray-500">No requisitions yet.</div>}
                {!loading &&
                  requisitions.map((r) => (
                    <div key={r.id} className={`grid ${REQ_LIST_COLS} gap-4 items-start px-5 py-3.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60`}>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 truncate">{r.asset_category}</div>
                        <div className="text-xs text-slate-500 capitalize">Urgency: {r.urgency}</div>
                        <button type="button" onClick={() => setHistoryFor(r.id)} className="mt-1 text-xs font-semibold text-blue-600 hover:underline">
                          View history
                        </button>
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        {(r.items || []).map((it, idx) => (
                          <div key={idx} className="text-sm text-slate-700 truncate" title={`${it.item_name} — ${it.purpose}`}>
                            <span className="font-medium text-slate-800">{it.item_name}</span>{' '}
                            <span className="text-xs text-slate-500">
                              × {Number(it.quantity)} {it.unit}
                            </span>
                            <SupervisorEditMark it={it} />
                          </div>
                        ))}
                      </div>
                      <div className="text-sm text-slate-700">{r.created_at}</div>
                      <div className="min-w-0 space-y-1">
                        <RequisitionStatusBadge status={r.status} />
                        {r.status === 'pending' && r.pending_with && (
                          <div className="text-xs text-amber-700 truncate" title={r.pending_with}>
                            Waiting on: <span className="font-medium">{r.pending_with}</span>
                          </div>
                        )}
                        {r.status === 'rejected' && r.rejection_reason && <div className="text-xs text-red-600">Reason: {r.rejection_reason}</div>}
                      </div>
                      <div className="min-w-0 text-sm text-slate-700 truncate">
                        {r.asset_name ? `${r.asset_name} (${r.asset_tag})` : <span className="text-slate-400">—</span>}
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {tab === 'status' && !wideWeb && (
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
                      <p className="text-[11px] text-slate-500 mt-1">Requested: {r.created_at} • Urgency: <span className="capitalize">{r.urgency}</span></p>
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
                              <SupervisorEditMark it={it} />
                            </span>
                            <span className="text-[11px] text-slate-500 shrink-0">
                              {Number(it.quantity)} {it.unit}
                            </span>
                          </div>
                        ))}
                      </div>
                      <button type="button" onClick={() => setHistoryFor(r.id)} className="mt-2 text-[11px] font-semibold text-blue-600 hover:underline">
                        View history
                      </button>
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
                  Requisitions you approved that are still waiting to be handed over — open Fulfill, type what you're
                  handing over, and the employee confirms it in My Asset. No Asset Management Module Access needed.
                </div>
                {myClaims.enabled && myClaims.claims.length > 0 && (
                  <div className="border border-orange-200 bg-orange-50/50 rounded-xl p-3.5 space-y-2.5">
                    <div className="text-xs font-bold text-orange-800">Issues reported on items you handed over</div>
                    {myClaims.claims.map((c) => (
                      <div key={c.id} className="bg-white border border-orange-100 rounded-lg p-2.5 text-xs space-y-1.5">
                        <div className="text-slate-800">
                          <span className="font-semibold">{c.employee_name}</span> — {c.asset_name} ({c.asset_tag}): {c.description}
                        </div>
                        <div className="flex gap-2">
                          <input
                            value={claimNote[c.id] || ''}
                            onChange={(e) => setClaimNote((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            placeholder="How was it resolved?"
                            className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-100"
                          />
                          <button
                            type="button"
                            onClick={() => resolveMyClaim(c.id)}
                            className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                          >
                            Resolve
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
                                {Number(it.quantity)} {it.unit}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3">
                          <button
                            onClick={() => setFulfillingFor(r)}
                            className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                          >
                            Fulfill / Hand Over
                          </button>
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

      {/* Floating "+ New Requisition" — mobile/APK only, same liquid-glass
          pill design/position as Leave Application's floating "Submit Leave"
          button (LeaveReviewPage.tsx): bottom-right, above BottomNav's fixed
          bar, offset by the native safe-area inset. */}
      <button
        type="button"
        onClick={() => setShowNewRequisitionModal(true)}
        className="md:hidden fixed right-4 z-50 flex items-center gap-1.5 pl-3.5 pr-4 py-2.5 rounded-full text-white text-xs font-semibold backdrop-blur-xl border border-white/40 bg-gradient-to-br from-violet-400/90 via-violet-600/90 to-purple-800/90 shadow-[0_10px_28px_-6px_rgba(124,58,237,0.55),inset_0_1px_0_rgba(255,255,255,0.45)] active:scale-95 active:shadow-[0_4px_14px_-4px_rgba(124,58,237,0.5),inset_0_1px_0_rgba(255,255,255,0.3)] transition-all"
        style={{ bottom: 'calc(6.5rem + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}
      >
        <Plus className="w-3.5 h-3.5" /> New Requisition
      </button>

      {showNewRequisitionModal && (
        <NewAssetRequisitionModal
          onClose={() => setShowNewRequisitionModal(false)}
          onSubmitted={() => {
            setShowNewRequisitionModal(false);
            setTab('status');
            loadRequisitions();
          }}
        />
      )}

      {historyFor !== null && (
        <AssetRequisitionHistoryModal token={localStorage.getItem('mpr_token') || ''} requisitionId={historyFor} onClose={() => setHistoryFor(null)} />
      )}

      {fulfillingFor && (
        <AssetFulfillModal
          token={localStorage.getItem('mpr_token') || ''}
          requisitionId={fulfillingFor.id}
          mode="fulfill"
          requesterName={(fulfillingFor as any).employee_name}
          items={fulfillingFor.items || []}
          onClose={() => setFulfillingFor(null)}
          onDone={() => {
            setFulfillingFor(null);
            loadAwaitingFulfillment();
          }}
        />
      )}
    </div>
  );
}