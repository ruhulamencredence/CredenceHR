/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ShieldCheck, Inbox, CheckCircle2, XCircle, RefreshCw, MapPin } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { UserClaimReference, ClaimRecord } from '../types';
import ClaimLocationMap from './ClaimLocationMap';

interface ApproveApplicationsProps {
  token: string;
  onBack: () => void;
}

// One row from GET /api/my-approvals — see PendingApprovalsCard.tsx for the
// original, narrower version of this same shape.
interface MyApprovalItem {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction' | 'leave_application' | 'leave_reliever' | 'exit_clearance';
  source_id: number;
  source_label: string;
  source_amount: number | null;
  requested_by: number;
  requested_by_name: string | null;
  current_step: number | null;
  total_steps: number | null;
  created_at: string;
  // Only present on a 'user_claim' item — every Movement Claim (check-in/out)
  // this Conveyance Bill Claim's Amount was built from, each with its own
  // location, so the approver can see exactly where it happened before
  // deciding. Empty/absent when the claim has no Movement Claim attached
  // (a plain hand-entered Amount).
  claim_refs?: UserClaimReference[];
  // Running Approved Amount — set once an EARLIER Layer (e.g. the
  // Department/Direct Supervisor auto-layer at step 1) has already edited
  // it on a still-pending 'user_claim'. Used as this Layer's pre-fill
  // instead of the full Claim Amount, so a partial-approval edit carries
  // forward through the rest of the chain. Null until someone has edited it.
  source_approved_amount?: number | null;
}

const sourceTitle = (t: MyApprovalItem['source_type']) =>
  t === 'user_claim'
    ? 'Conveyance Bill Claim'
    : t === 'attendance_correction'
    ? 'Timesheet Correction'
    : t === 'leave_application'
    ? 'Leave Application'
    : t === 'leave_reliever'
    ? 'Leave Application \u2014 Reliever Review'
    : t === 'attendance'
    ? 'Remote Attendance'
    : t === 'exit_clearance'
    ? 'Exit Clearance'
    : 'Movement Claim';

// "Self Service" -> "Approve Application" — reachable from the Navbar/Sidebar
// like Leave Application/Timesheet, but NOT gated to Admin Panel access or any
// role: shown to every logged-in account, the same "Role Permissiveness"
// philosophy as the Dashboard's Pending Approvals card (PendingApprovalsCard,
// still shown there too — this is the same data as a dedicated full page
// instead of a small card), because a Template Layer or a Leave Application's
// Reliever can be ANY account, role='user' included. Pulls every request
// currently waiting on this account across every workflow (Remote Attendance,
// Conveyance Bill Claim, Timesheet Correction, Leave Application, and Leave
// Application Reliever review, and Exit/Offboarding Clearance) from GET
// /api/my-approvals and lets them Approve/Reject right here. A
// 'leave_reliever' item is routed to its own POST
// /api/leave-applications/:id/reliever-decision, and an 'exit_clearance' item
// to its own POST /api/exit-clearance-items/:id/decision, instead of the
// generic POST /api/my-approvals/:id/act every other source_type uses, since
// neither is an approval_requests row — see the design note on GET
// /api/my-approvals server-side.
export const ApproveApplications: React.FC<ApproveApplicationsProps> = ({ token, onBack }) => {
  // Same isNativeApp split as LeaveManagement.tsx / LeaveApprovals.tsx: the
  // web build keeps the module-path breadcrumb + Back button, the Android
  // APK build hides both — the bottom nav is the only way to leave this
  // section there.
  const isNativeApp = Capacitor.isNativePlatform();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [items, setItems] = useState<MyApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Approved Amount draft for a 'user_claim' item — editable on EVERY Layer,
  // not just the last one (so the Supervisor auto-layer, or any earlier
  // Template Layer, can partially-approve just like the final approver
  // always could). Pre-filled with source_approved_amount when an earlier
  // Layer already set one, otherwise the full Claim Amount (approve as
  // claimed by default). Remaining Amount is derived from this, never its
  // own state. Edits made on a non-final Layer are recorded as a running
  // draft server-side (see updateUserClaimApprovedAmountDraft) and carry
  // forward as the next Layer's pre-fill.
  const [approvedAmountDraft, setApprovedAmountDraft] = useState<Record<string, string>>({});
  // The referenced Movement Claim currently shown on the read-only location
  // map (opened by tapping a claim_refs row below) — same ClaimLocationMap
  // every other Conveyance Bill Claim view (ConveyanceClaimCard, the Admin
  // Panel's Conveyance Bill Claim tab) already reuses for this.
  const [viewingRef, setViewingRef] = useState<{ ref: UserClaimReference; item: MyApprovalItem } | null>(null);

  const refToClaimRecord = (ref: UserClaimReference, item: MyApprovalItem): ClaimRecord => ({
    id: ref.claim_id,
    user_id: item.requested_by,
    user_name: item.requested_by_name,
    purpose: ref.purpose,
    status: ref.check_out_at ? 'completed' : 'open',
    check_in_at: ref.check_in_at,
    check_in_lat: Number(ref.check_in_lat),
    check_in_lng: Number(ref.check_in_lng),
    check_out_at: ref.check_out_at,
    check_out_lat: ref.check_out_lat != null ? Number(ref.check_out_lat) : null,
    check_out_lng: ref.check_out_lng != null ? Number(ref.check_out_lng) : null,
    distance_km: ref.distance_km,
    check_in_approval: ref.check_in_approval,
    check_out_approval: ref.check_out_approval
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/my-approvals'), { headers: authHeaders });
      if (res.ok) setItems(await res.json());
    } catch {
      // Offline/unreachable — list just stays with whatever it already had.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const keyFor = (item: MyApprovalItem) => `${item.source_type}-${item.id}`;

  const handleAct = async (item: MyApprovalItem, action: 'approved' | 'rejected', approvedAmount?: number) => {
    const key = keyFor(item);
    setActingKey(key);
    setMessage(null);
    try {
      const url =
        item.source_type === 'leave_reliever'
          ? apiUrl(`/api/leave-applications/${item.id}/reliever-decision`)
          : item.source_type === 'exit_clearance'
          ? apiUrl(`/api/exit-clearance-items/${item.id}/decision`)
          : apiUrl(`/api/my-approvals/${item.id}/act`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          action,
          remarks: remarksDraft[key] || undefined,
          approved_amount: action === 'approved' && approvedAmount != null ? approvedAmount : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
      setRemarksDraft((prev) => ({ ...prev, [key]: '' }));
      setApprovedAmountDraft((prev) => ({ ...prev, [key]: '' }));
      setItems((prev) => prev.filter((i) => keyFor(i) !== key));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingKey(null);
    }
  };

  // Wraps handleAct('approved', ...) with the same Approved Amount validation
  // the Admin Panel's Approvals tab uses — relevant for a 'user_claim' item
  // on ANY Layer (Supervisor auto-layer included), not just the last one;
  // every other item just approves as-is.
  const handleApprove = (item: MyApprovalItem) => {
    const key = keyFor(item);
    if (item.source_type === 'user_claim') {
      const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
      const draft = approvedAmountDraft[key];
      const fallback = item.source_approved_amount != null ? item.source_approved_amount : claimAmount;
      const approvedAmount = Number(draft != null && draft !== '' ? draft : fallback);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        setMessage({ type: 'error', text: 'Approved Amount must be a positive number.' });
        return;
      }
      if (claimAmount != null && approvedAmount > claimAmount) {
        setMessage({ type: 'error', text: "Approved Amount can't be more than the Claim Amount." });
        return;
      }
      handleAct(item, 'approved', approvedAmount);
    } else {
      handleAct(item, 'approved');
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Approve Application']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-slate-100 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">
                  Approve Application
                  {items.length > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold align-middle">
                      {items.length}
                    </span>
                  )}
                </h1>
                <p className="text-xs text-slate-500">Requests waiting on your approval, across every workflow you're a part of.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {message && (
            <div
              className={`mx-6 mt-4 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
                message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
              }`}
            >
              {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
              <span>{message.text}</span>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-sm">Nothing waiting on you right now.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {items.map((item) => {
                const key = keyFor(item);
                // Editable on EVERY Layer now (Supervisor auto-layer included),
                // not just the last one — see the state comment above.
                const editable = item.source_type === 'user_claim';
                const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
                // Pre-fill: an earlier Layer's running draft if one exists,
                // otherwise the full Claim Amount.
                const runningAmount = item.source_approved_amount != null ? Number(item.source_approved_amount) : claimAmount;
                const fmt = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;
                const draft = approvedAmountDraft[key];
                const approvedAmount =
                  editable && runningAmount != null
                    ? (() => {
                        const parsed = Number(draft != null && draft !== '' ? draft : runningAmount);
                        return Number.isFinite(parsed) ? parsed : null;
                      })()
                    : null;
                const remainingAmount = claimAmount != null && approvedAmount != null ? claimAmount - approvedAmount : null;
                return (
                  <div key={key} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-800">{sourceTitle(item.source_type)}</span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {item.source_label}
                          {!editable && item.source_amount != null && <> &middot; ৳{item.source_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</>}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-1">
                          From {item.requested_by_name || `User #${item.requested_by}`}
                          {item.total_steps ? <> &middot; Layer {item.current_step} of {item.total_steps}</> : null}
                        </p>

                        {item.source_type === 'user_claim' && item.claim_refs && item.claim_refs.length > 0 && (
                          <div className="mt-2 space-y-1 max-w-md">
                            {item.claim_refs.map((r) => (
                              <button
                                key={r.claim_id}
                                type="button"
                                onClick={() => setViewingRef({ ref: r, item })}
                                title="View check-in/out location"
                                className="w-full flex items-center justify-between gap-2 text-[11px] px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors text-left"
                              >
                                <span className="flex items-center gap-1 text-slate-600 min-w-0 truncate">
                                  <MapPin className="w-3 h-3 text-blue-500 shrink-0" />
                                  Movement Claim &middot; {r.purpose}
                                </span>
                                <span className="shrink-0 font-semibold text-slate-800">
                                  ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {editable && (
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Claim Amount</div>
                          <div className="font-semibold text-slate-800">{claimAmount != null ? fmt(claimAmount) : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Approved Amount</div>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={claimAmount ?? undefined}
                            value={draft ?? (runningAmount != null ? String(runningAmount) : '')}
                            onChange={(e) => setApprovedAmountDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                            className="w-full text-xs px-2 py-1 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Remaining Amount</div>
                          <div className="font-semibold text-slate-800">{remainingAmount != null ? fmt(remainingAmount) : '—'}</div>
                        </div>
                      </div>
                    )}

                    <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                      <input
                        type="text"
                        placeholder="Remarks (optional)"
                        value={remarksDraft[key] || ''}
                        onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                        className="flex-1 min-w-[160px] text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={actingKey === key}
                          onClick={() => handleAct(item, 'rejected')}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 font-semibold disabled:opacity-50 transition-colors"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                        <button
                          type="button"
                          disabled={actingKey === key}
                          onClick={() => handleApprove(item)}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {actingKey === key ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                          Approve
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {viewingRef && (
        <ClaimLocationMap claim={refToClaimRecord(viewingRef.ref, viewingRef.item)} onClose={() => setViewingRef(null)} />
      )}
    </div>
  );
};