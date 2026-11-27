import { activePeople } from '../lib/activePeople';
import { RequestDetailsInline } from './RequestDetails';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheck, ArrowRight, CheckCircle2, XCircle, Clock, Settings2, X, GripVertical, Trash2, Plus, AlertCircle, ChevronDown, Search
} from 'lucide-react';
import { ApprovalRequest, ApprovalChainStep, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';
import { ClaimChangesNotice, ReclaimTick, ReturnButton } from './ClaimReviewBits';
import { LoadingBlock } from './LoadingBlock';

import { SearchSelect } from './Combobox';
import { personLabel } from '../lib/personLabel';
interface ApprovalManagerProps {
  token: string;
  user: User;
  users: User[];
}

// Small status pill reused in the queue/history table.
const StatusPill: React.FC<{ status: ApprovalRequest['status'] }> = ({ status }) => {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="w-3 h-3" /> Approved
      </span>
    );
  }
  if (status === 'returned') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-800">
        <Clock className="w-3 h-3" /> Returned to employee
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-rose-50 text-rose-700">
        <XCircle className="w-3 h-3" /> Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-700">
      <Clock className="w-3 h-3" /> Pending
    </span>
  );
};

// Admin Panel -> Approvals: a Superadmin builds a global, ORDERED chain of
// Admin/Superadmin approvers (this component's "Manage Chain" modal); every
// Check In/Out a User records for Remote Attendance then routes through that
// chain layer by layer, non-blocking (the check-in/out itself is already
// recorded — this is purely the review trail). A Bill Claim (User
// Panel -> Bill Claim) ALSO routes through this same chain, but is
// NOT non-blocking: the claim only becomes a real Conveyance Bill line item the
// moment the LAST step here Approves it (see the optional Bill picker below),
// and is freed up again if Rejected at any step. Check In/Out (the live
// GPS check-in/out card) do NOT go through this chain at all — no approval is
// required for a Check In/Out Check In/Out. Any Admin/Superadmin granted the
// "approvals" module can see the queue and act at their own step; only a
// Superadmin can edit the chain itself.
// ---- Queue: request type names, how long each has waited, Group by / Sort ----
export const requestTypeLabel = (r: ApprovalRequest): string =>
  r.source_type === 'attendance'
    ? 'Remote Attendance'
    : r.source_type === 'bill_claim'
      ? 'Bill Claim'
      : r.source_type === 'attendance_correction'
        ? 'Attendance Correction'
        : r.source_type === 'leave_application'
          ? 'Leave Application'
          : r.source_type === 'asset_requisition'
            ? 'Asset Requisition'
            : r.source_type === 'vehicle_requisition'
              ? 'Vehicle Requisition'
              : r.source_type === 'mobile_limit_request'
                ? 'Mobile Limit Request'
                : r.source_type === 'advance_request'
                  ? 'Loan / Advance Request'
                  : 'Check In/Out';
const daysWaiting = (r: ApprovalRequest) => Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000));
type AgeBand = 'old' | 'mid' | 'today';
const ageBand = (r: ApprovalRequest): AgeBand => (daysWaiting(r) >= 3 ? 'old' : daysWaiting(r) >= 1 ? 'mid' : 'today');
const AGE_LABEL: Record<AgeBand, string> = { old: 'Waiting 3+ days', mid: '1–2 days', today: 'Today' };
const AGE_ORDER = ['Waiting 3+ days', '1–2 days', 'Today', 'Decided'];
const AGE_CLS: Record<AgeBand, string> = { old: 'text-rose-600', mid: 'text-amber-600', today: 'text-emerald-600' };
const ageText = (r: ApprovalRequest) => (daysWaiting(r) === 0 ? 'Today' : daysWaiting(r) === 1 ? '1 day' : `${daysWaiting(r)} days`);
type QueueGroup = 'type' | 'who' | 'dept' | 'waiting' | 'age' | 'none';
type QueueSort = 'old' | 'new' | 'amount' | 'name';
const SORTERS: Record<QueueSort, (a: ApprovalRequest, b: ApprovalRequest) => number> = {
  old: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  new: (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  amount: (a, b) => (Number(b.source_amount) || 0) - (Number(a.source_amount) || 0),
  name: (a, b) => String(a.requested_by_name || '').localeCompare(String(b.requested_by_name || ''))
};
const QUEUE_PREFS = 'chr_approval_queue_view';
const readPrefs = (): { groupBy?: QueueGroup; sortBy?: QueueSort; details?: boolean } => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_PREFS) || '{}') || {};
  } catch {
    return {};
  }
};

export const ApprovalManager: React.FC<ApprovalManagerProps> = ({ token, user, users }) => {
  const isSuperAdmin = user.role === 'superadmin';

  const [chain, setChain] = useState<ApprovalChainStep[]>([]);
  // Set once the chain has loaded, so "No approval chain configured yet"
  // doesn't flash up while it's still being fetched.
  const [chainLoaded, setChainLoaded] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'mine' | 'all'>('mine');
  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'approved' | 'rejected'>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<QueueGroup>(() => readPrefs().groupBy || 'type');
  const [sortBy, setSortBy] = useState<QueueSort>(() => readPrefs().sortBy || 'old');
  // Each request's details card; folded by default so a long list scans.
  const [showDetails, setShowDetails] = useState<boolean>(() => !!readPrefs().details);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      localStorage.setItem(QUEUE_PREFS, JSON.stringify({ groupBy, sortBy, details: showDetails }));
    } catch {
      /* private window — the choice just isn't kept */
    }
  }, [groupBy, sortBy, showDetails]);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  // Only relevant for a 'bill_claim' request on its LAST step — which existing
  // Conveyance Bill (for that same User) to attach it to on Approve. Left blank
  // to auto-create a new Bill, same default POST /api/approvals/:id/act uses.
  const [billChoice, setBillChoice] = useState<Record<number, string>>({});
  const [voucherDraft, setVoucherDraft] = useState<Record<number, string>>({});
  const [userBillsCache, setUserBillsCache] = useState<Record<number, { id: number; bill_date: string }[]>>({});
  // Approved Amount draft for a 'bill_claim' request's LAST step — pre-filled
  // with the full Claim Amount (default = approve as claimed) the first time
  // that row is shown, editable down to support a partial approval. Remaining
  // Amount (Claim Amount - Approved Amount) is derived from this, never its
  // own state.
  const [approvedAmountDraft, setApprovedAmountDraft] = useState<Record<number, string>>({});

  // --- Manage Chain modal (Superadmin only) ---
  const [showChainModal, setShowChainModal] = useState(false);
  const [chainDraft, setChainDraft] = useState<number[]>([]);
  const [addApproverId, setAddApproverId] = useState('');
  const [savingChain, setSavingChain] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const fetchChain = async () => {
    try {
      const res = await fetch(apiUrl('/api/approvals/chain'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setChain(await res.json());
    } catch (err) {
      console.error('Failed to load approval chain', err);
    } finally {
      setChainLoaded(true);
    }
  };

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (view === 'mine') params.set('mine', 'true');
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(apiUrl(`/api/approvals?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRequests(await res.json());
    } catch (err) {
      console.error('Failed to load approval requests', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchChain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, statusFilter]);

  const userMap = new Map<number, User>(users.map((u) => [u.id, u]));
  // The three amount columns only mean anything for a Bill Claim —
  // left out when none is listed, so Remote Attendance rows aren't squeezed.
  const hasClaims = requests.some((r) => r.source_type === 'bill_claim');
  // Only Admins/Superadmins are eligible to be added to the chain.
  const eligibleApprovers = activePeople(users.filter((u) => u.role === 'admin' || u.role === 'superadmin'));

  const openChainModal = () => {
    setChainDraft(chain.map((s) => s.user_id));
    setChainError(null);
    setAddApproverId('');
    setShowChainModal(true);
  };

  const addToChainDraft = () => {
    const id = Number(addApproverId);
    if (!id) return;
    if (chainDraft.includes(id)) {
      setChainError('This person is already in the chain.');
      return;
    }
    setChainDraft((prev) => [...prev, id]);
    setAddApproverId('');
    setChainError(null);
  };

  const removeFromChainDraft = (id: number) => {
    setChainDraft((prev) => prev.filter((x) => x !== id));
  };

  const moveInDraft = (from: number, to: number) => {
    if (to < 0 || to >= chainDraft.length) return;
    setChainDraft((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const handleSaveChain = async () => {
    setSavingChain(true);
    setChainError(null);
    try {
      const res = await fetch(apiUrl('/api/approvals/chain'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_ids: chainDraft })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save the approval chain');
      setChain(data.chain || []);
      setShowChainModal(false);
      setMessage({ type: 'success', text: 'Approval chain saved.' });
      fetchRequests();
    } catch (err: any) {
      setChainError(err.message || 'Failed to save the approval chain');
    } finally {
      setSavingChain(false);
    }
  };

  // Reject with "Allow re-claim" ticked, per request.
  const [reclaimDraft, setReclaimDraft] = useState<Record<number, boolean>>({});

  const handleAct = async (id: number, action: 'approved' | 'rejected' | 'returned', approvedAmount?: number) => {
    const target = requests.find((r) => r.id === id);
    // Bill Claim: Return / Reject tell the employee why.
    if (target?.source_type === 'bill_claim' && action !== 'approved' && !(remarksDraft[id] || '').trim()) {
      setMessage({ type: 'error', text: `Write the reason in Remarks before you ${action === 'returned' ? 'return' : 'reject'} it — the employee sees it.` });
      return;
    }
    // A ride request is never rejected without a reason (the server refuses too).
    if (target?.source_type === 'vehicle_requisition' && action === 'rejected' && !(remarksDraft[id] || '').trim()) {
      setMessage({ type: 'error', text: 'Write why this ride is rejected in Remarks — the rider sees it.' });
      return;
    }
    setActingId(id);
    setMessage(null);
    try {
      const bill_id = billChoice[id] ? Number(billChoice[id]) : undefined;
      // On a Conveyance Disburser Layer the same field holds the voucher no.
      const disburse = requests.some((r) => r.id === id && r.conveyance_disburser_step);
      const res = await fetch(apiUrl(`/api/approvals/${id}/act`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action,
          remarks: remarksDraft[id] || undefined,
          bill_id: disburse ? undefined : bill_id,
          voucher_no: disburse && action === 'approved' ? voucherDraft[id] || undefined : undefined,
          approved_amount: action === 'approved' && approvedAmount != null ? approvedAmount : undefined,
          claim_version: target?.source_type === 'bill_claim' ? target.claim_version : undefined,
          allow_reclaim: target?.source_type === 'bill_claim' && action === 'rejected' ? !!reclaimDraft[id] : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({
        type: 'success',
        text: action === 'returned' ? 'Returned to the employee for correction.' : action !== 'approved' ? 'Rejected.' : data.voucher_no ? `Disbursed — voucher ${data.voucher_no}.` : 'Approved.'
      });
      setRemarksDraft((prev) => ({ ...prev, [id]: '' }));
      setBillChoice((prev) => ({ ...prev, [id]: '' }));
      setApprovedAmountDraft((prev) => ({ ...prev, [id]: '' }));
      fetchRequests();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingId(null);
    }
  };

  // Lazily loads a User's existing Conveyance Bills the first time a 'bill_claim'
  // request's LAST-step row is shown, so the approver can pick one instead of
  // always auto-creating a brand-new Bill per claim.
  const ensureUserBillsLoaded = async (userId: number) => {
    if (userBillsCache[userId]) return;
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills?user_id=${userId}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const bills = await res.json();
        setUserBillsCache((prev) => ({ ...prev, [userId]: bills }));
      }
    } catch {
      // Non-critical — Approve still works, it'll just auto-create a Bill.
    }
  };

  // ---- Search, type chips, Group by and Sort (the choices stay on this computer) ----
  const typeOf = (r: ApprovalRequest) => requestTypeLabel(r);
  const typeCounts = new Map<string, number>();
  requests.forEach((r) => typeCounts.set(typeOf(r), (typeCounts.get(typeOf(r)) || 0) + 1));
  const needle = search.trim().toLowerCase();
  const shown = requests
    .filter((r) => !types.length || types.includes(typeOf(r)))
    .filter(
      (r) =>
        !needle ||
        [typeOf(r), r.source_label, r.source_category, r.requested_by_name, r.requested_by_code, r.requested_by_designation, r.requested_by_department, r.current_approver_name]
          .join(' ')
          .toLowerCase()
          .includes(needle)
    )
    .sort(SORTERS[sortBy]);
  const groupKey = (r: ApprovalRequest): string =>
    groupBy === 'type'
      ? typeOf(r)
      : groupBy === 'who'
        ? `${r.requested_by_name || `User #${r.requested_by}`}${r.requested_by_code ? ` · ${r.requested_by_code}` : ''}`
        : groupBy === 'dept'
          ? r.requested_by_department || 'No department'
          : groupBy === 'waiting'
            ? r.status === 'pending'
              ? r.current_approver_name || 'No approver set'
              : 'Decided'
            : r.status !== 'pending'
              ? 'Decided'
              : AGE_LABEL[ageBand(r)];
  const groupMap = new Map<string, ApprovalRequest[]>();
  shown.forEach((r) => groupMap.set(groupKey(r), [...(groupMap.get(groupKey(r)) || []), r]));
  const groups = [...groupMap.entries()].sort((a, b) =>
    groupBy === 'age'
      ? AGE_ORDER.indexOf(a[0]) - AGE_ORDER.indexOf(b[0])
      : Math.max(...b[1].map(daysWaiting)) - Math.max(...a[1].map(daysWaiting)) || a[0].localeCompare(b[0])
  );
  const toggleGroup = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  // "Approve all" on a group: only the ones this account may decide and that
  // need nothing else filled in (Bill Claim's last Layer — Bill / Approved
  // Amount / voucher —, the Vehicle and Asset steps that assign or hand out).
  const canQuickApprove = (r: ApprovalRequest) => {
    if (r.status !== 'pending' || Number(r.awaiting_approver) === 1) return false;
    if (!(isSuperAdmin || (r.current_approver_ids || []).includes(user.id))) return false;
    if (r.conveyance_disburser_step) return false;
    const last = Number(r.current_step) >= Number(r.total_steps);
    if (r.source_type === 'bill_claim' && last) return false;
    if ((r.source_type === 'vehicle_requisition' || r.source_type === 'asset_requisition') && last) return false;
    return true;
  };
  const [bulkBusy, setBulkBusy] = useState(false);
  const approveAll = async (group: string, list: ApprovalRequest[]) => {
    if (!(await confirmDialog(`Approve all ${list.length} in "${group}"?\n\nEach one moves to its next Layer (or is finished) exactly as if you approved it on its own.`))) return;
    setBulkBusy(true);
    setMessage(null);
    let done = 0;
    const failed: string[] = [];
    for (const r of list) {
      try {
        const res = await fetch(apiUrl(`/api/approvals/${r.id}/act`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'approved', claim_version: r.source_type === 'bill_claim' ? r.claim_version : undefined })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'failed');
        done++;
      } catch (err: any) {
        failed.push(`${r.requested_by_name || 'Request'} (${typeOf(r)}): ${err.message}`);
      }
    }
    setBulkBusy(false);
    setMessage(
      failed.length
        ? { type: 'error', text: `Approved ${done}. Not approved ${failed.length} — ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}` }
        : { type: 'success', text: `Approved ${done}.` }
    );
    fetchRequests();
  };

  const tableOf = (list: ApprovalRequest[]) => {
    const hasClaims = list.some((r) => r.source_type === 'bill_claim');
    return (
      <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Event</th>
                {hasClaims && (
                  <>
                    <th className="text-left px-4 py-3 font-semibold">Claim Amount</th>
                    <th className="text-left px-4 py-3 font-semibold">Approved Amount</th>
                    <th className="text-left px-4 py-3 font-semibold">Remaining Amount</th>
                  </>
                )}
                <th className="text-left px-4 py-3 font-semibold">Requested By</th>
                <th className="text-left px-4 py-3 font-semibold">Progress</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold">When</th>
                <th className="text-right px-4 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((r) => {
                const canAct = r.status === 'pending' && (isSuperAdmin || (r.current_approver_ids || []).includes(user.id));
                return (
                  <tr key={r.id} className="hover:bg-slate-50/60 align-top">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">
                        {r.source_type === 'attendance'
                          ? 'Remote Attendance'
                          : r.source_type === 'bill_claim'
                          ? 'Bill Claim'
                          : r.source_type === 'attendance_correction'
                          ? 'Attendance Correction'
                          : r.source_type === 'leave_application'
                          ? 'Leave Application'
                          : r.source_type === 'asset_requisition'
                          ? 'Asset Requisition'
                          : r.source_type === 'vehicle_requisition'
                          ? 'Vehicle Requisition'
                          : r.source_type === 'mobile_limit_request'
                          ? 'Mobile Limit Request'
                          : r.source_type === 'advance_request'
                          ? 'Loan / Advance Request'
                          : 'Check In/Out'}
                        {' — '}
                        {r.source_type === 'attendance_correction' || r.source_type === 'leave_application' || r.source_type === 'asset_requisition' || r.source_type === 'vehicle_requisition' || r.source_type === 'mobile_limit_request' || r.source_type === 'advance_request'
                          ? 'Requested'
                          : r.event_type === 'check_in'
                          ? 'Check In'
                          : r.event_type === 'check_out'
                          ? 'Check Out'
                          : 'Submitted'}
                      </div>
                      <div className="text-xs text-slate-500">{r.source_label}</div>
                      {r.source_type === 'bill_claim' && r.source_category && (
                        <div className="text-xs text-slate-500">{r.source_category}</div>
                      )}
                      {showDetails && <RequestDetailsInline token={token} type={r.source_type} id={r.source_id} className="min-w-[18rem]" />}
                    </td>
                    {hasClaims && (() => {
                      // Only a 'bill_claim' request finishing its LAST step is
                      // where an Approve actually finalizes an Approved Amount
                      // (see finalizeBillClaimApproval) — that's the only case
                      // this row lets the approver type one in. Everywhere else
                      // (other source types, an earlier step, already decided)
                      // these three columns just show what's known, or a dash.
                      const isBillClaim = r.source_type === 'bill_claim';
                      const isLastStep = Number(r.current_step) === Number(r.total_steps);
                      const editable = isBillClaim && canAct && r.status === 'pending' && isLastStep;
                      const claimAmount = r.source_amount != null ? Number(r.source_amount) : null;
                      // An earlier Layer may already have cut the amount — start from that.
                      const startAmount = r.source_approved_amount != null ? Number(r.source_approved_amount) : claimAmount;
                      const fmt = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;
                      let approvedAmount: number | null = null;
                      if (r.status === 'approved') {
                        approvedAmount = r.source_approved_amount != null ? Number(r.source_approved_amount) : claimAmount;
                      } else if (editable) {
                        const draft = approvedAmountDraft[r.id];
                        const parsed = Number(draft != null && draft !== '' ? draft : startAmount);
                        approvedAmount = Number.isFinite(parsed) ? parsed : null;
                      }
                      const remainingAmount = claimAmount != null && approvedAmount != null ? claimAmount - approvedAmount : null;
                      return (
                        <>
                          <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                            {isBillClaim && claimAmount != null ? fmt(claimAmount) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            {editable ? (
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                max={startAmount ?? undefined}
                                value={approvedAmountDraft[r.id] ?? (startAmount != null ? String(startAmount) : '')}
                                onChange={(e) => setApprovedAmountDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                className="w-28 text-xs px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                              />
                            ) : isBillClaim && approvedAmount != null ? (
                              <span className="text-slate-700">{fmt(approvedAmount)}</span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                            {remainingAmount != null ? fmt(remainingAmount) : <span className="text-slate-300">—</span>}
                          </td>
                        </>
                      );
                    })()}
                    <td className="px-4 py-3 text-slate-700">
                      {r.requested_by_name || `User #${r.requested_by}`}
                      {(r.requested_by_code || r.requested_by_department) && (
                        <div className="text-[11px] text-slate-500">{[r.requested_by_code, r.requested_by_designation, r.requested_by_department].filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      Step {r.current_step} of {r.total_steps}
                      {r.status === 'pending' && Number(r.awaiting_approver) === 1 && (
                        <div className="text-amber-700 font-medium">No approver set yet — set a Supervisor or Approval Template (or decide it as Superadmin)</div>
                      )}
                      {r.status === 'pending' && r.current_approver_name && (
                        <div className="text-slate-400">Waiting on {r.current_approver_name}</div>
                      )}
                      {r.actions.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {r.actions.map((a, i) => (
                            <div key={i} className={a.action === 'approved' ? 'text-emerald-600' : 'text-rose-600'}>
                              {a.approver_name}{' '}
                              {a.action === 'approved' ? 'approved' : a.action === 'returned' ? 'returned it for correction' : a.action === 'resubmitted' ? 'resubmitted it' : 'rejected'}
                              {a.remarks ? ` — "${a.remarks}"` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {formatDate(r.created_at)}
                      {r.status === 'pending' && <div className={`font-semibold ${AGE_CLS[ageBand(r)]}`}>{ageText(r)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {canAct ? (
                        <div className="flex flex-col items-end gap-1.5">
                          {r.conveyance_disburser_step && (
                            <input
                              type="text"
                              placeholder="Voucher no (auto if blank)"
                              title="Disburse approves this claim, puts it on its own Bill and records this voucher"
                              value={voucherDraft[r.id] || ''}
                              onChange={(e) => setVoucherDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                              className="w-40 text-xs px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                            />
                          )}
                          {r.source_type === 'bill_claim' && Number(r.current_step) === Number(r.total_steps) && !r.conveyance_disburser_step && (
                            <SearchSelect
                              value={billChoice[r.id] || ''}
                              onFocus={() => ensureUserBillsLoaded(r.requested_by)}
                              onChange={(e) => setBillChoice((prev) => ({ ...prev, [r.id]: e.target.value }))}
                              className="w-40 text-xs px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                            >
                              <option value="">Auto-create a new Bill</option>
                              {(userBillsCache[r.requested_by] || []).map((b) => (
                                <option key={b.id} value={b.id}>
                                  Bill #{b.id} — {formatDate(b.bill_date)}
                                </option>
                              ))}
                            </SearchSelect>
                          )}
                          {r.source_type === 'bill_claim' && <ClaimChangesNotice item={r} className="w-full" />}
                          <input
                            type="text"
                            aria-label="Remarks"
                            placeholder={r.source_type === 'bill_claim' ? 'Remarks (needed to Return/Reject)' : r.source_type === 'vehicle_requisition' ? 'Remarks (a reason is needed to Reject)' : 'Remarks (optional)'}
                            value={remarksDraft[r.id] || ''}
                            onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            className="w-40 text-xs px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                          {r.source_type === 'bill_claim' && (
                            <ReclaimTick item={r} checked={!!reclaimDraft[r.id]} onChange={(v) => setReclaimDraft((prev) => ({ ...prev, [r.id]: v }))} />
                          )}
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              disabled={actingId === r.id}
                              onClick={() => handleAct(r.id, 'rejected')}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
                            >
                              Reject
                            </button>
                            {r.source_type === 'bill_claim' && (
                              <ReturnButton item={r} compact disabled={actingId === r.id} onClick={() => handleAct(r.id, 'returned')} />
                            )}
                            <button
                              type="button"
                              disabled={actingId === r.id}
                              onClick={async () => {
                                if (r.source_type === 'bill_claim' && Number(r.current_step) === Number(r.total_steps)) {
                                  const claimAmount = r.source_amount != null ? Number(r.source_amount) : null;
                                  const draft = approvedAmountDraft[r.id];
                                  const startAmount = r.source_approved_amount != null ? Number(r.source_approved_amount) : claimAmount;
                                  const approvedAmount = Number(draft != null && draft !== '' ? draft : startAmount);
                                  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
                                    setMessage({ type: 'error', text: 'Approved Amount must be a positive number.' });
                                    return;
                                  }
                                  // A Layer may cut the amount but never raise it above what the previous Layer approved.
                                  const cap = startAmount != null ? Number(startAmount) : null;
                                  if (cap != null && approvedAmount > cap) {
                                    setMessage({
                                      type: 'error',
                                      text:
                                        r.source_approved_amount != null
                                          ? `Approved Amount can't be more than ৳${cap.toLocaleString('en-BD')} — the amount the previous Layer approved.`
                                          : "Approved Amount can't be more than the Claim Amount."
                                    });
                                    return;
                                  }
                                  if (
                                    r.conveyance_disburser_step &&
                                    !(await confirmDialog(`Disburse \u09f3${approvedAmount.toLocaleString('en-BD')} to ${r.requested_by_name || 'this employee'}? The claim is approved and marked paid.`, {
                                      title: 'Disburse conveyance',
                                      confirmLabel: 'Disburse'
                                    }))
                                  )
                                    return;
                                  handleAct(r.id, 'approved', approvedAmount);
                                } else {
                                  handleAct(r.id, 'approved');
                                }
                              }}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-1"
                            >
                              {actingId === r.id ? <Spinner size={12} /> : null}
                              {r.conveyance_disburser_step ? 'Disburse' : 'Approve'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
    );
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600" /> Approval Workflow
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              The Global Chain below reviews Remote Attendance Check In / Check Out — each one is recorded
              right away, this is a non-blocking review trail on top of that. Bill Claim, Leave,
              Timesheet, Asset and Vehicle requests follow their own Templates (Templates tab); they're
              listed here too under "All requests".
            </p>
          </div>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={openChainModal}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
            >
              <Settings2 className="w-3.5 h-3.5" /> Manage Chain
            </button>
          )}
        </div>

        {/* Chain preview */}
        <div className="flex flex-wrap items-center gap-2">
          {!chainLoaded ? null : chain.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-xl">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              No approval chain configured yet — check-ins/outs are being recorded but not routed to anyone.
              {isSuperAdmin ? ' Tap "Manage Chain" to set one up.' : ' Ask your Superadmin to set one up.'}
            </div>
          ) : (
            chain.map((step, idx) => (
              <React.Fragment key={step.id}>
                <div className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {step.step_order}
                  </span>
                  {step.user_name || `User #${step.user_id}`}
                </div>
                {idx < chain.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-slate-300" />}
              </React.Fragment>
            ))
          )}
        </div>

        {/* Queue filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex bg-slate-100 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setView('mine')}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                view === 'mine' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              Waiting on me
            </button>
            <button
              type="button"
              onClick={() => setView('all')}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                view === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              All requests
            </button>
          </div>
          {view === 'all' && (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          )}
        </div>

        {/* Search, request-type chips, Group by and Sort */}
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 flex-1 min-w-[220px] bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, Employee ID, department or details"
                aria-label="Search requests"
                className="bg-transparent text-xs outline-none flex-1 min-w-0"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
              Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as QueueGroup)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                <option value="type">Request type</option>
                <option value="who">Requested by</option>
                <option value="dept">Department</option>
                <option value="waiting">Waiting on</option>
                <option value="age">How long waiting</option>
                <option value="none">No grouping</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
              Sort
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as QueueSort)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                <option value="old">Longest waiting first</option>
                <option value="new">Newest first</option>
                <option value="amount">Amount — high to low</option>
                <option value="name">Name A–Z</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-pressed={showDetails}
              className="text-xs font-semibold px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {typeCounts.size > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Request type">
              {[['', requests.length] as [string, number], ...[...typeCounts.entries()].sort((a, b) => b[1] - a[1])].map(([t, n]) => {
                const on = t ? types.includes(t) : types.length === 0;
                return (
                  <button
                    key={t || 'all'}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTypes((prev) => (!t ? [] : prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                      on ? 'bg-[color:var(--g-accent,#ea580c)] border-[color:var(--g-accent,#ea580c)] text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {t || 'All'}
                    <span className={`text-[10px] px-1.5 rounded-full ${on ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {message && (
          <div
            className={`flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
              message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <LoadingBlock />
        ) : requests.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            {view === 'mine' ? "Nothing is waiting on you right now." : 'No approval requests yet.'}
          </div>
        ) : (
          <div>
            {groupBy === 'none'
              ? tableOf(shown)
              : groups.map(([k, list]) => {
                  const open = !collapsed.has(k);
                  const old = list.filter((r) => r.status === 'pending' && ageBand(r) === 'old').length;
                  const money = list.reduce((t, r) => t + (r.source_type === 'bill_claim' || r.source_type === 'advance_request' ? Number(r.source_amount) || 0 : 0), 0);
                  const quick = list.filter(canQuickApprove);
                  return (
                    <div key={k} className="border-t border-slate-200 first:border-t-0">
                      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-white hover:bg-slate-50">
                        <button type="button" onClick={() => toggleGroup(k)} aria-expanded={open} className="flex items-center gap-2 text-left min-w-0 flex-1">
                          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                          <span className="text-sm font-bold text-slate-900 truncate">{k}</span>
                          <span className="text-xs text-slate-500">{list.length}</span>
                        </button>
                        {old > 0 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">{old} waiting 3+ days</span>}
                        {money > 0 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">৳{money.toLocaleString('en-US')}</span>}
                        {quick.length > 0 && (
                          <button
                            type="button"
                            disabled={bulkBusy}
                            onClick={() => void approveAll(k, quick)}
                            className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            title="Approve the ones here that need nothing else filled in"
                          >
                            ✓ Approve all {quick.length}
                          </button>
                        )}
                      </div>
                      {open && tableOf(list)}
                    </div>
                  );
                })}
            {shown.length === 0 && <div className="p-10 text-center text-sm text-slate-400">Nothing matches this search or these filters.</div>}
          </div>
        )}
      </div>

      {/* Manage Chain modal — Superadmin only */}
      {showChainModal && (
        createPortal(
        <div className="liquid-glass-backdrop fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <div className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Manage Approval Chain</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Every Check In / Check Out goes to Step 1 first, then Step 2 once Step 1 approves, and so on.
                  Drag to reorder.
                </p>
              </div>
              <button
                onClick={() => setShowChainModal(false)}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 space-y-2">
              {chainDraft.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No approvers added yet.</p>
              )}
              {chainDraft.map((id, idx) => {
                const u = userMap.get(id);
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => setDragIndex(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== idx) moveInDraft(dragIndex, idx);
                      setDragIndex(null);
                    }}
                    className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-move"
                  >
                    <GripVertical className="w-4 h-4 text-slate-300 shrink-0" />
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{u?.name || `User #${id}`}</div>
                      <div className="text-[11px] text-slate-500 truncate">{u?.email || u?.username || u?.role}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromChainDraft(id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}

              <div className="flex gap-2 pt-2">
                <SearchSelect
                  value={addApproverId}
                  onChange={(e) => setAddApproverId(e.target.value)}
                  className="flex-1 text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">Add an approver…</option>
                  {eligibleApprovers
                    .filter((u) => !chainDraft.includes(u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>{personLabel(u)}</option>
                    ))}
                </SearchSelect>
                <button
                  type="button"
                  onClick={addToChainDraft}
                  disabled={!addApproverId}
                  className="flex items-center gap-1 text-xs font-semibold px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>

              {chainError && <p className="text-xs text-rose-600">{chainError}</p>}
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-between items-center">
              <button
                type="button"
                onClick={() => setChainDraft([])}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700"
              >
                Clear Chain
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowChainModal(false)}
                  className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveChain}
                  disabled={savingChain}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
                >
                  {savingChain ? 'Saving...' : 'Save Chain'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )
      )}
    </div>
  );
};