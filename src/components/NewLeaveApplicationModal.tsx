/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, CheckCircle2, CalendarDays, UserCheck } from 'lucide-react';
import { LeaveType, LeaveBalance, LeaveApprover, LeaveCategory } from '../types';
import { apiUrl } from '../lib/api';
import { todayDateOnlyString, formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { LeaveDurationCalendar } from './LeaveDurationCalendar';
import { Spinner } from './Spinner';

interface NewLeaveApplicationModalProps {
  token: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const FIXED_LEAVE_TYPE_OPTIONS: { value: LeaveType; label: string }[] = [
  { value: 'casual', label: 'Casual Leave' },
  { value: 'sick', label: 'Sick Leave' },
  { value: 'without_pay', label: 'Leave Without Pay' }
];

// Calendar days between start/end (both "YYYY-MM-DD"), inclusive of both ends —
// e.g. the same day counts as 1, tomorrow makes it 2. Half Day knocks 0.5 off the
// total (floored at 0.5) rather than being its own separate calculation, since in
// practice Half Day is used to trim a single extra half-day off either end of an
// otherwise ordinary date range.
function calcDayCount(start: string, end: string, halfDay: boolean): number {
  if (!start || !end) return 0;
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (diff <= 0) return 0;
  return halfDay ? Math.max(0.5, diff - 0.5) : diff;
}

// "Self Service" -> "Leave Application" -> "Add New" — a from-scratch form matching
// the reference design: a Leave-balance + quick-toggle strip up top, Leave Type /
// Day Count / two more toggles in the middle row, a "Leave Duration" inline range
// calendar (see LeaveDurationCalendar) in place of separate Start/End Date inputs,
// then Purpose, and Apply Date (always today) in the footer next to Cancel/Submit
// Application. Same portal/shell/close-button/footer treatment as
// NewConveyanceClaimModal (fixed backdrop + centered rounded-2xl card rendered via
// createPortal, flex-col body that scrolls independently of the header/footer)
// instead of the old sticky-header/sticky-footer scrolling div, so it behaves
// identically on the same Android WebViews that clipped NewConveyanceClaimModal
// before that fix. See POST /api/leave-applications.
//
// Dynamic Approval Engine (Part 5) — this used to also have an Approver picker
// here (the applicant chose who'd review it). That's gone: routing through the
// Approval Template (Admin Panel -> Approvals -> Templates) is automatic, same
// as Conveyance/Timesheet. Reliever workflow — a Reliever picker IS still here
// (any account, required): the request sits waiting on that Reliever's own
// Approve/Reject FIRST, and only once they Approve does it move into the
// Template-driven Approval Workflow above. See GET /api/leave-applications/
// relievers and POST /api/leave-applications/:id/reliever-decision.
export const NewLeaveApplicationModal: React.FC<NewLeaveApplicationModalProps> = ({ token, onClose, onSubmitted }) => {
  const today = todayDateOnlyString();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [relievers, setRelievers] = useState<LeaveApprover[]>([]);
  // Custom Leave Categories (Leave Manage -> Set Balance in Bulk -> Add
  // Category) — GET /api/leave-categories, appended to the fixed 3 in the
  // Leave Type dropdown below so an account can apply against one just like
  // Casual/Sick/LWP. Any authenticated account can call this endpoint (see
  // its route comment), not just Leave Managers.
  const [categories, setCategories] = useState<LeaveCategory[]>([]);
  const [loadingContext, setLoadingContext] = useState(true);

  const [leaveType, setLeaveType] = useState<string>('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [includeExtraWorkDates, setIncludeExtraWorkDates] = useState(false);
  const [isForeignLeave, setIsForeignLeave] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [relieverId, setRelieverId] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useBackButtonClose(true, submitting ? () => {} : onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingContext(true);
      try {
        // Balance strip reads from the "own balance only" endpoint — GET
        // /api/leave-balances/mine always returns a one-row array for the
        // logged-in account, even if that account also holds can_manage_leave
        // (Leave Manager) access, unlike the shared /api/leave-balances used
        // by the admin Leave Management screen.
        const balRes = await fetch(apiUrl('/api/leave-balances/mine'), { headers: authHeaders });
        if (!cancelled && balRes.ok) {
          const balRows = await balRes.json();
          setBalance(Array.isArray(balRows) && balRows.length > 0 ? balRows[0] : null);
        }
        // Reliever candidates — any other account, see GET
        // /api/leave-applications/relievers.
        const relRes = await fetch(apiUrl('/api/leave-applications/relievers'), { headers: authHeaders });
        if (!cancelled && relRes.ok) {
          const relRows = await relRes.json();
          setRelievers(Array.isArray(relRows) ? relRows : []);
        }
        // Custom Leave Categories — appended to the fixed 3 in the Leave
        // Type dropdown below.
        const catRes = await fetch(apiUrl('/api/leave-categories'), { headers: authHeaders });
        if (!cancelled && catRes.ok) {
          const catRows = await catRes.json();
          setCategories(Array.isArray(catRows) ? catRows : []);
        }
      } catch {
        // Offline/unreachable — balance strip just stays empty; the form
        // itself is still usable once connectivity returns.
      } finally {
        if (!cancelled) setLoadingContext(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dayCount = useMemo(() => calcDayCount(startDate, endDate, isHalfDay), [startDate, endDate, isHalfDay]);

  // Fixed 3 + every custom Leave Category (GET /api/leave-categories) —
  // what actually populates the Leave Type dropdown below. This is the fix:
  // a custom category used to only ever show up in "Set Balance in Bulk" and
  // the balance views (LeaveManage/MyLeave), never here, so there was no way
  // to actually apply for one.
  const leaveTypeOptions = useMemo(
    () => [
      ...FIXED_LEAVE_TYPE_OPTIONS,
      ...categories.map((c) => ({ value: c.key, label: c.label }))
    ],
    [categories]
  );

  // The balance this Leave Type spends from — same mapping the server uses
  // to decide which balance to deduct day_count from (leave_balances' fixed
  // column for the 3 built-in types, or this account's leave_category_balances
  // row for a custom category, surfaced here as LeaveBalance.custom_leaves).
  const availableBalance = useMemo(() => {
    if (!balance || !leaveType) return null;
    if (leaveType === 'casual') return balance.casual_leave;
    if (leaveType === 'sick') return balance.sick_leave;
    if (leaveType === 'without_pay') return balance.leave_without_pay;
    return balance.custom_leaves?.find((c) => c.key === leaveType)?.balance ?? 0;
  }, [balance, leaveType]);

  const validate = (): string | null => {
    if (!leaveType) return 'Select a Leave Type.';
    if (!startDate || !endDate) return 'Start Date and End Date are required.';
    if (endDate < startDate) return "End Date can't be before Start Date.";
    if (dayCount <= 0) return 'Day Count must be greater than 0.';
    if (availableBalance !== null && dayCount > availableBalance) {
      return `Day Count (${dayCount}) exceeds your remaining balance (${availableBalance}) for this Leave Type.`;
    }
    if (!purpose.trim()) return 'Purpose is required.';
    if (!relieverId) return 'Select a Reliever.';
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/leave-applications'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          leave_type: leaveType,
          start_date: startDate,
          end_date: endDate,
          day_count: dayCount,
          is_half_day: isHalfDay,
          include_extra_work_dates: includeExtraWorkDates,
          is_foreign_leave: isForeignLeave,
          purpose: purpose.trim(),
          reliever_id: Number(relieverId)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit Leave Application');
      onSubmitted();
    } catch (err: any) {
      setError(err.message || 'Failed to submit Leave Application');
    } finally {
      setSubmitting(false);
    }
  };

  // Rendered via a portal straight onto document.body, same as
  // NewConveyanceClaimModal — this modal gets mounted deep inside UserPanel's
  // dashboard tree, which has an `overflow-hidden` ancestor. On a number of
  // Android WebViews a `position: fixed` element nested inside `overflow:
  // hidden` doesn't truly pin to the full device screen — it gets clipped to
  // that ancestor's box instead. Escaping to document.body via a portal
  // sidesteps that ancestor entirely.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)'
      }}
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full overflow-hidden shadow-2xl flex flex-col"
        style={{ maxHeight: '100%' }}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h3 className="text-base font-bold text-slate-900">New Leave Application</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto min-h-0">
          {/* Balance + quick-toggle strip */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 rounded-xl bg-slate-50 border border-slate-200">
            {loadingContext ? (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <Spinner size={14} /> Loading balance…
              </span>
            ) : (
              <>
                <span className="text-xs text-slate-600">
                  Casual Leave : <span className="font-bold text-slate-900">{balance ? balance.casual_leave : '—'}</span>
                </span>
                <span className="text-xs text-slate-600">
                  Sick Leave : <span className="font-bold text-slate-900">{balance ? balance.sick_leave : '—'}</span>
                </span>
                <span className="text-xs text-slate-600">
                  Leave Without Pay : <span className="font-bold text-slate-900">{balance ? balance.leave_without_pay : '—'}</span>
                </span>
                {leaveType && !['casual', 'sick', 'without_pay'].includes(leaveType) && (
                  <span className="text-xs text-slate-600">
                    {leaveTypeOptions.find((o) => o.value === leaveType)?.label || 'Selected Category'} :{' '}
                    <span className="font-bold text-slate-900">{availableBalance ?? '—'}</span>
                  </span>
                )}
              </>
            )}
            <span className="flex-1" />
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input type="checkbox" checked={isHalfDay} onChange={(e) => setIsHalfDay(e.target.checked)} className="w-3.5 h-3.5 rounded accent-blue-600" />
              Half Day
            </label>
          </div>

          {/* Leave Type / Day Count / extra toggles */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                Leave Type <span className="text-rose-500">*</span>
              </label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
                className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              >
                <option value="">Select Type</option>
                {leaveTypeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Day Count</label>
              <input
                type="text"
                readOnly
                value={dayCount > 0 ? dayCount : ''}
                placeholder="—"
                className="w-full text-sm px-3 py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-slate-600"
              />
            </div>
            <div className="flex flex-col justify-center gap-2 sm:pt-5">
              <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={includeExtraWorkDates} onChange={(e) => setIncludeExtraWorkDates(e.target.checked)} className="w-3.5 h-3.5 rounded accent-blue-600" />
                Include Extra Work Dates
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={isForeignLeave} onChange={(e) => setIsForeignLeave(e.target.checked)} className="w-3.5 h-3.5 rounded accent-blue-600" />
                Foreign Leave Y/N
              </label>
            </div>
          </div>

          {/* Leave Duration — single inline range calendar replacing the old
              separate Start Date / End Date inputs. startDate/endDate stay
              exactly the same state this form already tracked (both default
              to today, single-day, until a range is picked). */}
          <div>
            <h4 className="text-sm font-bold text-slate-900">
              Leave Duration <span className="text-rose-500">*</span>
            </h4>
            <p className="text-xs text-slate-400 mb-2">Select Leave Duration</p>
            <LeaveDurationCalendar
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
          </div>

          {/* Reliever — required; ANY account (GET
              /api/leave-applications/relievers). The request sits waiting on
              this account's own Approve/Reject FIRST — only once they
              Approve does it move into the Template-driven Approval
              Workflow below. */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              Reliever <span className="text-rose-500">*</span>
            </label>
            <select
              value={relieverId}
              onChange={(e) => setRelieverId(e.target.value)}
              className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">Select Reliever</option>
              {relievers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">
              Whoever will cover your work while you're away — they review this first, before it goes to your approver(s).
            </p>
          </div>

          {/* Purpose — the Approver picker that used to sit next to this is
              gone (Part 5): routing through the Dynamic Approval Engine is
              automatic now, so there's nothing left for the applicant to
              pick there. Reliever above is a separate, still-manual pick. */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              Purpose <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Type here"
              rows={4}
              className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
            />
          </div>

          <div className="flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
            <UserCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-600" />
            <span>Your Reliever reviews this first. Once they approve, it's routed automatically to your approver(s) — no need to pick anyone else.</span>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-200 flex items-center justify-between gap-2 shrink-0">
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
            <CalendarDays className="w-3.5 h-3.5" /> Apply Date: <span className="font-bold text-slate-800">{formatDate(today)}</span>
          </span>
          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
            >
              {submitting ? <Spinner size={16} /> : <CheckCircle2 className="w-4 h-4" />}
              Submit Application
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};