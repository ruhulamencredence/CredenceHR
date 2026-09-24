import React, { useEffect, useState } from 'react';
import {
  ShieldCheck, ArrowRight, CheckCircle2, XCircle, Clock, Settings2, X, GripVertical, Trash2, Plus, AlertCircle
} from 'lucide-react';
import { ApprovalRequest, ApprovalChainStep, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

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
// recorded — this is purely the review trail). A Conveyance Bill Claim (User
// Panel -> Conveyance Bill Claim) ALSO routes through this same chain, but is
// NOT non-blocking: the claim only becomes a real Conveyance Bill line item the
// moment the LAST step here Approves it (see the optional Bill picker below),
// and is freed up again if Rejected at any step. Movement Claims (the live
// GPS check-in/out card) do NOT go through this chain at all — no approval is
// required for a Movement Claim Check In/Out. Any Admin/Superadmin granted the
// "approvals" module can see the queue and act at their own step; only a
// Superadmin can edit the chain itself.
export const ApprovalManager: React.FC<ApprovalManagerProps> = ({ token, user, users }) => {
  const isSuperAdmin = user.role === 'superadmin';

  const [chain, setChain] = useState<ApprovalChainStep[]>([]);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'mine' | 'all'>('mine');
  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'approved' | 'rejected'>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  // Only relevant for a 'user_claim' request on its LAST step — which existing
  // Conveyance Bill (for that same User) to attach it to on Approve. Left blank
  // to auto-create a new Bill, same default POST /api/approvals/:id/act uses.
  const [billChoice, setBillChoice] = useState<Record<number, string>>({});
  const [userBillsCache, setUserBillsCache] = useState<Record<number, { id: number; bill_date: string }[]>>({});
  // Approved Amount draft for a 'user_claim' request's LAST step — pre-filled
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
  // Only Admins/Superadmins are eligible to be added to the chain.
  const eligibleApprovers = users.filter((u) => u.role === 'admin' || u.role === 'superadmin');

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

  const handleAct = async (id: number, action: 'approved' | 'rejected', approvedAmount?: number) => {
    setActingId(id);
    setMessage(null);
    try {
      const bill_id = billChoice[id] ? Number(billChoice[id]) : undefined;
      const res = await fetch(apiUrl(`/api/approvals/${id}/act`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action,
          remarks: remarksDraft[id] || undefined,
          bill_id,
          approved_amount: action === 'approved' && approvedAmount != null ? approvedAmount : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
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

  // Lazily loads a User's existing Conveyance Bills the first time a 'user_claim'
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

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600" /> Approval Workflow
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Every Check In / Check Out for Remote Attendance is recorded right away — this is a
              non-blocking review trail on top of that. A Conveyance Bill Claim is different: it only becomes a real
              Bill once the last step here Approves it. Movement Claims don't route through here at all.
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
          {chain.length === 0 ? (
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
          <div className="p-10 flex justify-center">
            <Spinner size={20} className="text-slate-400" />
          </div>
        ) : requests.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            {view === 'mine' ? "Nothing is waiting on you right now." : 'No approval requests yet.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Event</th>
                <th className="text-left px-4 py-3 font-semibold">Claim Amount</th>
                <th className="text-left px-4 py-3 font-semibold">Approved Amount</th>
                <th className="text-left px-4 py-3 font-semibold">Remaining Amount</th>
                <th className="text-left px-4 py-3 font-semibold">Requested By</th>
                <th className="text-left px-4 py-3 font-semibold">Progress</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold">When</th>
                <th className="text-right px-4 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.map((r) => {
                const canAct = r.status === 'pending' && (isSuperAdmin || (r.current_approver_ids || []).includes(user.id));
                return (
                  <tr key={r.id} className="hover:bg-slate-50/60 align-top">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">
                        {r.source_type === 'attendance'
                          ? 'Remote Attendance'
                          : r.source_type === 'user_claim'
                          ? 'Conveyance Bill Claim'
                          : r.source_type === 'attendance_correction'
                          ? 'Attendance Correction'
                          : r.source_type === 'leave_application'
                          ? 'Leave Application'
                          : r.source_type === 'asset_requisition'
                          ? 'Asset Requisition'
                          : r.source_type === 'vehicle_requisition'
                          ? 'Vehicle Requisition'
                          : 'Movement Claim'}
                        {' — '}
                        {r.source_type === 'attendance_correction' || r.source_type === 'leave_application' || r.source_type === 'asset_requisition' || r.source_type === 'vehicle_requisition'
                          ? 'Requested'
                          : r.event_type === 'check_in'
                          ? 'Check In'
                          : r.event_type === 'check_out'
                          ? 'Check Out'
                          : 'Submitted'}
                      </div>
                      <div className="text-xs text-slate-500">{r.source_label}</div>
                      {r.source_type === 'user_claim' && r.source_category && (
                        <div className="text-xs text-slate-500">{r.source_category}</div>
                      )}
                    </td>
                    {(() => {
                      // Only a 'user_claim' request finishing its LAST step is
                      // where an Approve actually finalizes an Approved Amount
                      // (see finalizeUserClaimApproval) — that's the only case
                      // this row lets the approver type one in. Everywhere else
                      // (other source types, an earlier step, already decided)
                      // these three columns just show what's known, or a dash.
                      const isUserClaim = r.source_type === 'user_claim';
                      const isLastStep = Number(r.current_step) === Number(r.total_steps);
                      const editable = isUserClaim && canAct && r.status === 'pending' && isLastStep;
                      const claimAmount = r.source_amount != null ? Number(r.source_amount) : null;
                      const fmt = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;
                      let approvedAmount: number | null = null;
                      if (r.status === 'approved') {
                        approvedAmount = r.source_approved_amount != null ? Number(r.source_approved_amount) : claimAmount;
                      } else if (editable) {
                        const draft = approvedAmountDraft[r.id];
                        const parsed = Number(draft != null && draft !== '' ? draft : claimAmount);
                        approvedAmount = Number.isFinite(parsed) ? parsed : null;
                      }
                      const remainingAmount = claimAmount != null && approvedAmount != null ? claimAmount - approvedAmount : null;
                      return (
                        <>
                          <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                            {isUserClaim && claimAmount != null ? fmt(claimAmount) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            {editable ? (
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                max={claimAmount ?? undefined}
                                value={approvedAmountDraft[r.id] ?? (claimAmount != null ? String(claimAmount) : '')}
                                onChange={(e) => setApprovedAmountDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                className="w-28 text-xs px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                              />
                            ) : isUserClaim && approvedAmount != null ? (
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
                    <td className="px-4 py-3 text-slate-700">{r.requested_by_name || `User #${r.requested_by}`}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      Step {r.current_step} of {r.total_steps}
                      {r.status === 'pending' && r.current_approver_name && (
                        <div className="text-slate-400">Waiting on {r.current_approver_name}</div>
                      )}
                      {r.actions.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {r.actions.map((a, i) => (
                            <div key={i} className={a.action === 'approved' ? 'text-emerald-600' : 'text-rose-600'}>
                              {a.approver_name} {a.action === 'approved' ? 'approved' : 'rejected'}
                              {a.remarks ? ` — "${a.remarks}"` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-3">
                      {canAct ? (
                        <div className="flex flex-col items-end gap-1.5">
                          {r.source_type === 'user_claim' && Number(r.current_step) === Number(r.total_steps) && (
                            <select
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
                            </select>
                          )}
                          <input
                            type="text"
                            placeholder="Remarks (optional)"
                            value={remarksDraft[r.id] || ''}
                            onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            className="w-40 text-xs px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              disabled={actingId === r.id}
                              onClick={() => handleAct(r.id, 'rejected')}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              disabled={actingId === r.id}
                              onClick={() => {
                                if (r.source_type === 'user_claim' && Number(r.current_step) === Number(r.total_steps)) {
                                  const claimAmount = r.source_amount != null ? Number(r.source_amount) : null;
                                  const draft = approvedAmountDraft[r.id];
                                  const approvedAmount = Number(draft != null && draft !== '' ? draft : claimAmount);
                                  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
                                    setMessage({ type: 'error', text: 'Approved Amount must be a positive number.' });
                                    return;
                                  }
                                  if (claimAmount != null && approvedAmount > claimAmount) {
                                    setMessage({ type: 'error', text: "Approved Amount can't be more than the Claim Amount." });
                                    return;
                                  }
                                  handleAct(r.id, 'approved', approvedAmount);
                                } else {
                                  handleAct(r.id, 'approved');
                                }
                              }}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-1"
                            >
                              {actingId === r.id ? <Spinner size={12} /> : null}
                              Approve
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
        )}
      </div>

      {/* Manage Chain modal — Superadmin only */}
      {showChainModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
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
                <select
                  value={addApproverId}
                  onChange={(e) => setAddApproverId(e.target.value)}
                  className="flex-1 text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">Add an approver…</option>
                  {eligibleApprovers
                    .filter((u) => !chainDraft.includes(u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                </select>
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
        </div>
      )}
    </div>
  );
};