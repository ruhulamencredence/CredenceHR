/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, CalendarClock, CalendarDays, Plus, Inbox, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { LeaveApplication as LeaveApplicationRecord, LeaveType } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { NewLeaveApplicationModal } from './NewLeaveApplicationModal';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface LeaveApplicationProps {
  token: string;
  onBack: () => void;
}

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: 'Casual Leave',
  sick: 'Sick Leave',
  without_pay: 'Leave Without Pay'
};

type ReviewTab = 'pending' | 'approved' | 'rejected';

const REVIEW_TABS: { key: ReviewTab; label: string }[] = [
  { key: 'pending', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }
];

const StatusBadge: React.FC<{ status: LeaveApplicationRecord['status'] }> = ({ status }) => {
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

// "Self Service" > "Leave Application" — reachable from the Navbar's web-only
// "Self Service" header menu (see Navbar.tsx / App.tsx). Takes over the whole main
// area the same way the Claims/Jobs pages do, with a plain "Back" link to return to
// whichever panel (Admin/User) the account was on. "+ Add New" opens
// NewLeaveApplicationModal (same reference design — balance strip, Leave Type/Day
// Count, Start/End Date, Purpose + Approver, Apply Date footer); this page itself
// just lists the account's own submitted Leave Applications with their review
// status. See GET /api/leave-applications/mine and POST /api/leave-applications.
export const LeaveApplication: React.FC<LeaveApplicationProps> = ({ token, onBack }) => {
  // Same isNativeApp split as Leave Management's table (LeaveManagement.tsx /
  // JobEditPanel.tsx): the web build keeps the table below untouched, the
  // Android APK build gets a card list instead.
  const isNativeApp = Capacitor.isNativePlatform();
  const [applications, setApplications] = useState<LeaveApplicationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  // Review/Approved/Rejected tabs — mobile only, matching the Dashboard's
  // Leave Summary card -> LeaveReviewPage.tsx design (see the isNativeApp
  // branch below). The web table keeps showing every application in one list.
  const [tab, setTab] = useState<ReviewTab>('pending');

  const loadMine = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/leave-applications/mine'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setApplications(await res.json());
    } catch {
      // Offline/unreachable — the list just stays empty; "+ Add New" still works.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const tabFiltered = applications.filter((a) => a.status === tab);
  const countFor = (key: ReviewTab) => applications.filter((a) => a.status === key).length;

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Leave Application']} />
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
          <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <CalendarClock className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">Leave Application</h1>
                <p className="text-xs text-slate-500">Your submitted Leave Applications and their review status.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" /> Add New
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : isNativeApp ? (
            <>
              {/* Review / Approved / Rejected — identical segmented control to
                  the Dashboard's Leave Summary card -> LeaveReviewPage.tsx, so
                  Leave Application looks the same whether it's opened from the
                  sidebar or from the Dashboard. */}
              <div className="mx-4 mt-4 flex items-center gap-1.5 rounded-full bg-slate-100 p-1.5 text-xs font-semibold">
                {REVIEW_TABS.map((t) => {
                  const active = tab === t.key;
                  const count = countFor(t.key);
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-full transition-colors ${
                        active ? 'text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      }`}
                      style={active ? { background: 'var(--g-accent)' } : undefined}
                    >
                      {t.label}
                      <span
                        className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                          active ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-500'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="p-4">
                {tabFiltered.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 text-center py-8 text-slate-400">
                    <Inbox className="w-6 h-6 text-slate-300" />
                    <p className="text-xs font-semibold text-slate-500">
                      {tab === 'pending' ? 'Nothing waiting on review.' : tab === 'approved' ? 'No approved Leave yet.' : 'No rejected Leave.'}
                    </p>
                    {tab === 'pending' && (
                      <p className="text-[11px] text-slate-400 max-w-[220px]">
                        Ready for some time off? Tap "Add New" to apply.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {tabFiltered.map((a) => (
                      <div key={a.id} className="border border-slate-200 rounded-xl p-3.5">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <CalendarDays className="w-3.5 h-3.5" style={{ color: 'var(--g-accent)' }} />
                          {formatDate(a.apply_date)}
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-slate-400">
                              {LEAVE_TYPE_LABELS[a.leave_type]}
                            </p>
                            <p className="font-semibold text-slate-700 mt-0.5">
                              {formatDate(a.start_date)} – {formatDate(a.end_date)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] uppercase tracking-wide text-slate-400">Total Leave</p>
                            <p className="font-semibold text-slate-700 mt-0.5">
                              {a.day_count} {a.day_count === 1 ? 'Day' : 'Days'}
                            </p>
                          </div>
                        </div>
                        {a.status === 'pending' ? (
                          <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex items-center gap-1.5 text-[11px] text-amber-700">
                            <Clock className="w-3 h-3" />
                            {a.reliever_status === 'pending' ? (
                              <>Awaiting Reliever approval{a.reliever_name ? ` from ${a.reliever_name}` : ''}</>
                            ) : (
                              <>
                                Awaiting approval{a.approver_name ? ` from ${a.approver_name}` : ''}
                                {a.total_steps ? <span className="text-amber-500">&nbsp;(Layer {a.current_step} of {a.total_steps})</span> : null}
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
                            <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                              a.status === 'approved' ? 'text-emerald-700' : 'text-rose-600'
                            }`}>
                              {a.status === 'approved' ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                              {a.status === 'approved' ? 'Approved' : 'Rejected'}{a.decided_at ? ` at ${formatDate(a.decided_at)}` : ''}
                            </span>
                            {a.decided_by_name && <span className="text-[11px] text-slate-500 shrink-0">By {a.decided_by_name}</span>}
                          </div>
                        )}
                        {a.status === 'rejected' && a.remarks && (
                          <div className="mt-1.5 text-[11px] text-slate-500">
                            <span className="font-medium text-slate-600">Reason:</span> {a.remarks}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : applications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-sm">No Leave Applications yet — tap "Add New" to submit one.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Applied</th>
                    <th className="px-4 py-2.5 text-left">Type</th>
                    <th className="px-4 py-2.5 text-left">Dates</th>
                    <th className="px-4 py-2.5 text-left">Days</th>
                    <th className="px-4 py-2.5 text-left">Reliever</th>
                    <th className="px-4 py-2.5 text-left">Approver</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {applications.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500 text-xs">{formatDate(a.apply_date)}</td>
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-slate-800">{LEAVE_TYPE_LABELS[a.leave_type]}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                        {formatDate(a.start_date)} – {formatDate(a.end_date)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">{a.day_count}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                        {a.reliever_name || '—'}
                        {a.reliever_status === 'pending' && (
                          <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700">
                            <Clock className="w-2.5 h-2.5" /> Pending
                          </span>
                        )}
                        {a.reliever_status === 'approved' && (
                          <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Approved
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">{a.approver_name || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge status={a.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showNewModal && (
        <NewLeaveApplicationModal
          token={token}
          onClose={() => setShowNewModal(false)}
          onSubmitted={() => {
            setShowNewModal(false);
            loadMine();
          }}
        />
      )}
    </div>
  );
};