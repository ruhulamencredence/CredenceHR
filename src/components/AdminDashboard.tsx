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
// requests, a company Leave Calendar overview, and Task management). They
// render as the same tile shape, greyed out with a "Coming Soon" pill,
// so the layout already has a slot for them the day those features exist —
// nothing here is a mocked/fake number.

import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, CalendarDays, Clock3, Wallet, Banknote, Package, HandCoins,
  Bell, Users, ListChecks, Gift, Fingerprint, MapPinned, FileQuestion,
  ImageIcon, ClipboardList, ShieldAlert, UserCog, Search,
} from 'lucide-react';
import { User } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

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
  const [attendanceRows, setAttendanceRows] = useState<any[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [
        leaveApps, balances, advances, assetReqs, claims, bills, activeNotices, empDir, attendance,
      ] = await Promise.all([
        safeGet<any[]>('/api/leave-applications', authHeaders),
        safeGet<any[]>('/api/leave-balances', authHeaders),
        safeGet<any[]>('/api/payroll/advance-requests?status=pending', authHeaders),
        safeGet<any[]>('/api/assets/requisitions?status=pending', authHeaders),
        safeGet<any[]>('/api/user-claims', authHeaders),
        safeGet<any[]>('/api/conveyance-bills', authHeaders),
        safeGet<any[]>('/api/notices/active', authHeaders),
        safeGet<any[]>('/api/employee-directory', authHeaders),
        safeGet<any[]>('/api/attendance', authHeaders),
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
      setAttendanceRows(attendance);
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
  const attendanceSummary = useMemo(() => {
    if (!attendanceRows || !employees) return null;
    const headcount = employees.filter((e) => e.is_active).length || employees.length;
    if (!headcount) return null;
    const now = new Date();
    const daysInMonth = now.getDate(); // up to today only — no data for future days yet
    const byDay: { day: number; present: number; absent: number }[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const present = new Set(attendanceRows.filter((r) => r.attendance_date === dateStr && r.check_in_at).map((r) => r.user_id)).size;
      byDay.push({ day, present, absent: Math.max(headcount - present, 0) });
    }
    return { headcount, byDay };
  }, [attendanceRows, employees]);

  // --- Quick View (today's attendance status per employee) ---
  const quickViewRows = useMemo(() => {
    if (!employees) return null;
    const byUser = new Map<number, any>();
    for (const r of attendanceRows || []) {
      if (r.attendance_date === today) byUser.set(Number(r.user_id), r);
    }
    const rows = employees
      .filter((e) => e.is_active && e.user_id)
      .map((e) => {
        const att = byUser.get(Number(e.user_id));
        return {
          id: e.id,
          name: e.name,
          designation: e.designation || '—',
          inTime: att ? formatTime(att.check_in_at) : '—',
          outTime: att?.check_out_at ? formatTime(att.check_out_at) : null,
          present: !!att?.check_in_at,
        };
      });
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.designation.toLowerCase().includes(q)) : rows;
  }, [employees, attendanceRows, today, search]);

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
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      )}

      {!loading && (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {statTiles.map((tile) => (
              <div
                key={tile.key}
                className={`bg-white border rounded-2xl p-4 shadow-sm flex flex-col gap-2 ${tile.comingSoon ? 'border-slate-100 opacity-70' : 'border-slate-200'}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${tile.comingSoon ? 'bg-slate-100' : 'bg-blue-50'}`}>
                    <tile.icon className={`w-[18px] h-[18px] ${tile.comingSoon ? 'text-slate-400' : 'text-blue-600'}`} />
                  </span>
                  {tile.comingSoon && (
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                      Coming Soon
                    </span>
                  )}
                </div>
                <p className="text-[11px] font-medium text-slate-500 leading-snug">{tile.label}</p>
                <p className={`text-lg font-bold ${tile.comingSoon ? 'text-slate-300' : 'text-slate-900'}`}>
                  {tile.value ?? '—'}
                </p>
              </div>
            ))}
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
                            <span className={`px-2 py-0.5 rounded-md font-medium ${r.present ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>
                              {r.present ? 'Present' : 'Absent'}
                            </span>
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

          {/* Coming Soon: Leave Calendar + Task Status Overview */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-slate-100 rounded-2xl p-5 shadow-sm opacity-70">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-slate-400" /> Leave Calendar
                </h3>
                <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                  Coming Soon
                </span>
              </div>
              <p className="text-xs text-slate-400 py-10 text-center">
                A company-wide "who's on leave, which day" calendar view is planned — not built yet.
              </p>
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
