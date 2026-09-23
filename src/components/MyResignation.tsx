/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, LogOut, Plus, X, CheckCircle2, Clock, Ban, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { User } from '../types';

interface MyResignationProps {
  token: string;
  user: User;
  onBack: () => void;
}

interface ClearanceItem {
  id: number;
  department: string;
  item_label: string;
  is_cleared: boolean;
  remarks: string | null;
}

interface Settlement {
  net_payable: number;
  status: 'draft' | 'approved' | 'paid';
}

interface ExitRequest {
  id: number;
  reason: string | null;
  notice_date: string | null;
  last_working_day: string | null;
  status: 'pending' | 'clearance' | 'settled' | 'cancelled';
  created_at: string;
  clearance_items: ClearanceItem[];
  settlement: Settlement | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  clearance: 'bg-blue-50 text-blue-700 border-blue-200',
  settled: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200'
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending review',
  clearance: 'Clearance in progress',
  settled: 'Settled',
  cancelled: 'Cancelled'
};

// "Self Service" -> "My Resignation" — an employee submitting their OWN
// resignation and tracking it through to settlement, the self-service
// counterpart to ExitOffboardingPanel.tsx's management view (Admin Panel ->
// HR Advanced -> Exit / Offboarding). Same backend: POST /api/exit-requests
// already forces user_id to req.user.id and exit_type to 'resignation' for
// any account without the exit_offboarding module grant (see that route's
// own comment), so nothing new was needed server-side — this is purely the
// employee-facing read/submit surface for data that route already supports.
// Read-only past submission: clearance ticks and settlement figures are
// HR/Admin's to edit (requireModule('exit_offboarding') on every PUT here),
// an employee only ever watches their own request's progress.
export const MyResignation: React.FC<MyResignationProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [requests, setRequests] = useState<ExitRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [reason, setReason] = useState('');
  const [noticeDate, setNoticeDate] = useState('');
  const [lastWorkingDay, setLastWorkingDay] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/exit-requests'), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load your resignation history');
      setRequests(Array.isArray(data) ? data.sort((a: ExitRequest, b: ExitRequest) => b.id - a.id) : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load your resignation history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An employee only ever has one live resignation at a time — no point
  // letting them queue up a second one while the first is still pending or
  // going through clearance (the backend has no such constraint, since
  // Admin/HR can freely raise a termination alongside an existing
  // resignation for the same account, but that's not this page's concern).
  const activeRequest = requests.find((r) => r.status === 'pending' || r.status === 'clearance');

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/exit-requests'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          reason: reason.trim(),
          notice_date: noticeDate || null,
          last_working_day: lastWorkingDay || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit your resignation');
      setRequests((prev) => [data, ...prev]);
      setShowNew(false);
      setReason('');
      setNoticeDate('');
      setLastWorkingDay('');
    } catch (err: any) {
      setError(err.message || 'Failed to submit your resignation');
    } finally {
      setSubmitting(false);
    }
  };

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'My Resignation']} />
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
              <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center shrink-0">
                <LogOut className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">My Resignation</h1>
                <p className="text-xs text-slate-500">Submit and track your own resignation through clearance and settlement.</p>
              </div>
            </div>
            {!activeRequest && (
              <button
                type="button"
                onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Submit Resignation
              </button>
            )}
          </div>

          {error && (
            <div className="mx-6 mt-4 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {activeRequest && !showNew && (
            <div className="mx-6 mt-4 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-blue-50 text-blue-700">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span>You already have a resignation in progress below — submit a new one only after it's resolved.</span>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : requests.length === 0 && !showNew ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                <LogOut className="w-5 h-5 text-slate-400" />
              </div>
              <p className="text-sm font-semibold text-slate-700">No resignation on file</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                If you're planning to leave, submit your resignation here and HR will walk it through clearance and your final settlement.
              </p>
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {showNew && (
                <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
                  <h2 className="text-sm font-bold text-slate-900 mb-3">Submit Resignation</h2>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-600 mb-1 block">Reason (optional)</label>
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={3}
                        maxLength={2000}
                        placeholder="Let HR know why you're resigning…"
                        className="w-full text-sm px-3 py-2 rounded-xl border border-slate-200 focus:ring-2 focus:ring-rose-500 focus:outline-none resize-none"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-semibold text-slate-600 mb-1 block">Notice date</label>
                        <input
                          type="date"
                          value={noticeDate}
                          onChange={(e) => setNoticeDate(e.target.value)}
                          className="w-full text-sm px-3 py-2 rounded-xl border border-slate-200 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-600 mb-1 block">Preferred last working day</label>
                        <input
                          type="date"
                          value={lastWorkingDay}
                          onChange={(e) => setLastWorkingDay(e.target.value)}
                          className="w-full text-sm px-3 py-2 rounded-xl border border-slate-200 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Your last working day is subject to HR's confirmation once they review this request.
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={submit}
                        disabled={submitting}
                        className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white transition-colors"
                      >
                        {submitting ? <Spinner size={14} className="text-white" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Confirm & Submit
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowNew(false)}
                        disabled={submitting}
                        className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" /> Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {requests.map((r) => {
                const clearedCount = r.clearance_items.filter((ci) => ci.is_cleared).length;
                const totalCount = r.clearance_items.length;
                return (
                  <div key={r.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <p className="text-sm font-bold text-slate-900">Resignation submitted {fmtDate(r.created_at)}</p>
                        {r.reason && <p className="text-xs text-slate-500 mt-0.5 max-w-xl">{r.reason}</p>}
                      </div>
                      <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${STATUS_STYLE[r.status]}`}>
                        {r.status === 'cancelled' ? <Ban className="w-3 h-3 inline mr-1 -mt-0.5" /> : null}
                        {STATUS_LABEL[r.status]}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-slate-500">Notice date</span>
                        <p className="font-semibold text-slate-800">{fmtDate(r.notice_date)}</p>
                      </div>
                      <div>
                        <span className="text-slate-500">Last working day</span>
                        <p className="font-semibold text-slate-800">{fmtDate(r.last_working_day)}</p>
                      </div>
                    </div>

                    {r.status !== 'cancelled' && totalCount > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                          <span>Clearance progress</span>
                          <span>{clearedCount}/{totalCount} cleared</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className="h-full bg-blue-600 rounded-full transition-all"
                            style={{ width: `${totalCount > 0 ? (clearedCount / totalCount) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {r.settlement && (
                      <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 flex items-center justify-between text-xs">
                        <span className="text-emerald-700 font-semibold">
                          Final Settlement {r.settlement.status === 'paid' ? '— Paid' : r.settlement.status === 'approved' ? '— Approved' : '— In progress'}
                        </span>
                        {r.settlement.status !== 'draft' && (
                          <span className="font-bold text-emerald-800">৳{r.settlement.net_payable.toLocaleString()}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MyResignation;
