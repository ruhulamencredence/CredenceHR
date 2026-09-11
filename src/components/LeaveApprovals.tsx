/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, CheckSquare, Inbox, Check, X, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { LeaveApplication, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface LeaveApprovalsProps {
  token: string;
  user: User;
  onBack: () => void;
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  casual: 'Casual Leave',
  sick: 'Sick Leave',
  without_pay: 'Leave Without Pay'
};

const StatusBadge: React.FC<{ status: LeaveApplication['status'] }> = ({ status }) => {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-2.5 h-2.5" /> Approved
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
        <XCircle className="w-2.5 h-2.5" /> Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
      <Clock className="w-2.5 h-2.5" /> Pending
    </span>
  );
};

// "Self Service" > "Leave Approvals" — same reachable-from-Navbar pattern as
// Leave Application/Leave Management, but only shown to Admin/Superadmin
// accounts (only they can ever be picked as an Approver — see
// NewLeaveApplicationModal's Approver picker). A Superadmin sees every Leave
// Application; a plain Admin only sees the ones where THEY were picked as the
// Approver. Approve just flips status (the day_count was already deducted at
// submission time); Reject gives that day_count back to the account's
// Leave Management balance. See GET /api/leave-applications and
// POST /api/leave-applications/:id/decision.
export const LeaveApprovals: React.FC<LeaveApprovalsProps> = ({ token, user, onBack }) => {
  // Same isNativeApp split as LeaveManagement.tsx / LeaveApplication.tsx: the
  // web build keeps the module-path breadcrumb + Back button, the Android
  // APK build hides both — the bottom nav is the only way to leave this
  // section there.
  const isNativeApp = Capacitor.isNativePlatform();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  const fetchApplications = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/leave-applications'), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave Applications');
      setApplications(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load Leave Applications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDecision = async (application: LeaveApplication, action: 'approve' | 'reject') => {
    const remarks = (remarksDraft[application.id] || '').trim();
    if (action === 'reject' && !remarks) {
      setError('Add a remark so the account understands why this was rejected.');
      return;
    }
    setActingId(application.id);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/leave-applications/${application.id}/decision`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action, remarks: remarks || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record the decision');
      setApplications((prev) =>
        prev.map((a) =>
          a.id === application.id
            ? { ...a, status: action === 'approve' ? 'approved' : 'rejected', remarks: remarks || null, decided_by_name: user.name }
            : a
        )
      );
    } catch (err: any) {
      setError(err.message || 'Failed to record the decision');
    } finally {
      setActingId(null);
    }
  };

  const visible = applications.filter((a) => statusFilter === 'all' || a.status === statusFilter);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Leave Approvals']} />
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
                <CheckSquare className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">Leave Approvals</h1>
                <p className="text-xs text-slate-500">
                  {user.role === 'superadmin'
                    ? 'Every Leave Application submitted, across every account.'
                    : 'Leave Applications where you were picked as the Approver.'}
                </p>
              </div>
            </div>
            <div className="flex gap-1.5 bg-slate-100 rounded-xl p-1">
              {(['pending', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                    statusFilter === f ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {f === 'pending' ? 'Pending' : 'All'}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-sm">
                {statusFilter === 'pending' ? 'No Leave Applications waiting on you.' : 'No Leave Applications yet.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {visible.map((a) => (
                <div key={a.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-slate-800">{a.user_name}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {LEAVE_TYPE_LABELS[a.leave_type]} &middot; {formatDate(a.start_date)} – {formatDate(a.end_date)} &middot;{' '}
                        {a.day_count} day{a.day_count === 1 ? '' : 's'}
                      </p>
                      {a.purpose && <p className="text-xs text-slate-600 mt-1.5 max-w-md">{a.purpose}</p>}
                    </div>
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">Applied {formatDate(a.apply_date)}</span>
                  </div>

                  {a.status === 'pending' && a.approver_id != null ? (
                    <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                      <input
                        type="text"
                        placeholder="Remarks (required to reject)"
                        value={remarksDraft[a.id] || ''}
                        onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        className="flex-1 min-w-[160px] text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={actingId === a.id}
                          onClick={() => handleDecision(a, 'approve')}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {actingId === a.id ? <Spinner size={14} /> : <Check className="w-3.5 h-3.5" />}
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={actingId === a.id}
                          onClick={() => handleDecision(a, 'reject')}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {actingId === a.id ? <Spinner size={14} /> : <X className="w-3.5 h-3.5" />}
                          Reject
                        </button>
                      </div>
                    </div>
                  ) : a.status === 'pending' ? (
                    // Dynamic Approval Engine (Part 5) — approver_id is NULL on
                    // this one, meaning it's routed through a Template instead
                    // of the old direct pick this screen was built for. Point
                    // to wherever it can actually be acted on rather than show
                    // Approve/Reject buttons that would just 400.
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span>
                        Routed through the Approval Workflow{a.approver_name ? ` — currently waiting on ${a.approver_name}` : ''}. Act on it from
                        Admin Panel -&gt; Approvals, or that account's own Dashboard.
                        {a.total_steps ? ` (Layer ${a.current_step} of ${a.total_steps})` : ''}
                      </span>
                    </div>
                  ) : (
                    a.remarks && (
                      <p className="text-xs text-slate-500 mt-2">
                        <span className="font-semibold text-slate-600">Remarks:</span> {a.remarks}
                        {a.decided_by_name && <span className="text-slate-400"> — {a.decided_by_name}</span>}
                      </p>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
