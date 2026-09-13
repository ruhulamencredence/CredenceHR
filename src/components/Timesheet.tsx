/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Clock, CalendarDays, CalendarRange, Inbox, CheckCircle2, XCircle, MapPin, Pencil } from 'lucide-react';
import { AttendanceRecord, AttendanceCorrection, Project, HolidayEntry } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import { ApprovalBadge } from './ApprovalBadge';
import { AttendanceCorrectionModal } from './AttendanceCorrectionModal';
import { AttendanceCorrectionStatusModal } from './AttendanceCorrectionStatusModal';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface TimesheetProps {
  token: string;
  // Kept for the caller's mobile tile-menu wiring, but no longer rendered as
  // a Back button — matches ConveyanceClaimCard/ClaimCard, which accept this
  // same prop and rely on the bottom nav to leave the section instead.
  onBack?: () => void;
  // Superadmin/Admin-pinned Project for Remote Attendance (Admin Panel ->
  // Users -> "Attend. Project", users.attendance_project_id) — undefined/null
  // when this account isn't pinned to one. Passed straight through to the
  // Correct Attendance modal, which drops its own Project picker entirely
  // once this is set (see AttendanceCorrectionModal.tsx).
  attendanceProjectId?: number | null;
}

type TimesheetTab = 'month' | 'day' | 'range';

const TABS: { key: TimesheetTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'month', label: 'Month Wise', icon: CalendarDays },
  { key: 'day', label: 'Day Wise', icon: Clock },
  { key: 'range', label: 'Custom Range', icon: CalendarRange }
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// "08:58 AM" — same clock-face formatting AttendanceCard uses for In/Out Time.
function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function daysInCalendarMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the *next* month rolls back to the last day of this one.
  return new Date(year, month, 0).getDate();
}

// Every "YYYY-MM-DD" in the given calendar month, stopping at today so future
// (not-yet-happened) days never show up as "Absent".
function buildMonthDates(year: number, month: number, today: string): string[] {
  const total = daysInCalendarMonth(year, month);
  const out: string[] = [];
  for (let d = 1; d <= total; d++) {
    const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (ds > today) break;
    out.push(ds);
  }
  return out;
}

// Every "YYYY-MM-DD" (inclusive) between from/to — mirrors dateRangeOptions in
// formatDate.ts (explicit UTC stepping so no timezone drift), capped so an
// accidental huge range can't turn into an unusably long table.
function buildRangeDates(from: string, to: string): string[] {
  const out: string[] = [];
  if (!from || !to) return out;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  const MAX_DAYS = 366;
  for (let d = new Date(start), i = 0; d <= end && i < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const DayOfWeek: React.FC<{ dateStr: string }> = ({ dateStr }) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const label = d.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
  return <span className="text-slate-400">{label}</span>;
};

// One summarized row-card for a single calendar date: Present (earliest
// check-in / latest check-out across every Project checked into that day,
// comma-joined project names), Absent (no attendance row at all for that
// date), or Holiday/Weekend (this date is on the Global Calendar — Admin
// Panel -> Holidays — so it's never shown as Absent even with no attendance
// row). Same bordered-card look Day Wise uses for its per-project cards.
// Clicking anywhere on the card opens the Correct Attendance modal for that
// date — unless a correction request for it is already sitting Pending review
// or was Rejected, in which case it opens that request's status instead (see
// AttendanceCorrectionStatusModal), so a User can't fire off a second request
// while one is still in flight and can always see where a past one landed.
const DateCard: React.FC<{
  dateStr: string;
  records: AttendanceRecord[];
  correction?: AttendanceCorrection;
  holiday?: HolidayEntry;
  onClick: () => void;
}> = ({ dateStr, records, correction, holiday, onClick }) => {
  const present = records.length > 0;
  const projectNames = Array.from(new Set(records.map((r) => r.project_name).filter(Boolean))).join(', ');
  const checkIns = records.map((r) => r.check_in_at).filter(Boolean) as string[];
  const checkOuts = records.map((r) => r.check_out_at).filter(Boolean) as string[];
  const earliestIn = checkIns.sort()[0];
  const latestOut = checkOuts.sort().slice(-1)[0];
  const pendingCorrection = correction?.status === 'pending';
  const rejectedCorrection = correction?.status === 'rejected';
  const cardTitle = pendingCorrection
    ? "Correction pending approval \u2014 click to view status"
    : rejectedCorrection
    ? 'Correction rejected \u2014 click to view status'
    : "Click to correct this day's In/Out Time";

  return (
    <div
      onClick={onClick}
      title={cardTitle}
      className="border border-slate-200 rounded-xl p-4 hover:bg-blue-50/60 hover:border-blue-200 transition-colors cursor-pointer"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900">
          <Pencil className="w-3.5 h-3.5 text-slate-300" />
          {formatDate(dateStr)} <DayOfWeek dateStr={dateStr} />
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {present ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="w-3 h-3" /> Present
            </span>
          ) : holiday ? (
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                holiday.day_type === 'weekend' ? 'bg-sky-50 text-sky-700' : 'bg-amber-50 text-amber-700'
              }`}
              title={holiday.title}
            >
              <CheckCircle2 className="w-3 h-3" /> {holiday.day_type === 'weekend' ? 'Weekend' : 'Holiday'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">
              <XCircle className="w-3 h-3" /> Absent
            </span>
          )}
          {pendingCorrection && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
              <Clock className="w-2.5 h-2.5" /> Correction Pending
            </span>
          )}
          {correction?.status === 'rejected' && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700"
              title={correction.admin_remarks || undefined}
            >
              <XCircle className="w-2.5 h-2.5" /> Correction Rejected
            </span>
          )}
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Project</p>
          <p className="font-semibold text-slate-700 mt-0.5 truncate">{present ? (projectNames || '—') : '—'}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-400">In Time</p>
          <p className="font-semibold text-slate-700 mt-0.5">{present ? formatTime(earliestIn) : '—'}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Out Time</p>
          <p className="font-semibold text-slate-700 mt-0.5">{present ? formatTime(latestOut) : '—'}</p>
        </div>
      </div>
    </div>
  );
};

// "Self Service" > "Timesheet" — every account's own Present/Absent Remote
// Attendance history, viewable Month Wise (a full calendar month's P/A grid),
// Day Wise (one calendar day's detail — every Project checked into that day,
// with times/remarks/approval status), or a Custom Date Range. Reuses the
// exact same GET /api/attendance/mine already backing AttendanceCard's own
// "not checked in yet" status — no new server endpoint needed, this just
// reads and slices the same data a different way. Reachable from the
// Navbar's web-only "Self Service" header menu, GlobalSidebar's mobile
// drawer, and (in future) a Dashboard tile — same "Back" pattern as
// LeaveApplication/LeaveManagement.
export const Timesheet: React.FC<TimesheetProps> = ({ token, onBack, attendanceProjectId }) => {
  // Same isNativeApp split as LeaveManagement.tsx / LeaveApplication.tsx: the
  // web build keeps the "Self Service / Timesheet" module-path breadcrumb,
  // the Android APK build hides it — the bottom nav is the only way to leave
  // this section there, matching onBack no longer being rendered above.
  const isNativeApp = Capacitor.isNativePlatform();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Global Calendar (Admin Panel -> Holidays) — read-only here regardless of
  // module access (GET /api/holidays is open to every signed-in account), so
  // Weekend/Holiday dates never show as Absent below.
  const [holidays, setHolidays] = useState<HolidayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TimesheetTab>('month');
  // Which date's row was clicked — opens the Correct Attendance modal for it.
  const [correctionDate, setCorrectionDate] = useState<string | null>(null);
  // A date's row clicked while its correction request is Pending/Rejected —
  // opens that request's status instead of the edit form (see DateCard/
  // openDateCard below).
  const [statusCorrection, setStatusCorrection] = useState<AttendanceCorrection | null>(null);

  const today = todayDateOnlyString();
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;

  const [selYear, setSelYear] = useState(todayYear);
  const [selMonth, setSelMonth] = useState(todayMonth);
  const [selDay, setSelDay] = useState(today);
  const [rangeFrom, setRangeFrom] = useState(firstOfThisMonth);
  const [rangeTo, setRangeTo] = useState(today);

  const loadData = async (cancelledRef?: { cancelled: boolean }) => {
    try {
      const [attRes, corrRes, projRes, holRes] = await Promise.all([
        fetch(apiUrl('/api/attendance/mine'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/attendance/corrections/mine'), { headers: { Authorization: `Bearer ${token}` } }),
        // /api/projects/all (not the permission-filtered /api/projects) — a
        // Correction always goes through the Approval Workflow regardless of
        // whether this account has check-in access to that Project, so the
        // "Correct Attendance" picker (and the project-name lookup used for
        // past corrections' status) shouldn't be limited to Projects this
        // Employee happens to be explicitly granted.
        fetch(apiUrl('/api/projects/all'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/holidays'), { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (cancelledRef?.cancelled) return;
      if (attRes.ok) setRecords(await attRes.json());
      if (corrRes.ok) setCorrections(await corrRes.json());
      if (projRes.ok) setProjects(await projRes.json());
      if (holRes.ok) setHolidays(await holRes.json());
    } catch {
      // Offline/unreachable — the page just shows whatever it already had (or
      // stays empty); switching tabs/filters still works once back online.
    } finally {
      if (!cancelledRef?.cancelled) setLoading(false);
    }
  };

  useEffect(() => {
    const ref = { cancelled: false };
    setLoading(true);
    loadData(ref);
    return () => {
      ref.cancelled = true;
    };
  }, [token]);

  // "YYYY-MM-DD" -> every attendance row recorded that day (almost always
  // one, but a User who checked into more than one Project the same day gets
  // more than one).
  const byDate = useMemo(() => {
    const map = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      const d = String(r.attendance_date).slice(0, 10);
      const list = map.get(d) || [];
      list.push(r);
      map.set(d, list);
    }
    return map;
  }, [records]);

  // "YYYY-MM-DD" -> that date's most recent correction request (corrections
  // already arrive newest-first from GET /api/attendance/corrections/mine, so
  // the first one seen per date wins) — enough to show a Pending/Rejected
  // badge; an Approved one just shows up as that day's normal Present row
  // since `attendance` itself was already updated server-side.
  const correctionsByDate = useMemo(() => {
    const map = new Map<string, AttendanceCorrection>();
    for (const c of corrections) {
      const d = String(c.attendance_date).slice(0, 10);
      if (!map.has(d)) map.set(d, c);
    }
    return map;
  }, [corrections]);

  // "YYYY-MM-DD" -> Global Calendar entry for that date, if any — dates in
  // here are never counted as Absent below (see monthAbsentCount /
  // rangeAbsentCount), matching the same rule the Admin's Attendance Report
  // applies.
  const holidayByDate = useMemo(() => {
    const map = new Map<string, HolidayEntry>();
    for (const h of holidays) map.set(h.entry_date, h);
    return map;
  }, [holidays]);

  const monthDates = useMemo(() => buildMonthDates(selYear, selMonth, today), [selYear, selMonth, today]);
  const rangeDates = useMemo(() => buildRangeDates(rangeFrom, rangeTo), [rangeFrom, rangeTo]);

  const monthPresentCount = monthDates.filter((d) => (byDate.get(d) || []).length > 0).length;
  const monthAbsentCount = monthDates.filter((d) => (byDate.get(d) || []).length === 0 && !holidayByDate.has(d)).length;
  const rangePresentCount = rangeDates.filter((d) => (byDate.get(d) || []).length > 0).length;
  const rangeAbsentCount = rangeDates.filter((d) => (byDate.get(d) || []).length === 0 && !holidayByDate.has(d)).length;

  const dayRecords = byDate.get(selDay) || [];

  // "project_id" -> its name, so the Status modal can show which Project a
  // correction request was for without a separate lookup (AttendanceCorrection
  // rows only carry project_id, not the name).
  const projectNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of projects) map.set(p.id, p.project_name);
    return map;
  }, [projects]);

  // Shared by every DateCard's onClick: a date whose latest correction request
  // is still Pending or was Rejected opens that request's status instead of
  // the edit form — see AttendanceCorrectionStatusModal's own "Submit a New
  // Correction" button for how a Rejected one gets back to the edit form.
  const openDateCard = (d: string) => {
    const existing = correctionsByDate.get(d);
    if (existing && existing.status !== 'approved') {
      setStatusCorrection(existing);
    } else {
      setCorrectionDate(d);
    }
  };

  // Years available in the picker — from the earliest recorded attendance
  // date up through this year, so there's always at least the current year.
  const yearOptions = useMemo(() => {
    const years = new Set<number>([todayYear]);
    for (const r of records) years.add(Number(String(r.attendance_date).slice(0, 4)));
    return Array.from(years).sort((a, b) => b - a);
  }, [records, todayYear]);

  const selectClass =
    'text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none';

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      <div className="w-full px-2 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <div className="px-2 sm:px-0">
            <ModulePath path={['Self Service', 'Timesheet']} />
          </div>
        )}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-blue-50 rounded-lg">
                <Clock className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">Timesheet</div>
                <div className="text-xs text-slate-400">Your Remote Attendance — Month Wise, Day Wise, or a Custom Date Range.</div>
              </div>
            </div>
          </div>

          {/* Month Wise / Day Wise / Custom Range — segmented control, same
              rounded-pill treatment LeaveReviewPage's Review/Approved/Rejected
              switcher uses. */}
          <div className="mx-3 sm:mx-6 mt-4 flex items-center gap-1.5 rounded-full bg-slate-100 p-1.5 text-xs font-semibold">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-full transition-colors ${
                    active ? 'text-white shadow-sm bg-blue-600' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : (
            <div className="px-3 sm:px-6 py-5">
              {/* Month Wise */}
              {tab === 'month' && (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    <select value={selMonth} onChange={(e) => setSelMonth(Number(e.target.value))} className={selectClass}>
                      {MONTH_NAMES.map((name, idx) => (
                        <option key={name} value={idx + 1}>{name}</option>
                      ))}
                    </select>
                    <select value={selYear} onChange={(e) => setSelYear(Number(e.target.value))} className={selectClass}>
                      {yearOptions.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <div className="ml-auto flex items-center gap-4 text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-emerald-700">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" /> Present: {monthPresentCount}
                      </span>
                      <span className="flex items-center gap-1.5 font-semibold text-rose-600">
                        <span className="w-2 h-2 rounded-full bg-rose-500" /> Absent: {monthAbsentCount}
                      </span>
                    </div>
                  </div>

                  {monthDates.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
                      <Inbox className="w-6 h-6 text-slate-300" />
                      <p className="text-sm">This month hasn't started yet.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {monthDates.map((d) => (
                        <DateCard key={d} dateStr={d} records={byDate.get(d) || []} correction={correctionsByDate.get(d)} holiday={holidayByDate.get(d)} onClick={() => openDateCard(d)} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Day Wise */}
              {tab === 'day' && (
                <>
                  <div className="mb-4">
                    <input
                      type="date"
                      value={selDay}
                      max={today}
                      onChange={(e) => setSelDay(e.target.value)}
                      className={selectClass}
                    />
                  </div>

                  {dayRecords.length === 0 ? (
                    holidayByDate.has(selDay) ? (
                      <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
                        <CheckCircle2 className={`w-6 h-6 ${holidayByDate.get(selDay)!.day_type === 'weekend' ? 'text-sky-300' : 'text-amber-300'}`} />
                        <p className="text-sm font-semibold text-slate-500">
                          {holidayByDate.get(selDay)!.day_type === 'weekend' ? 'Weekend' : 'Holiday'} — {holidayByDate.get(selDay)!.title}
                        </p>
                        <p className="text-xs text-slate-400 max-w-[260px]">{formatDate(selDay)} is set on the Global Calendar, so it isn't counted as Absent.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
                        <XCircle className="w-6 h-6 text-rose-300" />
                        <p className="text-sm font-semibold text-slate-500">Absent on {formatDate(selDay)}</p>
                        <p className="text-xs text-slate-400 max-w-[260px]">No Remote Attendance was recorded for this date.</p>
                      </div>
                    )
                  ) : (
                    <div className="space-y-3">
                      {dayRecords.map((r) => (
                        <div key={r.id} className="border border-slate-200 rounded-xl p-4">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-900">
                            <MapPin className="w-3.5 h-3.5 text-blue-600" /> {r.project_name || 'Project'}
                            <ApprovalBadge approval={r.check_in_approval} label="In" />
                            <ApprovalBadge approval={r.check_out_approval} label="Out" />
                          </div>
                          <div className="mt-2.5 grid grid-cols-2 gap-3 text-xs">
                            <div>
                              <p className="text-[10px] uppercase tracking-wide text-slate-400">In Time</p>
                              <p className="font-semibold text-slate-700 mt-0.5">{formatTime(r.check_in_at)}</p>
                              {r.check_in_distance_m != null && (
                                <p className="text-[10px] text-slate-400 mt-0.5">{r.check_in_distance_m}m from site</p>
                              )}
                            </div>
                            <div>
                              <p className="text-[10px] uppercase tracking-wide text-slate-400">Out Time</p>
                              <p className="font-semibold text-slate-700 mt-0.5">{formatTime(r.check_out_at)}</p>
                              {r.check_out_distance_m != null && (
                                <p className="text-[10px] text-slate-400 mt-0.5">{r.check_out_distance_m}m from site</p>
                              )}
                            </div>
                          </div>
                          {r.check_in_remarks && (
                            <p className="mt-2 pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                              <span className="font-medium text-slate-600">In remarks:</span> {r.check_in_remarks}
                            </p>
                          )}
                          {r.check_out_remarks && (
                            <p className="mt-1 text-[11px] text-slate-500">
                              <span className="font-medium text-slate-600">Out remarks:</span> {r.check_out_remarks}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Custom Range */}
              {tab === 'range' && (
                <>
                  <div className="flex flex-wrap items-end gap-3 mb-4">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">From</label>
                      <input
                        type="date"
                        value={rangeFrom}
                        max={rangeTo || today}
                        onChange={(e) => setRangeFrom(e.target.value)}
                        className={selectClass}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">To</label>
                      <input
                        type="date"
                        value={rangeTo}
                        min={rangeFrom}
                        max={today}
                        onChange={(e) => setRangeTo(e.target.value)}
                        className={selectClass}
                      />
                    </div>
                    <div className="ml-auto flex items-center gap-4 text-xs pb-2.5">
                      <span className="flex items-center gap-1.5 font-semibold text-emerald-700">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" /> Present: {rangePresentCount}
                      </span>
                      <span className="flex items-center gap-1.5 font-semibold text-rose-600">
                        <span className="w-2 h-2 rounded-full bg-rose-500" /> Absent: {rangeAbsentCount}
                      </span>
                    </div>
                  </div>

                  {rangeDates.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
                      <Inbox className="w-6 h-6 text-slate-300" />
                      <p className="text-sm">Pick a valid From / To date to see the report.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {rangeDates.map((d) => (
                        <DateCard key={d} dateStr={d} records={byDate.get(d) || []} correction={correctionsByDate.get(d)} holiday={holidayByDate.get(d)} onClick={() => openDateCard(d)} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {correctionDate && (
        <AttendanceCorrectionModal
          token={token}
          dateStr={correctionDate}
          dayRecords={byDate.get(correctionDate) || []}
          projects={projects}
          pinnedProjectId={attendanceProjectId}
          onClose={() => setCorrectionDate(null)}
          onSubmitted={() => {
            setCorrectionDate(null);
            loadData();
          }}
        />
      )}

      {statusCorrection && (
        <AttendanceCorrectionStatusModal
          correction={statusCorrection}
          projectName={projectNameById.get(statusCorrection.project_id) || 'Project'}
          onClose={() => setStatusCorrection(null)}
          onEditAgain={() => {
            const d = String(statusCorrection.attendance_date).slice(0, 10);
            setStatusCorrection(null);
            setCorrectionDate(d);
          }}
        />
      )}
    </div>
  );
};