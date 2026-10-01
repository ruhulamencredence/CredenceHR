/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck, CheckCircle2, XCircle, AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

// One row from GET /api/my-approvals — a trimmed-down ApprovalRequest, same
// shape PendingApprovalsCard.tsx (the Dashboard card version of this) uses.
interface MyApprovalItem {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction' | 'leave_application';
  source_id: number;
  source_label: string;
  source_amount: number | null;
  requested_by: number;
  requested_by_name: string | null;
  current_step: number;
  total_steps: number;
  created_at: string;
}

interface ApproveApplicationPageProps {
  token: string;
  // Same "Back to Menu" pattern every other Self Service page uses
  // (LeaveReviewPage, Timesheet, ...) — this page takes over the whole
  // screen (mobile section and/or desktop Self Service target), so it's
  // always passed here.
  onBack: () => void;
}

const sourceTitle = (t: MyApprovalItem['source_type']) =>
  t === 'user_claim'
    ? 'Conveyance Bill Claim'
    : t === 'attendance_correction'
    ? 'Timesheet Correction'
    : t === 'leave_application'
    ? 'Leave Application'
    : t === 'attendance'
    ? 'Remote Attendance'
    : 'Movement Claim';

// Self Service -> "Approve Application" — a dedicated, always-reachable page
// for exactly the same personal approval queue PendingApprovalsCard.tsx shows
// on the Dashboard, just given its own menu item (Navbar's Self Service
// dropdown / GlobalSidebar's drawer / App.tsx's selfServiceView) instead of
// only living inline on the Dashboard.
//
// Deliberately NOT gated by role or module_permissions (unlike "Leave
// Approvals", which only admin/superadmin see): the backend's
// GET/POST /api/my-approvals routes are already open to every authenticated
// account and only return/act on requests where the caller is genuinely one
// of the current step's approvers on some Approval Template — so a plain
// Employee who's been named an approver can use this page too, without ever
// getting access to the wider Approvals module (Templates/Chain config,
// Admin Panel's queue). Same data source, same action endpoint — just a
// standalone page instead of a Dashboard card.
export const ApproveApplicationPage: React.FC<ApproveApplicationPageProps> = ({ token, onBack }) => {
  const [items, setItems] = useState<MyApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/my-approvals'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setItems(await res.json());
    } catch {
      // Offline/unreachable — page just shows whatever it already had (or
      // stays empty); pull-to-refresh / the Refresh button retries once
      // connectivity's back.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleAct = async (id: number, action: 'approved' | 'rejected') => {
    setActingId(id);
    setMessage(null);
    try {
      const res = await fetch(apiUrl(`/api/my-approvals/${id}/act`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, remarks: remarksDraft[id] || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
      setRemarksDraft((prev) => ({ ...prev, [id]: '' }));
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden max-w-2xl mx-auto md:mt-6">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Menu
        </button>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="px-5 pt-4 sm:px-6">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-600" /> Approve Application
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

      <div className="px-5 sm:px-6 py-4">
        {loading && items.length === 0 ? (
          <div className="p-8 flex justify-center">
            <Spinner size={18} className="text-slate-400" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 text-center py-10 text-slate-400">
            <Inbox className="w-6 h-6 text-slate-300" />
            <p className="text-xs font-semibold text-slate-500">Nothing waiting on you right now.</p>
            <p className="text-[11px] text-slate-400 max-w-[240px]">
              Anything routed to you as an approver on any workflow will show up here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="border border-slate-200 rounded-xl p-3.5 flex flex-col gap-2.5">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{sourceTitle(item.source_type)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {item.source_label}
                    {item.source_amount != null && <> &middot; ৳{item.source_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</>}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    From {item.requested_by_name || `User #${item.requested_by}`} &middot; Layer {item.current_step} of {item.total_steps}
                    {item.created_at && <> &middot; {formatDate(item.created_at)}</>}
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
                    onClick={() => handleAct(item.id, 'rejected')}
                    className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                  <button
                    type="button"
                    disabled={actingId === item.id}
                    onClick={() => handleAct(item.id, 'approved')}
                    className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1"
                  >
                    {actingId === item.id ? <Spinner size={12} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
