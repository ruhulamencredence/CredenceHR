import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

// One row from GET /api/my-approvals — a trimmed-down ApprovalRequest, just
// enough for this card (see server.ts for the full shape).
interface MyApprovalItem {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction' | 'leave_application' | 'leave_reliever';
  source_id: number;
  source_label: string;
  source_amount: number | null;
  requested_by: number;
  requested_by_name: string | null;
  current_step: number;
  total_steps: number;
  created_at: string;
}

interface PendingApprovalsCardProps {
  token: string;
  // Applied to this card's own root element rather than a wrapper around it —
  // used by UserPanel's desktop Dashboard grid to set this card's column span.
  // A wrapper wouldn't work: this card renders nothing at all when no approval
  // is waiting (see below), and an empty wrapper would still claim a grid cell
  // and punch a hole in the row.
  className?: string;
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
    : 'Movement Claim';

// Dashboard "Pending Approvals" card (Part 4 — Role Permissiveness) — shown to
// EVERY logged-in account, regardless of Admin Panel access, whenever they've
// been named an approver on a Template step (see Part 2) and something is
// currently sitting on their step. Renders nothing at all if there's nothing
// waiting on this account, so it never clutters the Dashboard for the vast
// majority of accounts that are never an approver. Deliberately simpler than
// the full Admin Panel -> Approvals queue: no Bill-picker on a Conveyance
// Bill Claim's last step — Approving here always auto-creates a fresh Bill
// (open the Admin Panel queue instead if you need to attach it to an
// existing one).
export const PendingApprovalsCard: React.FC<PendingApprovalsCardProps> = ({ token, className = '' }) => {
  const [items, setItems] = useState<MyApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    try {
      const res = await fetch(apiUrl('/api/my-approvals'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setItems(await res.json());
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

  const handleAct = async (item: MyApprovalItem, action: 'approved' | 'rejected') => {
    const id = item.id;
    setActingId(id);
    setMessage(null);
    try {
      // Reliever-review items aren't rows in approval_requests yet (see
      // GET /api/my-approvals) — they're decided via their own dedicated
      // route on the Leave Application itself, not the generic
      // /api/my-approvals/:id/act used by every other source_type here.
      const url =
        item.source_type === 'leave_reliever'
          ? apiUrl(`/api/leave-applications/${id}/reliever-decision`)
          : apiUrl(`/api/my-approvals/${id}/act`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, remarks: remarksDraft[id] || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
      setRemarksDraft((prev) => ({ ...prev, [id]: '' }));
      setItems((prev) => prev.filter((i) => !(i.id === id && i.source_type === item.source_type)));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingId(null);
    }
  };

  // Stay out of the way entirely unless there's actually something waiting on
  // this account — including while the first fetch is still in flight. This
  // card is hidden for the vast majority of accounts (most people are never an
  // approver), so rendering an empty shell + spinner during that fetch meant
  // every page load flashed a "Pending Approvals" card that vanished a moment
  // later. Waiting costs nothing: there's no card to hold a place for.
  if (loading || items.length === 0) return null;

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

      <div className="divide-y divide-slate-100">
        {items.map((item) => (
          <div key={`${item.source_type}-${item.id}`} className="p-5 sm:px-6 flex flex-col gap-2.5">
            <div>
              <div className="text-sm font-semibold text-slate-900">{sourceTitle(item.source_type)}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {item.source_label}
                {item.source_amount != null && <> &middot; ৳{item.source_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</>}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                From {item.requested_by_name || `User #${item.requested_by}`}
                {item.total_steps ? <> &middot; Layer {item.current_step} of {item.total_steps}</> : null}
              </div>
            </div>
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
                onClick={() => handleAct(item, 'approved')}
                className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1"
              >
                {actingId === item.id ? <Spinner size={12} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
