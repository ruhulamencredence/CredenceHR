import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, AlertCircle, MapPin, ChevronRight, ArrowLeft } from 'lucide-react';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import { Spinner } from './Spinner';
import { UserClaimReference, ClaimRecord } from '../types';
import ClaimLocationMap from './ClaimLocationMap';

// One row from GET /api/my-approvals — a trimmed-down ApprovalRequest, just
// enough for this card (see server.ts for the full shape).
interface MyApprovalItem {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction' | 'leave_application' | 'leave_reliever' | 'exit_clearance';
  source_id: number;
  source_label: string;
  source_amount: number | null;
  requested_by: number;
  requested_by_name: string | null;
  current_step: number;
  total_steps: number;
  created_at: string;
  // Only present on a 'user_claim' item — every Movement Claim (check-in/out)
  // this Conveyance Bill Claim's Amount was built from, so the approver can
  // open the full check-in/check-out details (including location) before
  // deciding. See ApproveApplications.tsx for the original of this pattern.
  claim_refs?: UserClaimReference[];
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
    ? 'Leave Application — Reliever Review'
    : t === 'attendance'
    ? 'Remote Attendance'
    : t === 'exit_clearance'
    ? 'Exit Clearance'
    : 'Movement Claim';

interface PendingApprovalsCardProps {
  token: string;
  // Applied to this card's own root element rather than a wrapper around it —
  // used by UserPanel's desktop Dashboard grid to set this card's column span.
  // A wrapper wouldn't work: this card renders nothing at all when no approval
  // is waiting (see below), and an empty wrapper would still claim a grid cell
  // and punch a hole in the row.
  className?: string;
}

// Dashboard "Pending Approvals" card (Part 4 — Role Permissiveness) — shown to
// EVERY logged-in account, regardless of Admin Panel access, whenever they've
// been named an approver on a Template step (see Part 2) and something is
// currently sitting on their step. Renders nothing at all if there's nothing
// waiting on this account, so it never clutters the Dashboard for the vast
// majority of accounts that are never an approver.
//
// Grouped by category (source_type) instead of one flat list of individual
// request cards: a category card shows just the type + how many are waiting,
// and tapping it opens that category's own list right here (no navigation
// away from the Dashboard) — the same per-item Approve/Reject UI, including
// the Conveyance Bill Claim's Movement Claim (check-in/out) location viewer,
// as the full "Approve Application" page (ApproveApplications.tsx).
export const PendingApprovalsCard: React.FC<PendingApprovalsCardProps> = ({ token, className = '' }) => {
  const [items, setItems] = useState<MyApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const [approvedAmountDraft, setApprovedAmountDraft] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [openCategory, setOpenCategory] = useState<MyApprovalItem['source_type'] | null>(null);
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
    try {
      // This card mounts twice on every Dashboard load (mobile + desktop
      // copies, see UserPanel.tsx) — dedupedFetchJson means only one of the
      // two actually hits the network.
      const rows = await dedupedFetchJson(apiUrl('/api/my-approvals'), token);
      if (rows) setItems(rows);
    } catch {
      // Offline/unreachable — card just stays with whatever it already had.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Auto-close back to the category grid once the open category's last item
  // has been approved/rejected, rather than leaving an empty list open.
  useEffect(() => {
    if (openCategory && !items.some((i) => i.source_type === openCategory)) {
      setOpenCategory(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const handleAct = async (item: MyApprovalItem, action: 'approved' | 'rejected', approvedAmount?: number) => {
    const id = item.id;
    setActingId(id);
    setMessage(null);
    try {
      // Reliever-review and Exit Clearance items aren't rows in
      // approval_requests — they're decided via their own dedicated routes,
      // not the generic /api/my-approvals/:id/act every other source_type
      // here uses (see GET /api/my-approvals server-side).
      const url =
        item.source_type === 'leave_reliever'
          ? apiUrl(`/api/leave-applications/${id}/reliever-decision`)
          : item.source_type === 'exit_clearance'
          ? apiUrl(`/api/exit-clearance-items/${id}/decision`)
          : apiUrl(`/api/my-approvals/${id}/act`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action,
          remarks: remarksDraft[id] || undefined,
          approved_amount: action === 'approved' && approvedAmount != null ? approvedAmount : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
      setRemarksDraft((prev) => ({ ...prev, [id]: '' }));
      setApprovedAmountDraft((prev) => ({ ...prev, [id]: '' }));
      setItems((prev) => prev.filter((i) => !(i.id === id && i.source_type === item.source_type)));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingId(null);
    }
  };

  // Same Approved Amount validation the full Approve Application page uses —
  // relevant for a 'user_claim' item on ANY Layer; every other item type just
  // approves as-is.
  const handleApprove = (item: MyApprovalItem) => {
    if (item.source_type === 'user_claim') {
      const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
      const draft = approvedAmountDraft[item.id];
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

  // Stay out of the way entirely unless there's actually something waiting on
  // this account — including while the first fetch is still in flight. This
  // card is hidden for the vast majority of accounts (most people are never an
  // approver), so rendering an empty shell + spinner during that fetch meant
  // every page load flashed a "Pending Approvals" card that vanished a moment
  // later. Waiting costs nothing: there's no card to hold a place for.
  if (loading || items.length === 0) return null;

  // Group into categories (by source_type) — a category card per workflow
  // type, showing just the count, instead of every individual request as its
  // own card.
  const categoryOrder: MyApprovalItem['source_type'][] = [
    'user_claim',
    'leave_application',
    'leave_reliever',
    'attendance',
    'attendance_correction',
    'exit_clearance',
    'claim'
  ];
  const byCategory = new Map<MyApprovalItem['source_type'], MyApprovalItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.source_type) || [];
    list.push(item);
    byCategory.set(item.source_type, list);
  }
  const categories = categoryOrder.filter((c) => byCategory.has(c));

  const openItems = openCategory ? byCategory.get(openCategory) || [] : [];

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-600" /> Pending Approvals
          {items.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold">
              {items.length}
            </span>
          )}
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">Requests waiting on your approval, across every workflow you're a Layer on.</p>
      </div>

      {message && (
        <div
          className={`mx-5 sm:mx-6 mt-4 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
            message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      {!openCategory ? (
        <div className="p-5 sm:px-6 grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {categories.map((cat) => {
            const list = byCategory.get(cat) || [];
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setOpenCategory(cat)}
                className="flex flex-col items-start gap-1.5 text-left p-3.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 transition-colors"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-blue-600 text-white text-xs font-bold">
                    {list.length}
                  </span>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </div>
                <span className="text-xs font-semibold text-slate-800 leading-tight">{sourceTitle(cat)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setOpenCategory(null)}
            className="w-full flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-blue-600 px-5 sm:px-6 pt-4 pb-2 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All categories &middot; {sourceTitle(openCategory)}
          </button>
          <div className="divide-y divide-slate-100">
            {openItems.map((item) => {
              const editable = item.source_type === 'user_claim';
              const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
              const runningAmount = item.source_approved_amount != null ? Number(item.source_approved_amount) : claimAmount;
              const fmt = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;
              const draft = approvedAmountDraft[item.id];
              const approvedAmount =
                editable && runningAmount != null
                  ? (() => {
                      const parsed = Number(draft != null && draft !== '' ? draft : runningAmount);
                      return Number.isFinite(parsed) ? parsed : null;
                    })()
                  : null;
              const remainingAmount = claimAmount != null && approvedAmount != null ? claimAmount - approvedAmount : null;

              return (
                <div key={item.id} className="p-5 sm:px-6 flex flex-col gap-2.5">
                  <div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {item.source_label}
                      {!editable && item.source_amount != null && (
                        <> &middot; ৳{item.source_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      From {item.requested_by_name || `User #${item.requested_by}`}
                      {item.total_steps ? <> &middot; Layer {item.current_step} of {item.total_steps}</> : null}
                    </div>

                    {item.source_type === 'user_claim' && item.claim_refs && item.claim_refs.length > 0 && (
                      <div className="mt-2 space-y-1">
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

                  {editable && (
                    <div className="grid grid-cols-3 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5">
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
                          onChange={(e) => setApprovedAmountDraft((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          className="w-full text-xs px-2 py-1 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Remaining Amount</div>
                        <div className="font-semibold text-slate-800">{remainingAmount != null ? fmt(remainingAmount) : '—'}</div>
                      </div>
                    </div>
                  )}

                  <input
                    type="text"
                    placeholder="Remarks (optional)"
                    value={remarksDraft[item.id] || ''}
                    onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="w-full text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => handleAct(item, 'rejected')}
                      className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1"
                    >
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </button>
                    <button
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => handleApprove(item)}
                      className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1"
                    >
                      {actingId === item.id ? <Spinner size={12} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewingRef && (
        <ClaimLocationMap claim={refToClaimRecord(viewingRef.ref, viewingRef.item)} onClose={() => setViewingRef(null)} />
      )}
    </div>
  );
};
