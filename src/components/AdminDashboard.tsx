/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Dashboard — the new landing tab for role admin/superadmin
// (see GlobalSidebar's adminDashboardItem / AdminPanel's isAdminRole gate;
// a plain 'user' role account with module_permissions never sees this tab).
//
// Content list follows the reference PDF the user supplied (stat tiles,
// Quick View, Claim Amount chart, Attendance Summary chart, Notice board,
// Current Leave Balance, Attendance Missed, Leave Calendar, Task Status
// Overview) — but the VISUAL DESIGN deliberately does not copy that
// reference. Every card/table/chart below reuses this app's own existing
// language instead: white rounded-2xl cards with a soft shadow and
// slate-200 border, the violet brand accent (bg-blue-600/text-blue-600,
// which index.css already re-skins to var(--g-accent) app-wide), and the
// same text-xs uppercase tracking-wide label style AdminPanel's own filter
// bars use elsewhere in this file.
//
// Every stat tile/section below is wired to a REAL endpoint this app
// already has UNLESS explicitly marked comingSoon — those cover concepts
// from the reference PDF this app has no backing feature for yet
// (break-time reconciliation, visit applications, on-break tracking,
// employee status-effective-date, profile-image approval, document
// requests, and Task management). They render as the same tile shape,
// greyed out with a "Coming Soon" pill, so the layout already has a slot
// for them the day those features exist — nothing here is a mocked number.

import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, CalendarDays, Clock3, Wallet, Banknote, Package, HandCoins,
  Bell, Users, ListChecks, Gift, Fingerprint, MapPinned, FileQuestion,
  ImageIcon, ClipboardList, ShieldAlert, UserCog, Search, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { User } from '../types';
import { apiUrl } from '../lib/api';

interface AdminDashboardProps {
  token: string;
  user: User;
}

// GET helper that never throws into the caller — a 403 (module not granted
// to this Admin) or a network hiccup just means that one card/section shows
// "no data", not a broken page. Distinct from a truly comingSoon tile (this
// app has no feature at all for it) — this is "the feature exists, but this
// account/browser couldn't read it right now".
async function safeGet<T>(path: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(apiUrl(path), { headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function monthKey(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 7); // 'YYYY-MM'
}

function formatMoney(n: number): string {
  return `৳${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function initialsOf(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
}

const AVATAR_COLORS = ['#7F00FF', '#B36AFF', '#D2A8FF', '#6300C6', '#9B4DFF'];
function avatarColorFor(seed: number): string {
  return AVATAR_COLORS[Math.abs(seed) % AVATAR_COLORS.length];
}

// Stat-tile icon circle colors — cycled by index so the tile row reads as
// colorful glance-able badges (per the reference dashboard screenshot)
// instead of one repeated blue square. comingSoon tiles override this with
// a flat slate circle regardless of index (see the tile map below).
const TILE_ICON_COLORS = ['#3B82F6', '#7C3AED', '#0EA5E9', '#F97316', '#10B981', '#EC4899'];
function tileIconColorFor(index: number): string {
  return TILE_ICON_COLORS[index % TILE_ICON_COLORS.length];
}

// --- Leave Calendar grid helpers (same fixed 6-row/42-cell approach as
// HolidayCalendarWidget's own buildGrid, so leading/trailing days from the
// neighbouring months keep the grid height constant while navigating). ---
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateStr = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const daysInMonthOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

interface CalGridCell {
  dateStr: string;
  day: number;
  inCurrentMonth: boolean;
}

function buildMonthGrid(year: number, month: number): CalGridCell[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const totalInMonth = daysInMonthOf(year, month);
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const totalInPrevMonth = daysInMonthOf(prevYear, prevMonth);
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  const cells: CalGridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const offset = i - firstWeekday;
    if (offset < 0) {
      const day = totalInPrevMonth + offset + 1;
      cells.push({ dateStr: toDateStr(prevYear, prevMonth, day), day, inCurrentMonth: false });
    } else if (offset >= totalInMonth) {
      const day = offset - totalInMonth + 1;
      cells.push({ dateStr: toDateStr(nextYear, nextMonth, day), day, inCurrentMonth: false });
    } else {
      const day = offset + 1;
      cells.push({ dateStr: toDateStr(year, month, day), day, inCurrentMonth: true });
    }
  }
  return cells;
}

interface StatTile {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string | null; // null -> "—" (no data / no permission)
  comingSoon?: boolean; // true -> this app has no feature for it yet
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ token, user }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [leaveApplications, setLeaveApplications] = useState<any[] | null>(null);
  const [leaveBalances, setLeaveBalances] = useState<any[] | null>(null);
  const [pendingAdvances, setPendingAdvances] = useState<any[] | null>(null);
  const [pendingAssetReqs, setPendingAssetReqs] = useState<any[] | null>(null);
  const [userClaims, setUserClaims] = useState<any[] | null>(null);
  const [conveyanceBills, setConveyanceBills] = useState<any[] | null>(null);
  const [notices, setNotices] = useState<any[] | null>(null);
  const [employees, setEmployees] = useState<any[] | null>(null);
  const [attendanceReport, setAttendanceReport] = useState<{ year: number; month: number; days_in_month: number; users: any[] } | null>(null);
  const [holidays, setHolidays] = useState<any[] | null>(null);
  const [latePolicy, setLatePolicy] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const now0 = new Date();
      const [
        leaveApps, balances, advances, assetReqs, claims, bills, activeNotices, empDir, monthlyReport, holidayRows, latePolicyRows,
      ] = await Promise.all([
        safeGet<any[]>('/api/leave-applications', authHeaders),
        safeGet<any[]>('/api/leave-balances', authHeaders),
        safeGet<any[]>('/api/payroll/advance-requests?status=pending', authHeaders),
        safeGet<any[]>('/api/assets/requisitions?status=pending', authHeaders),
        safeGet<any[]>('/api/user-claims', authHeaders),
        safeGet<any[]>('/api/conveyance-bills', authHeaders),
        safeGet<any[]>('/api/notices/active', authHeaders),
        safeGet<any[]>('/api/employee-directory', authHeaders),
        safeGet<{ year: number; month: number; days_in_month: number; users: any[] }>(
          `/api/attendance/report/monthly?year=${now0.getFullYear()}&month=${now0.getMonth() + 1}`,
          authHeaders
        ),
        safeGet<any[]>('/api/holidays', authHeaders),
        safeGet<any[]>('/api/payroll/late-policy', authHeaders),
      ]);
      if (cancelled) return;
      setLeaveApplications(leaveApps);
      setLeaveBalances(balances);
      setPendingAdvances(advances);
      setPendingAssetReqs(assetReqs);
      setUserClaims(claims);
      setConveyanceBills(bills);
      setNotices(activeNotices);
      setEmployees(empDir);
      setAttendanceReport(monthlyReport);
      setHolidays(holidayRows);
      setLatePolicy(latePolicyRows && latePolicyRows.length > 0 ? latePolicyRows[0] : null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const today = todayStr(0);
  const tomorrow = todayStr(1);
  const thisMonth = todayStr(0).slice(0, 7);

  // --- On Leave Today / Tomorrow / Pending Leave Application ---
  const onLeaveTodayCount = useMemo(() => {
    if (!leaveApplications) return null;
    const users = new Set<number>();
    for (const a of leaveApplications) {
      if (a.status === 'approved' && a.start_date <= today && a.end_date >= today) users.add(Number(a.user_id));
    }
    return users.size;
  }, [leaveApplications, today]);

  const onLeaveTomorrowCount = useMemo(() => {
    if (!leaveApplications) return null;
    const users = new Set<number>();
    for (const a of leaveApplications) {
      if (a.status === 'approved' && a.start_date <= tomorrow && a.end_date >= tomorrow) users.add(Number(a.user_id));
    }
    return users.size;
  }, [leaveApplications, tomorrow]);

  const pendingLeaveCount = useMemo(() => {
    if (!leaveApplications) return null;
    return leaveApplications.filter((a) => a.status === 'pending').length;
  }, [leaveApplications]);

  // --- Monthly Claim Amount / Monthly Disburse Amount + last-3-months chart ---
  const last3Months = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    const d = new Date();
    for (let i = 2; i >= 0; i--) {
      const dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ key: `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`, label: dd.toLocaleString(undefined, { month: 'short' }) });
    }
    return out;
  }, []);

  const claimChartData = useMemo(() => {
    return last3Months.map(({ key, label }) => {
      const claimSum = (userClaims || []).filter((c) => monthKey(c.claim_date) === key).reduce((s, c) => s + Number(c.amount || 0), 0);
      const disbursedSum = (conveyanceBills || []).filter((b) => b.is_disbursed && monthKey(b.bill_date) === key).reduce((s, b) => s + Number(b.total_amount || 0), 0);
      return { label, claimSum, disbursedSum };
    });
  }, [last3Months, userClaims, conveyanceBills]);

  const monthlyClaimAmount = useMemo(() => {
    if (!userClaims) return null;
    return userClaims.filter((c) => monthKey(c.claim_date) === thisMonth).reduce((s, c) => s + Number(c.amount || 0), 0);
  }, [userClaims, thisMonth]);

  const monthlyDisburseAmount = useMemo(() => {
    if (!conveyanceBills) return null;
    return conveyanceBills.filter((b) => b.is_disbursed && monthKey(b.bill_date) === thisMonth).reduce((s, b) => s + Number(b.total_amount || 0), 0);
  }, [conveyanceBills, thisMonth]);

  // --- Attendance Summary (current month, Present vs Absent by day) ---
  // Sourced from the same Monthly Attendance Report (Admin Panel -> Attendance
  // Reports) Quick View below now checks — Remote (GPS) attendance, falling
  // back to Office/ZKTeco punches, with Global Calendar holidays excluded
  // from the "absent" count for that day (a holiday isn't a normal working day).
  const attendanceSummary = useMemo(() => {
    if (!attendanceReport) return null;
    const headcount = attendanceReport.users.length;
    if (!headcount) return null;
    const upToDay = new Date().getDate();
    const byDay: { day: number; present: number; absent: number }[] = [];
    for (let day = 1; day <= Math.min(upToDay, attendanceReport.days_in_month); day++) {
      let present = 0;
      let absent = 0;
      for (const u of attendanceReport.users) {
        const d = u.days[day - 1];
        if (!d) continue;
        if (d.present) present++;
        else if (!d.day_type) absent++; // day_type set -> holiday/weekend, doesn't count as absent
      }
      byDay.push({ day, present, absent });
    }
    return { headcount, byDay };
  }, [attendanceReport]);

  // --- Quick View (today's attendance status per employee, from the same
  // Monthly Attendance Report used by Admin Panel -> Attendance Reports) ---
  const quickViewRows = useMemo(() => {
    if (!employees || !attendanceReport) return null;
    const todayDay = new Date().getDate();
    const byUser = new Map<number, any>(attendanceReport.users.map((u) => [Number(u.user_id), u]));
    let thresholdMinutes: number | null = null;
    let extremeThresholdMinutes: number | null = null;
    if (latePolicy) {
      const [h, m] = String(latePolicy.shift_start_time).split(':').map(Number);
      thresholdMinutes = h * 60 + m + Number(latePolicy.grace_minutes || 0);
      extremeThresholdMinutes = h * 60 + m + Number(latePolicy.extreme_grace_minutes || 60);
    }
    const rows = employees
      .filter((e) => e.is_active && e.user_id)
      .map((e) => {
        const u = byUser.get(Number(e.user_id));
        const d = u?.days?.[todayDay - 1];
        let isDelay = false;
        let isExtremeDelay = false;
        if (d?.check_in_at && thresholdMinutes != null) {
          const ci = new Date(d.check_in_at);
          const minutesOfDay = ci.getHours() * 60 + ci.getMinutes();
          if (extremeThresholdMinutes != null && minutesOfDay > extremeThresholdMinutes) isExtremeDelay = true;
          else if (minutesOfDay > thresholdMinutes) isDelay = true;
        }
        return {
          id: e.id,
          name: e.name,
          designation: e.designation || '—',
          inTime: d?.check_in_at ? formatTime(d.check_in_at) : '—',
          outTime: d?.check_out_at ? formatTime(d.check_out_at) : null,
          present: !!d?.present,
          holiday: d?.day_type ? (d.holiday_title || 'Holiday') : null,
          onLeaveToday: false, // filled in below once leaveApplications is cross-referenced
          isDelay,
          isExtremeDelay,
        };
      });
    // Cross-reference today's approved leave so someone on leave shows as
    // "Leave" instead of "Absent" — same approved-leave set the "On Leave
    // Today" stat tile above already computes.
    const onLeaveUserIds = new Set<number>();
    for (const a of leaveApplications || []) {
      if (a.status === 'approved' && a.start_date <= today && a.end_date >= today) onLeaveUserIds.add(Number(a.user_id));
    }
    const withLeave = rows.map((r) => {
      const e = employees.find((emp) => emp.id === r.id);
      const onLeave = e?.user_id ? onLeaveUserIds.has(Number(e.user_id)) : false;
      return { ...r, onLeaveToday: onLeave };
    });
    const q = search.trim().toLowerCase();
    return q ? withLeave.filter((r) => r.name.toLowerCase().includes(q) || r.designation.toLowerCase().includes(q)) : withLeave;
  }, [employees, attendanceReport, latePolicy, leaveApplications, today, search]);

  // Summary badges above the Quick View table — Total/Present/Absent/Leave/
  // Delay/Extreme Delay are all real counts from the data above.
  const quickViewSummary = useMemo(() => {
    if (!quickViewRows) return null;
    const total = quickViewRows.length;
    const onLeave = quickViewRows.filter((r) => r.onLeaveToday).length;
    const holiday = quickViewRows.filter((r) => r.holiday).length;
    const present = quickViewRows.filter((r) => r.present && !r.onLeaveToday).length;
    const absent = quickViewRows.filter((r) => !r.present && !r.onLeaveToday && !r.holiday).length;
    const delay = latePolicy ? quickViewRows.filter((r) => r.isDelay).length : null;
    const extremeDelay = latePolicy ? quickViewRows.filter((r) => r.isExtremeDelay).length : null;
    return { total, present, absent, onLeave, delay, extremeDelay, holiday };
  }, [quickViewRows, latePolicy]);

  // --- Current Leave Balance (allocated vs taken-this-year) ---
  const leaveBalanceRows = useMemo(() => {
    if (!leaveBalances) return null;
    const year = new Date().getFullYear();
    const takenByUser = new Map<number, number>();
    for (const a of leaveApplications || []) {
      if (a.status === 'approved' && String(a.start_date).slice(0, 4) === String(year)) {
        takenByUser.set(Number(a.user_id), (takenByUser.get(Number(a.user_id)) || 0) + Number(a.day_count || 0));
      }
    }
    return leaveBalances
      .map((b) => {
        const allocated = Number(b.casual_leave || 0) + Number(b.sick_leave || 0) + Number(b.leave_without_pay || 0);
        const taken = takenByUser.get(Number(b.user_id)) || 0;
        return {
          user_id: b.user_id,
          name: b.user_name,
          department: b.department || '—',
          allocated,
          taken,
          remaining: Math.max(allocated - taken, 0),
        };
      })
      .sort((a, b) => b.remaining - a.remaining);
  }, [leaveBalances, leaveApplications]);

  // --- Leave Calendar (company-wide month grid) ---
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const todayDateStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
  const calGridCells = useMemo(() => buildMonthGrid(calYear, calMonth), [calYear, calMonth]);
  const goPrevMonth = () => { if (calMonth === 0) { setCalYear((y) => y - 1); setCalMonth(11); } else { setCalMonth((m) => m - 1); } };
  const goNextMonth = () => { if (calMonth === 11) { setCalYear((y) => y + 1); setCalMonth(0); } else { setCalMonth((m) => m + 1); } };
  const calMonthLabel = new Date(calYear, calMonth, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });

  // Who's on leave which day, built entirely from leaveApplications already
  // fetched above (no extra request). Both 'approved' and 'pending' are
  // plotted — a pending one still occupies the roster, just shown lighter.
  const leaveByDate = useMemo(() => {
    const map = new Map<string, { user_id: number; name: string; status: string }[]>();
    if (!leaveApplications) return map;
    for (const a of leaveApplications) {
      if (a.status !== 'approved' && a.status !== 'pending') continue;
      const start = String(a.start_date);
      const end = String(a.end_date);
      // Only walk days that actually fall inside the grid currently on
      // screen, so a long leave application doesn't loop hundreds of dates.
      for (const cell of calGridCells) {
        if (cell.dateStr < start || cell.dateStr > end) continue;
        const list = map.get(cell.dateStr) || [];
        list.push({ user_id: Number(a.user_id), name: a.user_name || `User #${a.user_id}`, status: a.status });
        map.set(cell.dateStr, list);
      }
    }
    return map;
  }, [leaveApplications, calGridCells]);

  const holidayByDate = useMemo(() => {
    const map = new Map<string, { day_type: string; title: string }>();
    for (const h of holidays || []) map.set(String(h.entry_date), { day_type: h.day_type, title: h.title });
    return map;
  }, [holidays]);

  const statTiles: StatTile[] = [
    { key: 'leave_today', label: 'On Leave Today', icon: CalendarClock, value: onLeaveTodayCount != null ? String(onLeaveTodayCount) : null },
    { key: 'leave_tomorrow', label: 'On Leave Tomorrow', icon: CalendarDays, value: onLeaveTomorrowCount != null ? String(onLeaveTomorrowCount) : null },
    { key: 'pending_leave', label: 'Pending Leave Application', icon: ListChecks, value: pendingLeaveCount != null ? String(pendingLeaveCount) : null },
    { key: 'break_recon', label: 'Pending Break Time Recon.', icon: Clock3, value: null, comingSoon: true },
    { key: 'birthdays', label: 'Upcoming Birthdays', icon: Gift, value: null, comingSoon: true },
    { key: 'attendance_approval', label: 'Pending Attendance Approval', icon: Fingerprint, value: null, comingSoon: true },
    { key: 'claim_amount', label: 'Monthly Claim Amount', icon: Wallet, value: monthlyClaimAmount != null ? formatMoney(monthlyClaimAmount) : null },
    { key: 'disburse_amount', label: 'Monthly Disburse Amount', icon: Banknote, value: monthlyDisburseAmount != null ? formatMoney(monthlyDisburseAmount) : null },
    { key: 'attendance_recon', label: 'Pending Attendance Recon.', icon: ShieldAlert, value: null, comingSoon: true },
    { key: 'visit_today', label: 'On Visit Today', icon: MapPinned, value: null, comingSoon: true },
    { key: 'visit_tomorrow', label: 'On Visit Tomorrow', icon: MapPinned, value: null, comingSoon: true },
    { key: 'visit_pending', label: 'Pending Visit Application', icon: FileQuestion, value: null, comingSoon: true },
    { key: 'on_break', label: 'On Break Now', icon: Clock3, value: null, comingSoon: true },
    { key: 'status_effective', label: 'Status To Be Effective', icon: UserCog, value: null, comingSoon: true },
    { key: 'advance_salary', label: 'Pending Advance Salary', icon: HandCoins, value: pendingAdvances ? String(pendingAdvances.length) : null },
    { key: 'profile_image', label: 'Pending Profile Image', icon: ImageIcon, value: null, comingSoon: true },
    { key: 'asset_requisition', label: 'Pending Asset Requisition', icon: Package, value: pendingAssetReqs ? String(pendingAssetReqs.length) : null },
    { key: 'document_request', label: 'Pending Document Request', icon: ClipboardList, value: null, comingSoon: true },
  ];

  const maxAttendanceCount = attendanceSummary ? Math.max(1, attendanceSummary.headcount) : 1;
  const maxClaimChart = Math.max(1, ...claimChartData.map((d) => Math.max(d.claimSum, d.disbursedSum)));

  return (
    <div className="space-y-6">
      {/* Same pulsing skeleton style as Employee Directory (animate-pulse gray
          bars — see EmployeeDirectory.tsx's grid loading state) instead of the
          app-wide Infinity Lottie Spinner, but one placeholder per ACTUAL card
          below — stat tiles, Quick View table, both charts, Notice list,
          Leave Balance table and the Leave Calendar — each shaped/sized like
          its real counterpart, so the page doesn't jump around once the real
          content swaps in. */}
      {loading && (
        <>
          {/* Stat tiles skeleton — same grid + tile count as the real one below */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: statTiles.length }).map((_, i) => (
              <div key={i} className="rounded-2xl p-3.5 flex flex-col gap-2 border border-slate-200 bg-white animate-pulse">
                <div className="w-9 h-9 rounded-full bg-slate-200" />
                <div className="h-2.5 bg-slate-200 rounded w-3/4" />
                <div className="h-4 bg-slate-100 rounded w-1/2" />
              </div>
            ))}
          </div>

          {/* Quick View + Claim Amount skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="flex items-center justify-between mb-4">
                <div className="h-4 bg-slate-200 rounded w-24" />
                <div className="h-7 bg-slate-100 rounded-full w-40" />
              </div>
              <div className="flex flex-wrap gap-3 mb-4 pb-4 border-b border-slate-100">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-6 bg-slate-100 rounded-full w-20" />
                ))}
              </div>
              <div className="space-y-2.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-8 bg-slate-100 rounded-lg w-full" />
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-28 mb-4" />
              <div className="flex items-end justify-between gap-3 h-40 px-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-1 flex items-end justify-center gap-1 h-32">
                    <div className="w-1/2 rounded-t-md bg-slate-200" style={{ height: `${30 + (i % 3) * 20}%` }} />
                    <div className="w-1/2 rounded-t-md bg-slate-100" style={{ height: `${20 + (i % 4) * 15}%` }} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Attendance Summary + Notice skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-52 mb-4" />
              <div className="flex items-end gap-[3px] h-40 overflow-hidden">
                {Array.from({ length: 30 }).map((_, i) => (
                  <div key={i} className="flex flex-col items-center justify-end h-full shrink-0" style={{ minWidth: 8 }}>
                    <div className="w-2 rounded-t-sm bg-slate-100" style={{ height: `${20 + (i % 5) * 10}%` }} />
                    <div className="w-2 rounded-t-sm bg-slate-200" style={{ height: `${30 + (i % 4) * 12}%` }} />
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-16 mb-4" />
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-1.5 pb-3 border-b border-slate-50 last:border-0">
                    <div className="h-3 bg-slate-200 rounded w-3/4" />
                    <div className="h-2.5 bg-slate-100 rounded w-full" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Current Leave Balance + Attendance Missed skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-40 mb-4" />
              <div className="space-y-2.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-8 bg-slate-100 rounded-lg w-full" />
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm opacity-70 animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-32 mb-4" />
              <div className="h-16 bg-slate-100 rounded-lg" />
            </div>
          </div>

          {/* Leave Calendar + Task Status skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm animate-pulse">
              <div className="flex items-center justify-between mb-4">
                <div className="h-4 bg-slate-200 rounded w-28" />
                <div className="h-6 bg-slate-100 rounded-full w-28" />
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: 35 }).map((_, i) => (
                  <div key={i} className="min-h-[52px] rounded-lg bg-slate-100" />
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm opacity-70 animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-36 mb-4" />
              <div className="h-20 bg-slate-100 rounded-lg" />
            </div>
          </div>
        </>
      )}

      {!loading && (
        <>
          {/* Stat tiles — Liquid Glass style: translucent frosted cards over a
              soft blurred color wash, so the tiles actually catch light/color
              through them instead of just looking like flat white boxes. */}
          <div className="relative">
            <div className="pointer-events-none absolute -inset-x-4 -inset-y-8 -z-10 overflow-hidden rounded-[32px]">
              <div className="absolute -top-12 left-4 w-64 h-64 rounded-full blur-3xl opacity-40" style={{ background: '#3B82F6' }} />
              <div className="absolute -top-8 right-10 w-64 h-64 rounded-full blur-3xl opacity-40" style={{ background: '#A855F7' }} />
              <div className="absolute bottom-[-3rem] left-1/3 w-64 h-64 rounded-full blur-3xl opacity-30" style={{ background: '#10B981' }} />
              <div className="absolute bottom-[-2rem] right-1/4 w-56 h-56 rounded-full blur-3xl opacity-30" style={{ background: '#F97316' }} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {statTiles.map((tile, i) => {
                const iconColor = tileIconColorFor(i);
                return (
                  <div
                    key={tile.key}
                    className={`relative overflow-hidden rounded-2xl p-3.5 flex flex-col gap-1.5 backdrop-blur-xl backdrop-saturate-150 transition-all hover:-translate-y-0.5 hover:shadow-lg ${tile.comingSoon ? 'opacity-60' : ''}`}
                    style={{
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.55), rgba(255,255,255,0.22))',
                      border: '1px solid rgba(255,255,255,0.65)',
                      boxShadow:
                        'inset 0 1px 1px rgba(255,255,255,0.85), inset 0 -12px 20px -10px rgba(255,255,255,0.35), 0 8px 24px rgba(31,38,135,0.12)',
                    }}
                  >
                    {/* top glass sheen */}
                    <div
                      className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-2xl"
                      style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0))' }}
                    />

                    {tile.comingSoon && (
                      <span className="relative z-10 self-end text-[8px] font-semibold uppercase tracking-wide text-slate-500 bg-white/50 backdrop-blur-sm px-1.5 py-0.5 rounded-full border border-white/60">
                        Soon
                      </span>
                    )}
                    <span
                      className="relative z-10 w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                      style={{
                        background: tile.comingSoon ? 'rgba(148,163,184,0.55)' : iconColor,
                        boxShadow: `0 4px 14px ${iconColor}55, inset 0 1px 1px rgba(255,255,255,0.6)`,
                      }}
                    >
                      <tile.icon className="w-4 h-4 text-white" />
                    </span>
                    <div className="relative z-10">
                      <p className="text-[11px] font-medium text-slate-600 leading-snug mb-0.5">{tile.label}</p>
                      <p className={`text-lg font-extrabold tracking-tight ${tile.comingSoon ? 'text-slate-400' : 'text-slate-900'}`}>
                        {tile.value ?? '—'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick View + Claim Amount chart */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-blue-600" /> Quick View
                </h3>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search employee"
                    className="pl-7 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 w-40"
                  />
                </div>
              </div>

              {quickViewSummary && (
                <div className="flex flex-wrap items-center gap-3 mb-4 pb-4 border-b border-slate-100">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
                    <span className="w-6 h-6 rounded-full bg-slate-800 text-white flex items-center justify-center text-[10px] font-bold">{quickViewSummary.total}</span>
                    Total Employee
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600">
                    <span className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold">{quickViewSummary.present}</span>
                    Present
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-600">
                    <span className="w-6 h-6 rounded-full bg-rose-500 text-white flex items-center justify-center text-[10px] font-bold">{quickViewSummary.absent}</span>
                    Absent
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-600">
                    <span className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">{quickViewSummary.onLeave}</span>
                    Leave
                  </span>
                  <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${quickViewSummary.delay != null ? 'text-orange-600' : 'text-slate-300'}`}>
                    <span className={`w-6 h-6 rounded-full text-white flex items-center justify-center text-[10px] font-bold ${quickViewSummary.delay != null ? 'bg-orange-500' : 'bg-slate-200'}`}>
                      {quickViewSummary.delay != null ? quickViewSummary.delay : '—'}
                    </span>
                    Delay
                  </span>
                  <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${quickViewSummary.extremeDelay != null ? 'text-rose-600' : 'text-slate-300'}`}>
                    <span className={`w-6 h-6 rounded-full text-white flex items-center justify-center text-[10px] font-bold ${quickViewSummary.extremeDelay != null ? 'bg-rose-600' : 'bg-slate-200'}`}>
                      {quickViewSummary.extremeDelay != null ? quickViewSummary.extremeDelay : '—'}
                    </span>
                    Extreme Delay
                  </span>
                </div>
              )}

              {!quickViewRows && (
                <p className="text-xs text-slate-400 py-6 text-center">No data available.</p>
              )}
              {quickViewRows && quickViewRows.length === 0 && (
                <p className="text-xs text-slate-400 py-6 text-center">No matching employees.</p>
              )}
              {quickViewRows && quickViewRows.length > 0 && (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-2 py-2 font-semibold">Name</th>
                        <th className="px-2 py-2 font-semibold">Designation</th>
                        <th className="px-2 py-2 font-semibold">In Time</th>
                        <th className="px-2 py-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quickViewRows.slice(0, 6).map((r, i) => (
                        <tr key={r.id} className="border-b border-slate-50 last:border-0">
                          <td className="px-2 py-2.5 flex items-center gap-2 font-semibold text-slate-900">
                            <span
                              className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                              style={{ background: avatarColorFor(i) }}
                            >
                              {initialsOf(r.name)}
                            </span>
                            {r.name}
                          </td>
                          <td className="px-2 py-2.5 text-slate-500">{r.designation}</td>
                          <td className="px-2 py-2.5 text-slate-600">{r.inTime}</td>
                          <td className="px-2 py-2.5">
                            <span className={`px-2 py-0.5 rounded-md font-medium ${
                              r.holiday ? 'bg-amber-50 text-amber-600' :
                              r.onLeaveToday ? 'bg-blue-50 text-blue-600' :
                              r.present ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'
                            }`}>
                              {r.holiday ? r.holiday : r.onLeaveToday ? 'Leave' : r.present ? 'Present' : 'Absent'}
                            </span>
                            {r.isDelay && (
                              <span className="ml-1 px-1.5 py-0.5 rounded-md font-medium bg-orange-50 text-orange-600">Delay</span>
                            )}
                            {r.isExtremeDelay && (
                              <span className="ml-1 px-1.5 py-0.5 rounded-md font-medium bg-rose-50 text-rose-600">Extreme Delay</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                <Wallet className="w-4 h-4 text-blue-600" /> Claim Amount
              </h3>
              <div className="flex items-end justify-between gap-3 h-40 px-1">
                {claimChartData.map((d) => (
                  <div key={d.label} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full flex items-end justify-center gap-1 h-32">
                      <div
                        className="w-1/2 rounded-t-md bg-blue-600"
                        style={{ height: `${(d.claimSum / maxClaimChart) * 100}%`, minHeight: d.claimSum > 0 ? 4 : 0 }}
                        title={`Claim: ${formatMoney(d.claimSum)}`}
                      />
                      <div
                        className="w-1/2 rounded-t-md bg-blue-200"
                        style={{ height: `${(d.disbursedSum / maxClaimChart) * 100}%`, minHeight: d.disbursedSum > 0 ? 4 : 0 }}
                        title={`Disbursed: ${formatMoney(d.disbursedSum)}`}
                      />
                    </div>
                    <span className="text-[10px] text-slate-400 font-medium">{d.label}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-600 inline-block" /> Claim Amount</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-200 inline-block" /> Disbursed</span>
              </div>
            </div>
          </div>

          {/* Attendance Summary + Notice */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-blue-600" /> Attendance Summary (This Month)
              </h3>
              {!attendanceSummary && <p className="text-xs text-slate-400 py-6 text-center">No data available.</p>}
              {attendanceSummary && (
                <>
                  <div className="flex items-end gap-[3px] h-40 overflow-x-auto">
                    {attendanceSummary.byDay.map((d) => (
                      <div key={d.day} className="flex flex-col items-center justify-end h-full" style={{ minWidth: 8 }}>
                        <div
                          className="w-2 rounded-t-sm bg-rose-300"
                          style={{ height: `${(d.absent / maxAttendanceCount) * 100}%` }}
                          title={`Day ${d.day}: ${d.absent} absent`}
                        />
                        <div
                          className="w-2 rounded-t-sm bg-emerald-400"
                          style={{ height: `${(d.present / maxAttendanceCount) * 100}%` }}
                          title={`Day ${d.day}: ${d.present} present`}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Present</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-300 inline-block" /> Absent</span>
                  </div>
                </>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                <Bell className="w-4 h-4 text-blue-600" /> Notice
              </h3>
              {(!notices || notices.length === 0) && <p className="text-xs text-slate-400 py-6 text-center">No active notices.</p>}
              {notices && notices.length > 0 && (
                <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                  {notices.slice(0, 5).map((n) => (
                    <div key={n.id} className="border-b border-slate-50 last:border-0 pb-3 last:pb-0">
                      <p className="text-xs font-semibold text-slate-900">{n.title}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{n.message || n.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Current Leave Balance + Coming Soon: Attendance Missed */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-blue-600" /> Current Leave Balance
              </h3>
              {!leaveBalanceRows && <p className="text-xs text-slate-400 py-6 text-center">No data available.</p>}
              {leaveBalanceRows && leaveBalanceRows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-2 py-2 font-semibold">Name</th>
                        <th className="px-2 py-2 font-semibold">Department</th>
                        <th className="px-2 py-2 font-semibold">Allocated</th>
                        <th className="px-2 py-2 font-semibold">Taken</th>
                        <th className="px-2 py-2 font-semibold">Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaveBalanceRows.slice(0, 6).map((r) => (
                        <tr key={r.user_id} className="border-b border-slate-50 last:border-0">
                          <td className="px-2 py-2.5 font-semibold text-slate-900">{r.name}</td>
                          <td className="px-2 py-2.5 text-slate-500">{r.department}</td>
                          <td className="px-2 py-2.5 text-slate-600">{r.allocated}</td>
                          <td className="px-2 py-2.5 text-slate-600">{r.taken}</td>
                          <td className="px-2 py-2.5 font-semibold text-blue-600">{r.remaining}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm opacity-70">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-slate-400" /> Attendance Missed
                </h3>
                <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                  Coming Soon
                </span>
              </div>
              <p className="text-xs text-slate-400 py-6 text-center">No data available yet.</p>
            </div>
          </div>

          {/* Leave Calendar (now real, wired to leave applications + holidays) + Coming Soon: Task Status Overview */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-blue-600" /> Leave Calendar
                </h3>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={goPrevMonth} className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-blue-600 transition-colors" aria-label="Previous month">
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs font-semibold text-slate-700 w-28 text-center">{calMonthLabel}</span>
                  <button type="button" onClick={goNextMonth} className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-blue-600 transition-colors" aria-label="Next month">
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {!leaveApplications && <p className="text-xs text-slate-400 py-10 text-center">No data available.</p>}

              {leaveApplications && (
                <>
                  <div className="grid grid-cols-7 gap-1 mb-1">
                    {WEEKDAY_LABELS.map((w, i) => (
                      <div key={i} className="text-center text-[10px] font-semibold text-slate-400 py-1">{w}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {calGridCells.map((cell) => {
                      const holiday = holidayByDate.get(cell.dateStr);
                      const onLeave = leaveByDate.get(cell.dateStr) || [];
                      const isToday = cell.dateStr === todayDateStr;
                      return (
                        <div
                          key={cell.dateStr}
                          title={onLeave.length > 0 ? onLeave.map((p) => p.name).join(', ') : holiday?.title || undefined}
                          className={`min-h-[52px] rounded-lg p-1 border text-left flex flex-col gap-0.5 ${
                            !cell.inCurrentMonth ? 'border-transparent opacity-40' :
                            isToday ? 'border-blue-600 bg-blue-50' :
                            holiday ? 'border-amber-100 bg-amber-50/60' : 'border-slate-100'
                          }`}
                        >
                          <span className={`text-[10px] font-semibold ${isToday ? 'text-blue-600' : 'text-slate-600'}`}>{cell.day}</span>
                          {holiday && cell.inCurrentMonth && (
                            <span className="text-[8px] leading-tight text-amber-600 font-medium truncate">{holiday.title}</span>
                          )}
                          {onLeave.length > 0 && cell.inCurrentMonth && (
                            <div className="flex items-center gap-0.5 flex-wrap">
                              {onLeave.slice(0, 2).map((p, i2) => (
                                <span
                                  key={`${p.user_id}-${i2}`}
                                  className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white shrink-0"
                                  style={{ background: avatarColorFor(p.user_id), opacity: p.status === 'pending' ? 0.5 : 1 }}
                                >
                                  {initialsOf(p.name)[0]}
                                </span>
                              ))}
                              {onLeave.length > 2 && (
                                <span className="text-[7px] font-semibold text-slate-400">+{onLeave.length - 2}</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-600 inline-block" /> On Leave</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-600 inline-block opacity-50" /> Pending</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Holiday</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded border border-blue-600 inline-block" /> Today</span>
                  </div>
                </>
              )}
            </div>

            <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm opacity-70">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-slate-400" /> Task Status Overview
                </h3>
                <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                  Coming Soon
                </span>
              </div>
              <p className="text-xs text-slate-400 py-10 text-center">No Data Found</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};