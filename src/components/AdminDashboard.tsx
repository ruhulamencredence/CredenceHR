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
// Every stat tile/section below is wired to a REAL endpoint. Birthdays,
// attendance approvals/corrections, document requests, status-to-be-effective,
// HR alerts and the Task Status Overview come from /api/admin-dashboard/extras
// (AdminDashboardRoutes.ts). Tiles from the reference PDF this app has no
// feature for (visits, breaks, profile-image approval) are left out rather
// than shown greyed. A tile or task with a screen of its own opens it
// (onNavigate); one listing people opens a list.

import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, CalendarDays, Wallet, Banknote, Package, HandCoins,
  Bell, Users, ListChecks, Gift, Fingerprint,
  ClipboardList, ShieldAlert, UserCog, Search, ChevronLeft, ChevronRight, X, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { User } from '../types';
import { apiUrl } from '../lib/api';
import { useMyCompanies } from '../lib/company';

interface AdminDashboardProps {
  token: string;
  user: User;
  // Opens an Admin Panel tab (ignored when this account can't see it).
  onNavigate?: (tab: string) => void;
}

// One row of a tile's list (birthdays, pending approvals…).
interface ListRow {
  key: string;
  name: string;
  sub: string | null;
  right: string | null;
}
interface Person {
  name: string;
  employee_code: string | null;
  department: string | null;
  designation: string | null;
}
interface Extras {
  today: string;
  birthdays: (Person & { date: string; days_away: number; turning: number })[];
  attendance_approvals: (Person & { id: number; date: string | null })[];
  attendance_corrections: (Person & { id: number; date: string | null })[];
  documents: (Person & { id: string; kind: string; detail: string; date: string | null })[];
  status_effective: (Person & { id: number; action: string; date: string | null; status: string })[];
  tasks: { key: string; label: string; count: number; tab: string | null }[];
  alerts: (Person & { kind: string; label: string; date: string | null; days: number })[];
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return y && m && day ? `${day} ${SHORT_MONTHS[m - 1]}` : String(d);
}
const personSub = (p: Person) => [p.employee_code, p.designation, p.department].filter(Boolean).join(' · ') || null;
function inDays(n: number): string {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
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

function formatShortDate(d: string | null | undefined): string {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatLate(min: number): string {
  if (min <= 0) return '';
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m late` : `${min}m late`;
}

// Quick View summary badges -> the employee list each one opens.
type QuickViewFilter = 'total' | 'present' | 'absent' | 'leave' | 'delay' | 'extremeDelay';
const QUICK_VIEW_FILTER_TITLES: Record<QuickViewFilter, string> = {
  total: 'All Employees',
  present: 'Present Today',
  absent: 'Absent Today',
  leave: 'On Leave Today',
  delay: 'Delay Today',
  extremeDelay: 'Extreme Delay Today'
};

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
  onClick?: () => void; // set -> tile opens its Department-wise breakdown
}

// One person/application counted into a stat tile — used to build the
// Department-wise breakdown a tile's click opens (On Leave Today/Tomorrow,
// Pending Leave Application). `department` falls back to "Unassigned" for
// an Employee record with no Department set, so nobody counted just vanishes
// from the breakdown.
interface BreakdownEntry {
  user_id: number;
  name: string;
  department: string;
}

interface DepartmentGroup {
  department: string;
  entries: BreakdownEntry[];
}

function groupByDepartment(entries: BreakdownEntry[]): DepartmentGroup[] {
  const map = new Map<string, BreakdownEntry[]>();
  for (const e of entries) {
    const list = map.get(e.department) || [];
    list.push(e);
    map.set(e.department, list);
  }
  return Array.from(map.entries())
    .map(([department, list]) => ({ department, entries: list }))
    .sort((a, b) => b.entries.length - a.entries.length);
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ token, user, onNavigate }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  // Employees, attendance and leave: in the mother company the server answers
  // these for the whole group (mother + sister companies); in a sister
  // company, for that company only.
  const groupHeaders = useMemo(() => ({ ...authHeaders, 'X-Company-Scope': 'group' }), [authHeaders]);
  // In a sister company Quick View lists only that company's own employees
  // (not someone from another company who may also sign in to it).
  const myCompanies = useMyCompanies(token);
  const sisterCompanyId = useMemo(() => {
    if (!myCompanies) return null;
    const active = myCompanies.companies.find((c) => c.id === myCompanies.active_company_id);
    return active && !active.is_mother ? active.id : null;
  }, [myCompanies]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [quickViewDetail, setQuickViewDetail] = useState<QuickViewFilter | null>(null);
  const [quickViewDetailSearch, setQuickViewDetailSearch] = useState('');
  useEffect(() => {
    if (!quickViewDetail) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setQuickViewDetail(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quickViewDetail]);

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
  const [extras, setExtras] = useState<Extras | null>(null);
  const [openList, setOpenList] = useState<{ title: string; rows: ListRow[]; tab?: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const now0 = new Date();
      // Only the dates the dashboard shows: leave from the start of last year
      // (this year's taken days, the Leave Calendar) plus every pending one,
      // claims from the first of the month two months back (the 3-month chart).
      const leaveSince = `${now0.getFullYear() - 1}-01-01`;
      const claimsFrom = new Date(now0.getFullYear(), now0.getMonth() - 2, 1);
      const claimsSince = `${claimsFrom.getFullYear()}-${String(claimsFrom.getMonth() + 1).padStart(2, '0')}-01`;
      const [
        leaveApps, balances, advances, assetReqs, claims, bills, activeNotices, empDir, monthlyReport, holidayRows, latePolicyRows, extraRows,
      ] = await Promise.all([
        // /api/leave-applications/report, not the older /api/leave-applications
        // (a real-role-only "Self Service -> Leave Approvals" queue, hard-gated
        // to role admin/superadmin regardless of module_permissions) — this
        // report is the one already gated by the grantable 'leave_applications'
        // module, so an account granted Admin Dashboard + Monthly Leave
        // Application sees real figures here too, not just a Superadmin.
        safeGet<any[]>(`/api/leave-applications/report?since=${leaveSince}`, groupHeaders),
        safeGet<any[]>('/api/leave-balances', authHeaders),
        safeGet<any[]>('/api/payroll/advance-requests?status=pending', authHeaders),
        safeGet<any[]>('/api/assets/requisitions?status=pending', authHeaders),
        safeGet<any[]>(`/api/user-claims?since=${claimsSince}`, authHeaders),
        safeGet<any[]>('/api/conveyance-bills', authHeaders),
        safeGet<any[]>('/api/notices/active', authHeaders),
        safeGet<any[]>('/api/employee-directory', groupHeaders),
        safeGet<{ year: number; month: number; days_in_month: number; users: any[] }>(
          `/api/attendance/report/monthly?year=${now0.getFullYear()}&month=${now0.getMonth() + 1}`,
          groupHeaders
        ),
        safeGet<any[]>('/api/holidays', authHeaders),
        safeGet<any[]>('/api/payroll/late-policy', authHeaders),
        safeGet<Extras>('/api/admin-dashboard/extras', authHeaders),
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
      setExtras(extraRows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const today = todayStr(0);
  const tomorrow = todayStr(1);
  const thisMonth = todayStr(0).slice(0, 7);

  // "user_id" -> Department, from the same company-wide roster the Leave
  // Balance table already reads (employees' Department mirror column —
  // see resolveEmployeeDepartment in server.ts). Falls back to
  // "Unassigned" in groupByDepartment for anyone with no Department set,
  // rather than dropping them from a breakdown silently.
  const deptByUserId = useMemo(() => {
    const map = new Map<number, string>();
    for (const e of employees || []) {
      if (e.user_id) map.set(Number(e.user_id), e.department || 'Unassigned');
    }
    return map;
  }, [employees]);

  // --- On Leave Today / Tomorrow / Pending Leave Application ---
  // "On Leave" here means the application has cleared its first Approval
  // Layer (supervisor_layer_approved, from GET /api/leave-applications — see
  // that route's comment) — not necessarily the WHOLE chain yet. Once the
  // first reviewer (the Department Supervisor auto-layer where configured)
  // has signed off, the person is genuinely away starting that date, however
  // many more Layers are still pending above it, so counting only a fully
  // 'approved' chain understated who's actually out. The Leave Calendar
  // below uses the same signal.
  const onLeaveTodayEntries = useMemo(() => {
    if (!leaveApplications) return null;
    const seen = new Set<number>();
    const out: BreakdownEntry[] = [];
    for (const a of leaveApplications) {
      if (!a.supervisor_layer_approved || a.start_date > today || a.end_date < today) continue;
      const uid = Number(a.user_id);
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push({ user_id: uid, name: a.user_name || `User #${uid}`, department: deptByUserId.get(uid) || 'Unassigned' });
    }
    return out;
  }, [leaveApplications, today, deptByUserId]);

  const onLeaveTomorrowEntries = useMemo(() => {
    if (!leaveApplications) return null;
    const seen = new Set<number>();
    const out: BreakdownEntry[] = [];
    for (const a of leaveApplications) {
      if (!a.supervisor_layer_approved || a.start_date > tomorrow || a.end_date < tomorrow) continue;
      const uid = Number(a.user_id);
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push({ user_id: uid, name: a.user_name || `User #${uid}`, department: deptByUserId.get(uid) || 'Unassigned' });
    }
    return out;
  }, [leaveApplications, tomorrow, deptByUserId]);

  // Every 'pending' Leave Application (one entry per application, not
  // deduped by user — a person can have more than one pending request), for
  // "Pending Leave Application"'s own Department-wise breakdown.
  const pendingLeaveEntries = useMemo(() => {
    if (!leaveApplications) return null;
    return leaveApplications
      .filter((a) => a.status === 'pending')
      .map((a) => ({
        user_id: Number(a.user_id),
        name: a.user_name || `User #${a.user_id}`,
        department: deptByUserId.get(Number(a.user_id)) || 'Unassigned'
      }));
  }, [leaveApplications, deptByUserId]);

  const onLeaveTodayCount = onLeaveTodayEntries?.length ?? null;
  const onLeaveTomorrowCount = onLeaveTomorrowEntries?.length ?? null;
  const pendingLeaveCount = pendingLeaveEntries?.length ?? null;

  // Which stat tile's Department-wise breakdown is currently open (On Leave
  // Today/Tomorrow, Pending Leave Application) — null when none is.
  const [openBreakdown, setOpenBreakdown] = useState<{ title: string; entries: BreakdownEntry[] } | null>(null);

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
    // Only the employees the attendance report covers — the company (or, in
    // the mother company, the whole group). The directory can be wider: it
    // shows a Superadmin the whole group from any company.
    const rows = employees
      .filter((e) => e.is_active && e.user_id && byUser.has(Number(e.user_id)))
      .filter((e) => sisterCompanyId == null || e.company_id == null || Number(e.company_id) === sisterCompanyId)
      .map((e) => {
        const u = byUser.get(Number(e.user_id));
        const d = u?.days?.[todayDay - 1];
        let isDelay = false;
        let isExtremeDelay = false;
        let lateMinutes = 0;
        if (d?.check_in_at && thresholdMinutes != null) {
          const ci = new Date(d.check_in_at);
          const minutesOfDay = ci.getHours() * 60 + ci.getMinutes();
          if (extremeThresholdMinutes != null && minutesOfDay > extremeThresholdMinutes) isExtremeDelay = true;
          else if (minutesOfDay > thresholdMinutes) isDelay = true;
          if (isDelay || isExtremeDelay) lateMinutes = minutesOfDay - (thresholdMinutes - Number(latePolicy?.grace_minutes || 0));
        }
        return {
          id: e.id,
          name: e.name,
          designation: e.designation || '—',
          department: e.department || 'Unassigned',
          employeeCode: e.employee_id || '',
          lateMinutes,
          inTime: d?.check_in_at ? formatTime(d.check_in_at) : '—',
          outTime: d?.check_out_at ? formatTime(d.check_out_at) : null,
          present: !!d?.present,
          holiday: d?.day_type ? (d.holiday_title || 'Holiday') : null,
          onLeaveToday: false, // filled in below once leaveApplications is cross-referenced
          isDelay,
          isExtremeDelay,
        };
      });
    // Cross-reference today's Leave so someone on leave shows as "Leave"
    // instead of "Absent" — same supervisor_layer_approved set the "On Leave
    // Today" stat tile above already computes (see its comment).
    const onLeaveUserIds = new Set<number>(onLeaveTodayEntries?.map((e) => e.user_id) || []);
    // Today's leave (type and dates) per user, for the Leave detail list.
    const leaveByUser = new Map<number, string>();
    for (const a of leaveApplications || []) {
      if (!a.supervisor_layer_approved || a.start_date > today || a.end_date < today) continue;
      const uid = Number(a.user_id);
      if (leaveByUser.has(uid)) continue;
      const dates = a.start_date === a.end_date ? formatShortDate(a.start_date) : `${formatShortDate(a.start_date)} – ${formatShortDate(a.end_date)}`;
      leaveByUser.set(uid, `${a.leave_type_label || a.leave_type || 'Leave'} · ${dates}`);
    }
    const withLeave = rows.map((r) => {
      const e = employees.find((emp) => emp.id === r.id);
      const onLeave = e?.user_id ? onLeaveUserIds.has(Number(e.user_id)) : false;
      return { ...r, onLeaveToday: onLeave, leaveInfo: onLeave && e?.user_id ? leaveByUser.get(Number(e.user_id)) || null : null };
    });
    const q = search.trim().toLowerCase();
    return q ? withLeave.filter((r) => r.name.toLowerCase().includes(q) || r.designation.toLowerCase().includes(q)) : withLeave;
  }, [employees, attendanceReport, latePolicy, leaveApplications, today, search, onLeaveTodayEntries, sisterCompanyId]);

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
  // plotted — an application still stuck on its first Approval Layer is
  // shown lighter (isLeave: false), but one that's already
  // supervisor_layer_approved shows solid, same as a fully 'approved' one —
  // see the On Leave Today/Tomorrow comment above for why.
  const leaveByDate = useMemo(() => {
    const map = new Map<string, { user_id: number; name: string; isLeave: boolean }[]>();
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
        list.push({ user_id: Number(a.user_id), name: a.user_name || `User #${a.user_id}`, isLeave: !!a.supervisor_layer_approved });
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

  const go = (tab: string) => (onNavigate ? () => onNavigate(tab) : undefined);
  // A tile counting people/requests: click opens their list.
  function listTile<T>(
    key: string, label: string, icon: StatTile['icon'], list: T[] | undefined, row: (x: T) => ListRow, title: string, tab?: string,
  ): StatTile {
    return {
      key, label, icon,
      value: list ? String(list.length) : null,
      onClick: list && list.length > 0 ? () => setOpenList({ title, rows: list.map(row), tab }) : tab ? go(tab) : undefined,
    };
  }

  // --- Attendance Missed: nobody checked in today (not on leave or a
  // holiday), and yesterday's check-ins with no check-out. ---
  const attendanceMissed = useMemo(() => {
    if (!quickViewRows || !attendanceReport || !employees) return null;
    const out: { key: string; name: string; designation: string; what: string }[] = [];
    for (const r of quickViewRows) if (!r.present && !r.onLeaveToday && !r.holiday) out.push({ key: `t-${r.id}`, name: r.name, designation: r.designation, what: 'No check-in today' });
    const yDay = new Date().getDate() - 1;
    if (yDay >= 1) {
      const byUser = new Map<number, any>(attendanceReport.users.map((u) => [Number(u.user_id), u]));
      for (const e of employees) {
        if (!e.is_active || !e.user_id) continue;
        const d = byUser.get(Number(e.user_id))?.days?.[yDay - 1];
        if (d?.check_in_at && !d.check_out_at) out.push({ key: `y-${e.id}`, name: e.name, designation: e.designation || '—', what: 'No check-out yesterday' });
      }
    }
    return out;
  }, [quickViewRows, attendanceReport, employees]);

  const statTiles: StatTile[] = [
    {
      key: 'leave_today', label: 'On Leave Today', icon: CalendarClock, value: onLeaveTodayCount != null ? String(onLeaveTodayCount) : null,
      onClick: onLeaveTodayEntries && onLeaveTodayEntries.length > 0
        ? () => setOpenBreakdown({ title: 'On Leave Today', entries: onLeaveTodayEntries })
        : undefined
    },
    {
      key: 'leave_tomorrow', label: 'On Leave Tomorrow', icon: CalendarDays, value: onLeaveTomorrowCount != null ? String(onLeaveTomorrowCount) : null,
      onClick: onLeaveTomorrowEntries && onLeaveTomorrowEntries.length > 0
        ? () => setOpenBreakdown({ title: 'On Leave Tomorrow', entries: onLeaveTomorrowEntries })
        : undefined
    },
    {
      key: 'pending_leave', label: 'Pending Leave Application', icon: ListChecks, value: pendingLeaveCount != null ? String(pendingLeaveCount) : null,
      onClick: pendingLeaveEntries && pendingLeaveEntries.length > 0
        ? () => setOpenBreakdown({ title: 'Pending Leave Application', entries: pendingLeaveEntries })
        : undefined
    },
    listTile('birthdays', 'Upcoming Birthdays', Gift, extras?.birthdays, (b) => ({
      key: `${b.employee_code}-${b.date}`,
      name: b.name,
      sub: personSub(b),
      right: `${b.days_away === 0 ? 'Today' : shortDate(b.date)} · turns ${b.turning}`,
    }), 'Upcoming Birthdays (next 7 days)'),
    listTile('attendance_approval', 'Pending Attendance Approval', Fingerprint, extras?.attendance_approvals, (a) => ({
      key: `a-${a.id}`, name: a.name, sub: personSub(a), right: shortDate(a.date),
    }), 'Remote check-in/out waiting for approval', 'approvals'),
    { key: 'claim_amount', label: 'Monthly Claim Amount', icon: Wallet, value: monthlyClaimAmount != null ? formatMoney(monthlyClaimAmount) : null, onClick: go('claims') },
    { key: 'disburse_amount', label: 'Monthly Disburse Amount', icon: Banknote, value: monthlyDisburseAmount != null ? formatMoney(monthlyDisburseAmount) : null, onClick: go('disbursement') },
    listTile('attendance_recon', 'Pending Attendance Recon.', ShieldAlert, extras?.attendance_corrections, (c) => ({
      key: `c-${c.id}`, name: c.name, sub: personSub(c), right: shortDate(c.date),
    }), 'Attendance corrections waiting for review'),
    listTile('status_effective', 'Status To Be Effective', UserCog, extras?.status_effective, (a) => ({
      key: `s-${a.id}`, name: a.name, sub: `${a.action}${a.status === 'pending' ? ' (awaiting approval)' : ''}`, right: shortDate(a.date),
    }), 'Personnel actions taking effect', 'hr_operations'),
    { key: 'advance_salary', label: 'Pending Advance Salary', icon: HandCoins, value: pendingAdvances ? String(pendingAdvances.length) : null },
    { key: 'asset_requisition', label: 'Pending Asset Requisition', icon: Package, value: pendingAssetReqs ? String(pendingAssetReqs.length) : null, onClick: go('asset_management') },
    listTile('document_request', 'Pending Document Request', ClipboardList, extras?.documents, (d) => ({
      key: d.id, name: d.name, sub: `${d.kind} · ${d.detail}`, right: shortDate(d.date),
    }), 'Document requests', 'hr_operations'),
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            {Array.from({ length: statTiles.length }).map((_, i) => (
              <div key={i} className="rounded-2xl px-3 py-3 sm:px-5 sm:py-4 flex items-center gap-2.5 sm:gap-3.5 bg-white/70 animate-pulse">
                <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-slate-200 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-2.5 bg-slate-200 rounded w-3/4" />
                  <div className="h-4 bg-slate-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>

          {/* Quick View + Claim Amount skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 border border-slate-200 rounded-2xl p-5 animate-pulse">
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
            <div className="border border-slate-200 rounded-2xl p-5 animate-pulse">
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
            <div className="lg:col-span-2 border border-slate-200 rounded-2xl p-5 animate-pulse">
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
            <div className="border border-slate-200 rounded-2xl p-5 animate-pulse">
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
            <div className="lg:col-span-2 border border-slate-200 rounded-2xl p-5 animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-40 mb-4" />
              <div className="space-y-2.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-8 bg-slate-100 rounded-lg w-full" />
                ))}
              </div>
            </div>
            <div className="border border-slate-100 rounded-2xl p-5 opacity-70 animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-32 mb-4" />
              <div className="h-16 bg-slate-100 rounded-lg" />
            </div>
          </div>

          {/* Leave Calendar + Task Status skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 border border-slate-200 rounded-2xl p-5 animate-pulse">
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
            <div className="border border-slate-100 rounded-2xl p-5 opacity-70 animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-36 mb-4" />
              <div className="h-20 bg-slate-100 rounded-lg" />
            </div>
          </div>
        </>
      )}

      {!loading && (
        <>
          {/* Stat tiles — compact horizontal cards: a soft tinted circle with
              the coloured icon on the left, the label above a large value on
              the right, on a plain white card. The first tile is filled with
              the brand gradient as the row's highlight. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            {statTiles.map((tile, i) => {
              const iconColor = tile.comingSoon ? '#94A3B8' : tileIconColorFor(i);
              const featured = i === 0 && !tile.comingSoon;
              return (
                <div
                  key={tile.key}
                  onClick={tile.onClick}
                  role={tile.onClick ? 'button' : undefined}
                  tabIndex={tile.onClick ? 0 : undefined}
                  className={`relative flex items-center gap-2.5 sm:gap-3.5 rounded-2xl px-3 py-3 sm:px-5 sm:py-4 transition-all hover:-translate-y-0.5 ${
                    featured
                      ? 'text-white shadow-[0_12px_28px_-12px_rgba(127,0,255,0.65)]'
                      : 'bg-white/90 border border-white shadow-[0_6px_20px_-12px_rgba(31,38,135,0.25)] hover:shadow-[0_12px_28px_-14px_rgba(31,38,135,0.35)]'
                  } ${tile.comingSoon ? 'opacity-60' : ''} ${tile.onClick ? 'cursor-pointer' : ''}`}
                  style={featured ? { background: 'var(--g-gradient)' } : undefined}
                >
                  <span
                    className="w-9 h-9 sm:w-11 sm:h-11 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: featured ? 'rgba(255,255,255,0.2)' : `${iconColor}1A` }}
                  >
                    <tile.icon className="w-4 h-4 sm:w-5 sm:h-5" style={{ color: featured ? '#fff' : iconColor }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11px] sm:text-xs leading-snug line-clamp-2 sm:truncate ${featured ? 'text-white/80' : 'text-slate-500'}`} title={tile.label}>{tile.label}</p>
                    <p className={`mt-0.5 text-lg sm:text-xl font-bold tracking-tight ${featured ? 'text-white' : tile.comingSoon ? 'text-slate-400' : 'text-slate-900'}`}>
                      {tile.value ?? '—'}
                    </p>
                  </div>
                  {tile.comingSoon && (
                    <span className="absolute top-2 right-2.5 text-[8px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full">
                      Soon
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* HR alerts: probation / contract ends and document expiries */}
          {extras && extras.alerts.length > 0 && (
            <div className="bg-white border border-amber-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" /> HR Alerts
                <span className="text-[11px] font-medium text-slate-400">next 30 days</span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {extras.alerts.map((a, i) => (
                  <button
                    key={`${a.kind}-${a.employee_code}-${a.date}-${i}`}
                    type="button"
                    onClick={() => onNavigate?.(a.kind === 'document' ? 'document_vault' : 'hr_operations')}
                    className={`text-left text-xs px-3 py-2 rounded-lg border ${a.days < 0 ? 'bg-rose-50 border-rose-200' : 'bg-amber-50/60 border-amber-200'} hover:shadow-sm`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 truncate">{a.name}</span>
                      <span className={`text-[10px] font-bold shrink-0 ${a.days < 0 ? 'text-rose-600' : 'text-amber-700'}`}>{inDays(a.days)}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {a.label} · {shortDate(a.date)}
                      {a.employee_code ? ` · ${a.employee_code}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

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
                <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-4 border-b border-slate-100">
                  {([
                    ['total', quickViewSummary.total, 'Total Employee', 'text-slate-600', 'bg-slate-800'],
                    ['present', quickViewSummary.present, 'Present', 'text-emerald-600', 'bg-emerald-500'],
                    ['absent', quickViewSummary.absent, 'Absent', 'text-rose-600', 'bg-rose-500'],
                    ['leave', quickViewSummary.onLeave, 'Leave', 'text-blue-600', 'bg-blue-600'],
                    ['delay', quickViewSummary.delay, 'Delay', 'text-orange-600', 'bg-orange-500'],
                    ['extremeDelay', quickViewSummary.extremeDelay, 'Extreme Delay', 'text-rose-600', 'bg-rose-600'],
                  ] as [QuickViewFilter, number | null, string, string, string][]).map(([key, count, label, text, bg]) => (
                    <button
                      key={key}
                      type="button"
                      disabled={count == null}
                      onClick={() => {
                        setQuickViewDetailSearch('');
                        setQuickViewDetail(key);
                      }}
                      title={count == null ? 'Set a late policy to count delays' : `See ${label.toLowerCase()} list`}
                      className={`flex items-center gap-1.5 text-[11px] font-semibold rounded-full pl-1 pr-2.5 py-1 transition-colors ${
                        count == null ? 'text-slate-300 cursor-default' : `${text} hover:bg-slate-100`
                      }`}
                    >
                      <span className={`w-6 h-6 rounded-full text-white flex items-center justify-center text-[10px] font-bold ${count == null ? 'bg-slate-200' : bg}`}>
                        {count == null ? '—' : count}
                      </span>
                      {label}
                    </button>
                  ))}
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

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-blue-600" /> Attendance Missed
                </h3>
                {attendanceMissed && attendanceMissed.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-bold">
                    {attendanceMissed.length}
                  </span>
                )}
              </div>
              {!attendanceMissed && <p className="text-xs text-slate-400 py-6 text-center">No data available.</p>}
              {attendanceMissed && attendanceMissed.length === 0 && <p className="text-xs text-emerald-600 py-6 text-center">Everyone is accounted for.</p>}
              {attendanceMissed && attendanceMissed.length > 0 && (
                <div className="space-y-1.5 overflow-y-auto max-h-72 -mr-1 pr-1">
                  {attendanceMissed.map((m) => (
                    <div key={m.key} className="flex items-center gap-2 text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-100 rounded-lg">
                      <span className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ background: avatarColorFor(m.name.length) }}>
                        {initialsOf(m.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-slate-800 font-semibold truncate">{m.name}</span>
                        <span className="block text-[10px] text-slate-400 truncate">{m.designation}</span>
                      </span>
                      <span className={`text-[10px] font-semibold shrink-0 ${m.key.startsWith('t-') ? 'text-rose-600' : 'text-orange-600'}`}>{m.what}</span>
                    </div>
                  ))}
                </div>
              )}
              {onNavigate && (
                <button type="button" onClick={() => onNavigate('attendance_reports')} className="mt-3 self-end text-[11px] font-semibold text-blue-600 hover:underline flex items-center gap-1">
                  Attendance report <ArrowRight className="w-3 h-3" />
                </button>
              )}
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
                                  style={{ background: avatarColorFor(p.user_id), opacity: p.isLeave ? 1 : 0.5 }}
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

            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-blue-600" /> Task Status Overview
                </h3>
                {extras && (
                  <span className="text-[11px] font-semibold text-slate-500">{extras.tasks.reduce((n, t) => n + t.count, 0)} waiting</span>
                )}
              </div>
              {!extras && <p className="text-xs text-slate-400 py-10 text-center">No data available.</p>}
              {extras && (
                <div className="space-y-1">
                  {extras.tasks.map((t) => {
                    const clickable = !!(onNavigate && t.tab && t.count > 0);
                    return (
                      <button
                        key={t.key}
                        type="button"
                        disabled={!clickable}
                        onClick={() => clickable && onNavigate!(t.tab!)}
                        className={`w-full flex items-center justify-between gap-2 text-xs px-2.5 py-2 rounded-lg border ${t.count > 0 ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-100'} ${clickable ? 'hover:border-blue-300 hover:bg-blue-50/40' : 'cursor-default'}`}
                      >
                        <span className={t.count > 0 ? 'text-slate-700 font-medium' : 'text-slate-400'}>{t.label}</span>
                        <span className="flex items-center gap-1">
                          <span
                            className={`inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full text-[11px] font-bold ${t.count > 0 ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}
                          >
                            {t.count}
                          </span>
                          {clickable && <ArrowRight className="w-3 h-3 text-slate-400" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Quick View detail — opened by clicking one of the Quick View
          summary badges (Total / Present / Absent / Leave / Delay / Extreme
          Delay): every employee in that group, today. */}
      {quickViewDetail && quickViewRows && (() => {
        const match = (r: (typeof quickViewRows)[number]) =>
          quickViewDetail === 'total' ? true :
          quickViewDetail === 'present' ? r.present && !r.onLeaveToday :
          quickViewDetail === 'absent' ? !r.present && !r.onLeaveToday && !r.holiday :
          quickViewDetail === 'leave' ? r.onLeaveToday :
          quickViewDetail === 'delay' ? r.isDelay : r.isExtremeDelay;
        const q = quickViewDetailSearch.trim().toLowerCase();
        const rows = quickViewRows
          .filter(match)
          .filter((r) => !q || [r.name, r.designation, r.department, r.employeeCode].some((v) => String(v || '').toLowerCase().includes(q)))
          .sort((a, b) =>
            quickViewDetail === 'delay' || quickViewDetail === 'extremeDelay'
              ? b.lateMinutes - a.lateMinutes
              : a.department.localeCompare(b.department) || a.name.localeCompare(b.name)
          );
        const total = quickViewRows.filter(match).length;
        const statusOf = (r: (typeof quickViewRows)[number]) =>
          r.holiday ? { label: r.holiday, cls: 'bg-amber-50 text-amber-600' } :
          r.onLeaveToday ? { label: 'Leave', cls: 'bg-blue-50 text-blue-600' } :
          r.present ? { label: 'Present', cls: 'bg-emerald-50 text-emerald-700' } : { label: 'Absent', cls: 'bg-rose-50 text-rose-600' };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => setQuickViewDetail(null)}>
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden" role="dialog" aria-label={QUICK_VIEW_FILTER_TITLES[quickViewDetail]} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900">{QUICK_VIEW_FILTER_TITLES[quickViewDetail]}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {total} employee{total === 1 ? '' : 's'} &middot; {formatShortDate(today)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative hidden sm:block">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      value={quickViewDetailSearch}
                      onChange={(e) => setQuickViewDetailSearch(e.target.value)}
                      placeholder="Search"
                      className="pl-7 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 w-44"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuickViewDetail(null)}
                    className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="sm:hidden px-5 pt-3">
                <input
                  value={quickViewDetailSearch}
                  onChange={(e) => setQuickViewDetailSearch(e.target.value)}
                  placeholder="Search"
                  className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div className="overflow-auto px-3 py-3">
                {rows.length === 0 ? (
                  <p className="text-xs text-slate-400 py-8 text-center">{total === 0 ? 'Nobody in this list today.' : 'No matching employees.'}</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-2 py-2 font-semibold">Employee</th>
                        <th className="px-2 py-2 font-semibold">Department</th>
                        <th className="px-2 py-2 font-semibold">In</th>
                        <th className="px-2 py-2 font-semibold">Out</th>
                        <th className="px-2 py-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const st = statusOf(r);
                        return (
                          <tr key={r.id} className="border-b border-slate-50 last:border-0 align-top">
                            <td className="px-2 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ background: avatarColorFor(i) }}>
                                  {initialsOf(r.name)}
                                </span>
                                <div className="min-w-0">
                                  <div className="font-semibold text-slate-900">{r.name}</div>
                                  <div className="text-[10px] text-slate-400">
                                    {[r.employeeCode, r.designation !== '—' ? r.designation : ''].filter(Boolean).join(' · ') || '—'}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-2 py-2.5 text-slate-600">{r.department}</td>
                            <td className="px-2 py-2.5 text-slate-700 whitespace-nowrap">{r.inTime}</td>
                            <td className="px-2 py-2.5 text-slate-700 whitespace-nowrap">{r.outTime || '—'}</td>
                            <td className="px-2 py-2.5">
                              <span className={`px-2 py-0.5 rounded-md font-medium ${st.cls}`}>{st.label}</span>
                              {r.isDelay && <span className="ml-1 px-1.5 py-0.5 rounded-md font-medium bg-orange-50 text-orange-600">Delay</span>}
                              {r.isExtremeDelay && <span className="ml-1 px-1.5 py-0.5 rounded-md font-medium bg-rose-50 text-rose-600">Extreme Delay</span>}
                              {r.lateMinutes > 0 && <div className="text-[10px] text-orange-600 mt-1">{formatLate(r.lateMinutes)}</div>}
                              {r.leaveInfo && <div className="text-[10px] text-blue-600 mt-1">{r.leaveInfo}</div>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Department-wise breakdown — opened by clicking On Leave Today/
          Tomorrow or Pending Leave Application above. */}
      {openList && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => setOpenList(null)}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-900">{openList.title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{openList.rows.length} total</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenList(null)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4 space-y-1.5">
              {openList.rows.map((r) => (
                <div key={r.key} className="flex items-center gap-2 text-xs px-2.5 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ background: avatarColorFor(r.name.length) }}>
                    {initialsOf(r.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-slate-800 font-semibold truncate">{r.name}</span>
                    {r.sub && <span className="block text-[10px] text-slate-400 truncate">{r.sub}</span>}
                  </span>
                  {r.right && <span className="text-[10px] font-semibold text-blue-600 shrink-0">{r.right}</span>}
                </div>
              ))}
            </div>
            {openList.tab && onNavigate && (
              <div className="px-5 py-3 border-t border-slate-100 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    const tab = openList.tab!;
                    setOpenList(null);
                    onNavigate(tab);
                  }}
                  className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1"
                >
                  Open <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {openBreakdown && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
          onClick={() => setOpenBreakdown(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-900">{openBreakdown.title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{openBreakdown.entries.length} total &middot; by Department</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenBreakdown(null)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4 space-y-4">
              {groupByDepartment(openBreakdown.entries).map((g) => (
                <div key={g.department}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-slate-700">{g.department}</span>
                    <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold">
                      {g.entries.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {g.entries.map((e, idx) => (
                      <div key={`${e.user_id}-${idx}`} className="flex items-center gap-2 text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-100 rounded-lg">
                        <span
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                          style={{ background: avatarColorFor(e.user_id) }}
                        >
                          {initialsOf(e.name)}
                        </span>
                        <span className="text-slate-700 font-medium truncate">{e.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};