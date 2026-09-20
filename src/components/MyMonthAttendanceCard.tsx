/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { CalendarCheck, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';

interface MyMonthAttendanceCardProps {
  token: string;
  // Applied to this card's own root, for the Dashboard grid's column span.
  className?: string;
}

// GET /api/my-attendance-summary — the caller's own figures only (see its
// route comment in PayrollRoutes.ts). `linked: false` means this login has no
// Employee record behind it, so there's no payroll identity to report on.
interface MonthSummary {
  linked: boolean;
  month_year: string;
  working_days: number;
  working_days_so_far: number;
  present_days: number;
  leave_days: number;
  late_count: number;
  late_deduction_days: number;
  extreme_late_count: number;
  extreme_late_deduction_days: number;
  policy: {
    shift_start_time: string;
    grace_minutes: number;
    lates_per_deduction_day: number;
    extreme_grace_minutes: number;
    extreme_lates_per_deduction_day: number;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(monthYear: string): string {
  const [yy, mm] = monthYear.split('-').map(Number);
  return MONTHS[mm - 1] ? `${MONTHS[mm - 1]} ${yy}` : monthYear;
}

const Tile: React.FC<{ label: string; value: React.ReactNode; note?: string | null; tone?: 'plain' | 'warn' | 'alert' }> = ({
  label,
  value,
  note,
  tone = 'plain'
}) => (
  <div
    className={`rounded-xl px-4 py-3 border ${
      tone === 'alert'
        ? 'bg-rose-50 border-rose-200'
        : tone === 'warn'
        ? 'bg-amber-50 border-amber-200'
        : 'bg-slate-50 border-slate-200'
    }`}
  >
    <div className="text-xs font-medium text-slate-500">{label}</div>
    <div
      className={`mt-0.5 text-lg font-bold ${
        tone === 'alert' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'
      }`}
    >
      {value}
    </div>
    {note && <div className="text-[11px] text-slate-500 mt-0.5">{note}</div>}
  </div>
);

// Dashboard "This Month" — the employee's own attendance standing for the
// current month: days present, Delay and Extreme Delay counts, and approved
// Leave. The late counts are the point: under the Late Attendance Policy
// (Payroll -> Salary Structure Setup) they convert into deducted days of
// salary, and until now the only place that number existed was the Admin's
// payroll run — meaning an employee first learned about a deduction from
// their payslip, with the month already over and nothing to be done. Same
// figures the payroll wizard will use, computed by the same server-side
// helpers, so what's shown here is what will actually be applied.
export const MyMonthAttendanceCard: React.FC<MyMonthAttendanceCardProps> = ({ token, className = '' }) => {
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/my-attendance-summary'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok && !cancelled) setSummary(await res.json());
      } catch {
        // Offline/unreachable — falls through to rendering nothing.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Nothing to say without a linked Employee record (no payroll identity), and
  // nothing worth flashing an empty shell for while the first fetch runs.
  if (loading || !summary || !summary.linked) return null;

  const totalDeductionDays = summary.late_deduction_days + summary.extreme_late_deduction_days;
  // How many more late days until the next full day of salary comes off —
  // the one number that actually changes behaviour tomorrow morning.
  const towardNextDelay = summary.policy.lates_per_deduction_day
    ? summary.policy.lates_per_deduction_day - (summary.late_count % summary.policy.lates_per_deduction_day)
    : 0;

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-blue-600" /> This Month · {monthLabel(summary.month_year)}
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">
          {summary.working_days_so_far} of {summary.working_days} working days so far · office starts at{' '}
          {summary.policy.shift_start_time?.slice(0, 5)} ({summary.policy.grace_minutes} min grace)
        </p>
      </div>

      <div className="p-5 sm:px-6 grid grid-cols-2 xl:grid-cols-4 gap-2.5">
        <Tile label="Present" value={summary.present_days} note={`of ${summary.working_days_so_far} so far`} />
        <Tile label="On Leave" value={summary.leave_days} note="approved" />
        <Tile
          label="Delay"
          value={summary.late_count}
          note={summary.late_deduction_days > 0 ? `${summary.late_deduction_days} day deducted` : null}
          tone={summary.late_count > 0 ? 'warn' : 'plain'}
        />
        <Tile
          label="Extreme Delay"
          value={summary.extreme_late_count}
          note={summary.extreme_late_deduction_days > 0 ? `${summary.extreme_late_deduction_days} day deducted` : null}
          tone={summary.extreme_late_count > 0 ? 'alert' : 'plain'}
        />
      </div>

      {totalDeductionDays > 0 ? (
        <div className="mx-5 sm:mx-6 mb-5 flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {totalDeductionDays} {totalDeductionDays === 1 ? "day's" : "days'"} salary is set to be deducted this month
            for late attendance.
          </span>
        </div>
      ) : summary.late_count > 0 ? (
        <div className="mx-5 sm:mx-6 mb-5 text-xs px-3 py-2.5 rounded-xl bg-amber-50 text-amber-700">
          {towardNextDelay} more Delay {towardNextDelay === 1 ? 'day' : 'days'} this month and a day's salary gets
          deducted.
        </div>
      ) : null}
    </div>
  );
};
