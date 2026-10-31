// Admin Panel -> Management Dashboard (AdminModuleKey "management_dashboard";
// ManagementDashboardRoutes.ts): the whole company for one month, compared
// with the month before. Every card and row opens a details panel on the
// right with the breakdown behind it, and the panel exports to Excel.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { X, Download, RefreshCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { LoadingBlock } from './LoadingBlock';
import { MultiSelectFilter } from './MultiSelectFilter';

interface Dash {
  month: string;
  prev_month: string;
  today: string;
  departments: string[];
  kpis: {
    headcount: { value: number; prev: number };
    attendance: { value: number | null; prev: number | null; late_pct: number | null };
    salary: { value: number; prev: number; paid: boolean };
    on_leave_today: { value: number; tomorrow: number; pending: number };
    approvals: { waiting: number; stuck: number; avg_days: number | null };
    targets: { value: number | null; prev: number | null };
  };
  flow: { month: string; label: string; joined: number; left: number }[];
  headcount_by_department: { department: string; count: number; joined: number; left: number }[];
  attendance_by_department: { department: string; people: number; present_pct: number; late_pct: number; prev_present_pct: number | null }[];
  salary_by_department: { department: string; amount: number; prev: number; people: number }[];
  on_leave_today: { name: string; department: string; leave_type: string; until: string | null }[];
  money: { key: string; label: string; source: string; amount: number; prev: number }[];
  approvals_by_type: { type: string; label: string; waiting: number; stuck: number; avg_days: number | null; oldest_days: number }[];
  approvals_oldest: { id: number; label: string; requester: string; department: string; layer: string; waiting_on: string | null; days: number }[];
  projects: { project: string; value: number; prev_value: number; mpr_rows: number; on_the_way: number; received: number; share_of_max: number }[];
  targets_by_department: { department: string; pct: number; prev: number | null; count: number; done: number; overdue: number }[];
  ops: { mpr_rows: number; material_on_the_way: number; tasks_done: number };
  workforce: { joined: number; left: number; probation: number; in_notice: number; avg_tenure_years: number | null; male: number; female: number };
  recruitment: { open_positions: number; applied: number; interview: number; offered: number; hired: number };
  fleet: { rides: number; vehicles_busy_pct: number | null; assets_in_use: number; awaiting_ack: number };
  attention: { level: 'high' | 'medium' | 'info'; title: string; detail: string; target: string }[];
}

type DrawerKey = 'headcount' | 'attendance' | 'salary' | 'leave' | 'approvals' | 'targets' | 'money' | 'projects';
interface Drawer {
  kicker: string;
  title: string;
  sub: string;
  stats: [string, string][];
  head: [string, string, string];
  rows: { a: string; b: string; c: string; tone?: 'good' | 'bad' | 'warn' }[];
}

const UP = '#047857';
const DOWN = '#b91c1c';
const FLAT = '#5b5570';
const PALETTE = ['#7c5ce6', '#f6c58f', '#b9aaf5', '#8ecdf0', '#8fd6c4', '#f19a9a'];

const taka = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e7) return `৳${(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `৳${(n / 1e5).toFixed(1)} L`;
  return `৳${Math.round(n).toLocaleString('en-US')}`;
};
const pctChange = (now: number, prev: number) => (prev ? Math.round(((now - prev) / prev) * 1000) / 10 : null);
// Signed change text; `goodWhenUp` decides the colour.
const trend = (now: number | null, prev: number | null, unit: '%' | 'pt' | '' , goodWhenUp: boolean) => {
  if (now == null || prev == null) return { text: '—', color: FLAT };
  const diff = unit === '%' ? pctChange(now, prev) : Math.round((now - prev) * 10) / 10;
  if (diff == null || diff === 0) return { text: 'same as last month', color: FLAT };
  const up = diff > 0;
  return { text: `${up ? '+' : ''}${diff}${unit === '%' ? '%' : unit === 'pt' ? ' pt' : ''} vs last month`, color: up === goodWhenUp ? UP : DOWN };
};
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

const card = 'bg-white border border-[#e7e3f3] rounded-[20px] p-5 flex flex-col gap-3';
const rowBtn = 'w-full text-left rounded-lg px-1.5 -mx-1.5 py-1 hover:bg-violet-50/70 transition-colors';

export const ManagementDashboard: React.FC<{ token: string }> = ({ token }) => {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [depts, setDepts] = useState<string[]>([]);
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<DrawerKey | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ month });
      if (depts.length) qs.set('departments', depts.join(','));
      const res = await fetch(apiUrl(`/api/management-dashboard?${qs}`), { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load the dashboard.');
      setData(body);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, month, depts]);
  useEffect(() => {
    load();
  }, [load]);
  useLiveRefresh(() => load());

  const drawer: Drawer | null = useMemo(() => {
    if (!data || !open) return null;
    const k = data.kpis;
    const tone = (n: number | null | undefined, goodWhenUp: boolean): 'good' | 'bad' | undefined => (n == null || n === 0 ? undefined : n > 0 === goodWhenUp ? 'good' : 'bad');
    const signed = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}`);
    switch (open) {
      case 'headcount':
        return {
          kicker: 'PEOPLE',
          title: `Headcount — ${k.headcount.value.toLocaleString('en-US')}`,
          sub: `Active employees by department, ${monthName(data.month)}`,
          stats: [[k.headcount.value.toLocaleString('en-US'), 'Active'], [`+${data.workforce.joined} / -${data.workforce.left}`, 'Joined / left'], [String(data.workforce.probation), 'On probation']],
          head: ['Department', 'People', 'Joined / left'],
          rows: data.headcount_by_department.map((d) => ({ a: d.department, b: d.count.toLocaleString('en-US'), c: `+${d.joined} / -${d.left}`, tone: tone(d.joined - d.left, true) }))
        };
      case 'attendance':
        return {
          kicker: 'ATTENDANCE',
          title: `Attendance — ${k.attendance.value ?? '—'}%`,
          sub: 'Present (or on approved leave) on working days, by department',
          stats: [[`${k.attendance.value ?? '—'}%`, 'Present'], [`${k.attendance.late_pct ?? '—'}%`, 'Late'], [`${k.attendance.prev ?? '—'}%`, 'Last month']],
          head: ['Department', 'Present', 'Late'],
          rows: data.attendance_by_department.map((d) => ({ a: `${d.department} · ${d.people}`, b: `${d.present_pct}%`, c: `${d.late_pct}%`, tone: d.late_pct >= 10 ? 'bad' : undefined }))
        };
      case 'salary':
        return {
          kicker: 'MONEY',
          title: `Salary cost — ${taka(k.salary.value)}`,
          sub: `${monthName(data.month)} payroll by department${k.salary.paid ? ', paid' : ''}`,
          stats: [[taka(k.salary.value), 'Net salary'], [trend(k.salary.value, k.salary.prev, '%', false).text.replace(' vs last month', ''), 'vs last month'], [data.salary_by_department.reduce((a, d) => a + d.people, 0).toLocaleString('en-US'), 'People paid']],
          head: ['Department', 'Net salary', 'vs last month'],
          rows: data.salary_by_department.map((d) => {
            const ch = pctChange(d.amount, d.prev);
            return { a: d.department, b: taka(d.amount), c: ch == null ? '—' : `${signed(ch)}%`, tone: tone(ch, false) };
          })
        };
      case 'leave':
        return {
          kicker: 'PEOPLE',
          title: `On leave today — ${k.on_leave_today.value}`,
          sub: `Approved leave on ${data.today}`,
          stats: [[String(k.on_leave_today.value), 'Today'], [String(k.on_leave_today.tomorrow), 'Tomorrow'], [String(k.on_leave_today.pending), 'Waiting approval']],
          head: ['Employee', 'Leave', 'Until'],
          rows: data.on_leave_today.map((l) => ({ a: `${l.name} · ${l.department}`, b: l.leave_type, c: l.until || '—' }))
        };
      case 'approvals':
        return {
          kicker: 'APPROVALS',
          title: `Waiting for approval — ${k.approvals.waiting}`,
          sub: 'Oldest first — who is holding them',
          stats: [[String(k.approvals.waiting), 'Waiting'], [String(k.approvals.stuck), 'Stuck 3+ days'], [k.approvals.avg_days == null ? '—' : `${k.approvals.avg_days} d`, 'Average to decide']],
          head: ['Request', 'Waiting on', 'Days'],
          rows: data.approvals_oldest.map((r) => ({ a: `${r.label} · ${r.requester}`, b: r.waiting_on || `Layer ${r.layer}`, c: `${r.days} d`, tone: r.days >= 3 ? 'bad' : undefined }))
        };
      case 'targets':
        return {
          kicker: 'PERFORMANCE',
          title: `Targets achieved — ${k.targets.value ?? '—'}%`,
          sub: `${monthName(data.month)} targets by department`,
          stats: [[`${k.targets.value ?? '—'}%`, 'Achieved'], [String(data.targets_by_department.reduce((a, t) => a + t.done, 0)), 'Fully done'], [String(data.targets_by_department.reduce((a, t) => a + t.overdue, 0)), 'Overdue']],
          head: ['Department', 'Achieved', 'vs last month'],
          rows: data.targets_by_department.map((t) => ({ a: `${t.department} · ${t.count}`, b: `${t.pct}%`, c: t.prev == null ? '—' : `${signed(Math.round((t.pct - t.prev) * 10) / 10)} pt`, tone: t.prev == null ? undefined : tone(t.pct - t.prev, true) }))
        };
      case 'money': {
        const total = data.money.reduce((a, m) => a + m.amount, 0);
        const prevTotal = data.money.reduce((a, m) => a + m.prev, 0);
        return {
          kicker: 'MONEY',
          title: `Money out — ${taka(total)}`,
          sub: `Everything paid out in ${monthName(data.month)}`,
          stats: [[taka(total), 'Total'], [pctChange(total, prevTotal) == null ? '—' : `${signed(pctChange(total, prevTotal))}%`, 'vs last month'], [taka(prevTotal), 'Last month']],
          head: ['Item', 'Amount', 'vs last month'],
          rows: data.money.map((m) => {
            const ch = pctChange(m.amount, m.prev);
            return { a: m.label, b: taka(m.amount), c: ch == null ? '—' : `${signed(ch)}%`, tone: tone(ch, false) };
          })
        };
      }
      case 'projects':
        return {
          kicker: 'PEPM',
          title: 'Projects — MPR this month',
          sub: 'MPR value entered (rate × quantity), material on the way and received',
          stats: [[String(data.ops.mpr_rows), 'MPR rows'], [String(data.ops.material_on_the_way), 'On the way'], [taka(data.projects.reduce((a, p) => a + p.value, 0)), 'MPR value']],
          head: ['Project', 'MPR value', 'On the way / received'],
          rows: data.projects.map((p) => ({ a: `${p.project} · ${p.mpr_rows} rows`, b: taka(p.value), c: `${p.on_the_way} / ${p.received}` }))
        };
    }
    return null;
  }, [data, open]);

  const exportDrawer = () => {
    if (!drawer) return;
    const ws = XLSX.utils.json_to_sheet(drawer.rows.map((r) => ({ [drawer.head[0]]: r.a, [drawer.head[1]]: r.b, [drawer.head[2]]: r.c })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Details');
    XLSX.writeFile(wb, `${drawer.title.split(' — ')[0].replace(/[^A-Za-z0-9]+/g, '-')}-${data?.month}.xlsx`);
  };

  if (loading && !data) return <LoadingBlock />;
  if (error && !data) return <div className="p-6 text-sm text-rose-600">{error}</div>;
  if (!data) return null;
  const k = data.kpis;
  // Payroll for this month not generated yet: say so instead of "-100%".
  const salaryNotRun = k.salary.value === 0 && k.salary.prev > 0;
  const moneyRows = data.money.map((m) => (m.key === 'salary' && salaryNotRun ? { ...m, source: 'Payroll not run yet', prev: 0 } : m));

  const kpis: { key: DrawerKey; label: string; value: string; trend: { text: string; color: string }; source: string }[] = [
    { key: 'headcount', label: 'Headcount', value: k.headcount.value.toLocaleString('en-US'), trend: trend(k.headcount.value, k.headcount.prev, '', true), source: 'Employees · active' },
    { key: 'attendance', label: 'Attendance', value: k.attendance.value == null ? '—' : `${k.attendance.value}%`, trend: trend(k.attendance.value, k.attendance.prev, 'pt', true), source: 'Office + remote + site' },
    { key: 'salary', label: 'Salary cost', value: salaryNotRun ? 'Not run yet' : taka(k.salary.value), trend: salaryNotRun ? { text: `Last month ${taka(k.salary.prev)}`, color: FLAT } : trend(k.salary.value, k.salary.prev, '%', false), source: k.salary.paid ? 'Payroll · paid' : 'Payroll' },
    { key: 'leave', label: 'On leave today', value: String(k.on_leave_today.value), trend: { text: `${k.on_leave_today.tomorrow} tomorrow`, color: FLAT }, source: 'Leave Applications' },
    { key: 'approvals', label: 'Waiting for approval', value: String(k.approvals.waiting), trend: { text: k.approvals.stuck ? `${k.approvals.stuck} stuck 3+ days` : 'none stuck', color: k.approvals.stuck ? DOWN : UP }, source: 'Approval engine' },
    { key: 'targets', label: 'Targets achieved', value: k.targets.value == null ? '—' : `${k.targets.value}%`, trend: trend(k.targets.value, k.targets.prev, 'pt', true), source: 'Target Reports' }
  ];
  const flowMax = Math.max(1, ...data.flow.map((f) => Math.max(f.joined, f.left)));
  const gridStep = Math.max(1, Math.ceil(flowMax / 3));
  const moneyTotal = moneyRows.reduce((a, m) => a + m.amount, 0);
  const moneyPrev = moneyRows.reduce((a, m) => a + m.prev, 0);
  const donut = (() => {
    if (!moneyTotal) return '#efecf8';
    let at = 0;
    const parts: string[] = [];
    moneyRows.forEach((m, i) => {
      const w = (m.amount / moneyTotal) * 100;
      if (w <= 0) return;
      parts.push(`${PALETTE[i % PALETTE.length]} ${at}% ${Math.max(at, at + w - 0.6)}%`, `#ffffff ${Math.max(at, at + w - 0.6)}% ${at + w}%`);
      at += w;
    });
    return `conic-gradient(from -90deg, ${parts.join(', ')})`;
  })();
  const dot = { high: '#ef4444', medium: '#f59e0b', info: '#60a5fa' } as const;
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    return d.toISOString().slice(0, 7);
  });

  return (
    <div className="relative font-[Inter,system-ui,sans-serif] text-[#1e1b2e]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[26px] font-extrabold tracking-tight">Management Dashboard</h1>
            <p className="text-[13px] text-[#5b5570]">The whole company in {monthName(data.month)}, compared with the month before. Click any card or row for the details.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#5b5570]">
              Month
              <select value={month} onChange={(e) => setMonth(e.target.value)} className="h-10 px-3 border border-[#ddd8ee] rounded-xl bg-white text-sm font-medium text-[#1e1b2e]">
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <MultiSelectFilter label="Department" options={data.departments.map((d) => ({ value: d, label: d }))} selected={depts} onChange={setDepts} />
            </div>
            <button type="button" onClick={load} className="h-10 px-3 rounded-xl border border-[#ddd8ee] bg-white text-[#5b5570] hover:bg-slate-50 flex items-center gap-1.5 text-sm" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>

        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          {kpis.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setOpen(c.key)}
              className={`text-left rounded-[18px] px-[18px] py-4 flex flex-col gap-1.5 border transition-shadow ${open === c.key ? 'bg-[#f5f0ff] border-[#6d28d9] shadow-[0_0_0_3px_#ddd2fb]' : 'bg-white border-[#e7e3f3] hover:shadow-md'}`}
            >
              <span className="text-xs font-semibold text-[#5b5570]">{c.label}</span>
              <span className="text-[26px] font-extrabold tracking-tight">{c.value}</span>
              <span className="text-xs font-semibold" style={{ color: c.trend.color }}>
                {c.trend.text}
              </span>
              <span className="text-[11px] text-[#6b6585]">{c.source} · details →</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-5 items-start">
          <div className="flex flex-col gap-5 min-w-0" style={{ flex: '999 1 760px' }}>
            <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">People — joined and left</h2>
                  <span className="text-[11px] text-[#6b6585]">last 6 months</span>
                </div>
                <button type="button" onClick={() => setOpen('headcount')} className="relative h-[190px] pl-7 text-left" aria-label="Joined and left, last 6 months — open headcount details">
                  {[0, 1, 2, 3].map((g) => (
                    <React.Fragment key={g}>
                      <span className="absolute left-7 right-0 border-t border-dashed border-[#ebe8f4]" style={{ bottom: 24 + (g * gridStep * 130) / (gridStep * 3) }} />
                      <span className="absolute left-0 w-[22px] text-right text-[10px] text-[#9a94b0]" style={{ bottom: 18 + (g * gridStep * 130) / (gridStep * 3) }}>
                        {g * gridStep}
                      </span>
                    </React.Fragment>
                  ))}
                  <span className="absolute left-7 right-0 top-0 bottom-6 flex items-end justify-around">
                    {data.flow.map((f) => (
                      <span key={f.month} className="flex items-end gap-1.5">
                        <span className="flex flex-col items-center gap-1">
                          <span className="text-[11px] font-bold text-[#4c1d95]">{f.joined}</span>
                          <span className="block w-[22px] bg-[#7c5ce6] rounded-t-[7px] rounded-b-[3px]" style={{ height: (f.joined / (gridStep * 3)) * 130 }} title="Joined" />
                        </span>
                        <span className="flex flex-col items-center gap-1">
                          <span className="text-[11px] font-bold text-[#9a5b13]">{f.left}</span>
                          <span className="block w-[22px] bg-[#f6c58f] rounded-t-[7px] rounded-b-[3px]" style={{ height: (f.left / (gridStep * 3)) * 130 }} title="Left" />
                        </span>
                      </span>
                    ))}
                  </span>
                  <span className="absolute left-7 right-0 bottom-0 h-5 flex justify-around">
                    {data.flow.map((f) => (
                      <span key={f.month} className="w-[50px] text-center text-[11px] font-semibold text-[#6b6585]">
                        {f.label}
                      </span>
                    ))}
                  </span>
                </button>
                <div className="flex flex-wrap gap-4 text-xs text-[#5b5570]">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px] bg-[#7c5ce6]" />Joined</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px] bg-[#f6c58f]" />Left</span>
                  <span className="ml-auto font-semibold text-[#1e1b2e]">
                    {k.headcount.value ? `Left this month ${Math.round((data.workforce.left / k.headcount.value) * 1000) / 10}%` : ''}
                  </span>
                </div>
              </section>

              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">Attendance by department</h2>
                  <span className="text-[11px] text-[#6b6585]">present · late</span>
                </div>
                {data.attendance_by_department.length === 0 && <p className="text-sm text-slate-400">No attendance yet this month.</p>}
                {data.attendance_by_department.map((d) => (
                  <button key={d.department} type="button" onClick={() => setOpen('attendance')} className={`${rowBtn} grid items-center gap-2.5 text-xs`} style={{ gridTemplateColumns: '110px minmax(0,1fr) 44px 44px' }}>
                    <span className="font-semibold truncate">{d.department}</span>
                    <span className="flex gap-0.5 h-3 bg-[#f3f1f9] rounded-full overflow-hidden">
                      <span className="block bg-[#9b87f0] rounded-full" style={{ width: `${Math.max(0, d.present_pct - d.late_pct)}%` }} />
                      <span className="block bg-[#f6c58f] rounded-full" style={{ width: `${d.late_pct}%` }} />
                    </span>
                    <span className="text-right font-bold">{d.present_pct}%</span>
                    <span className="text-right font-semibold text-[#9a5b13]">{d.late_pct}%</span>
                  </button>
                ))}
              </section>
            </div>

            <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">Money out this month</h2>
                  <span className="text-[11px] text-[#6b6585]">৳ · vs last month</span>
                </div>
                <div className="flex flex-wrap gap-5 items-center">
                  <button type="button" onClick={() => setOpen('money')} className="relative w-[168px] h-[168px] shrink-0 rounded-full" style={{ background: donut }} aria-label="Money out by type — open details">
                    <span className="absolute inset-6 rounded-full bg-white flex flex-col items-center justify-center shadow-[inset_0_0_0_1px_#f1eff8]">
                      <span className="text-[11px] text-[#6b6585]">Total</span>
                      <span className="text-[22px] font-extrabold tracking-tight">{taka(moneyTotal)}</span>
                      <span className="text-[11px] font-semibold" style={{ color: trend(moneyTotal, moneyPrev, '%', false).color }}>
                        {pctChange(moneyTotal, moneyPrev) == null ? '' : `${(pctChange(moneyTotal, moneyPrev) as number) > 0 ? '+' : ''}${pctChange(moneyTotal, moneyPrev)}% vs last`}
                      </span>
                    </span>
                  </button>
                  <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
                    {moneyRows.map((m, i) => {
                      const t = trend(m.amount, m.prev, '%', false);
                      return (
                        <button key={m.key} type="button" onClick={() => setOpen(m.key === 'salary' ? 'salary' : 'money')} className={`${rowBtn} grid items-center gap-2.5 text-[13px]`} style={{ gridTemplateColumns: '14px minmax(0,1fr) auto 64px' }}>
                          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: PALETTE[i % PALETTE.length] }} />
                          <span>
                            {m.label}
                            <span className="block text-[11px] text-[#6b6585]">{m.source}</span>
                          </span>
                          <span className="font-bold">
                            {taka(m.amount)}{' '}
                            <span className="text-[11px] font-semibold text-[#6b6585]">· {moneyTotal ? Math.round((m.amount / moneyTotal) * 100) : 0}%</span>
                          </span>
                          <span className="text-right text-xs font-semibold" style={{ color: t.color }}>
                            {pctChange(m.amount, m.prev) == null ? '—' : `${(pctChange(m.amount, m.prev) as number) > 0 ? '+' : ''}${pctChange(m.amount, m.prev)}%`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">Approvals — how fast</h2>
                  <span className="text-[11px] text-[#6b6585]">waiting now · avg days to decide</span>
                </div>
                {data.approvals_by_type.length === 0 && <p className="text-sm text-slate-400">Nothing waiting.</p>}
                {data.approvals_by_type.map((a) => {
                  const d = a.avg_days ?? 0;
                  const badge = a.stuck > 0 || d > 3 ? ['Slow', '#fee2e2', '#b91c1c'] : d > 1.5 ? ['OK', '#fef3c7', '#92400e'] : ['Fast', '#dcfce7', '#166534'];
                  return (
                    <button key={a.type} type="button" onClick={() => setOpen('approvals')} className={`${rowBtn} grid items-center gap-2.5 text-[13px] py-1.5 border-b border-[#f1eff8]`} style={{ gridTemplateColumns: 'minmax(0,1fr) 60px 70px 64px' }}>
                      <span>{a.label}</span>
                      <span className="text-right font-bold">{a.waiting}</span>
                      <span className="text-right text-[#5b5570]">{a.avg_days == null ? '—' : `${a.avg_days} d`}</span>
                      <span className="text-center text-[11px] font-bold py-0.5 rounded-full" style={{ background: badge[1], color: badge[2] }}>
                        {badge[0]}
                      </span>
                    </button>
                  );
                })}
              </section>
            </div>

            <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">Projects — MPR this month (PEPM)</h2>
                  <span className="text-[11px] text-[#6b6585]">value entered · material</span>
                </div>
                {data.projects.length === 0 && <p className="text-sm text-slate-400">No MPR entered this month.</p>}
                {data.projects.slice(0, 6).map((p) => (
                  <button key={p.project} type="button" onClick={() => setOpen('projects')} className={`${rowBtn} flex flex-col gap-1.5`}>
                    <span className="flex justify-between text-[13px] w-full">
                      <span className="font-semibold">{p.project}</span>
                      <span className="text-[#5b5570]">
                        <span className="font-bold text-[#1e1b2e]">{taka(p.value)}</span> · {p.mpr_rows} rows
                      </span>
                    </span>
                    <span className="block w-full h-2.5 bg-[#f3f1f9] rounded-full overflow-hidden">
                      <span className="block h-2.5 bg-[#9b87f0] rounded-full" style={{ width: `${p.share_of_max}%` }} />
                    </span>
                    <span className="text-[11px] text-[#6b6585]">
                      {p.on_the_way} on the way · {p.received} received this month
                    </span>
                  </button>
                ))}
              </section>

              <section className={card}>
                <div className="flex justify-between items-baseline">
                  <h2 className="text-[15px] font-bold">Targets by department</h2>
                  <span className="text-[11px] text-[#6b6585]">achieved this month</span>
                </div>
                {data.targets_by_department.length === 0 && <p className="text-sm text-slate-400">No targets for this month.</p>}
                {data.targets_by_department.map((t) => (
                  <button key={t.department} type="button" onClick={() => setOpen('targets')} className={`${rowBtn} grid items-center gap-2.5 text-xs`} style={{ gridTemplateColumns: '110px minmax(0,1fr) 48px' }}>
                    <span className="font-semibold truncate">{t.department}</span>
                    <span className="block h-3 bg-[#f3f1f9] rounded-full overflow-hidden">
                      <span className="block h-3 rounded-full" style={{ width: `${Math.min(100, t.pct)}%`, background: t.pct >= 90 ? '#7cc9a3' : t.pct >= 70 ? '#9b87f0' : '#f6c58f' }} />
                    </span>
                    <span className="text-right font-bold">{t.pct}%</span>
                  </button>
                ))}
                <div className="grid grid-cols-3 gap-2.5 mt-1.5">
                  {[
                    [data.ops.mpr_rows, 'MPR rows'],
                    [data.ops.material_on_the_way, 'Material on the way'],
                    [data.ops.tasks_done, 'Tasks done']
                  ].map(([v, l]) => (
                    <div key={String(l)} className="bg-[#f7f5fd] rounded-[14px] px-3 py-2.5">
                      <div className="text-xl font-extrabold">{Number(v).toLocaleString('en-US')}</div>
                      <div className="text-[11px] text-[#5b5570]">{l}</div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <div className="flex flex-col gap-5 min-w-0" style={{ flex: '1 1 340px', maxWidth: 460 }}>
            <section className="bg-[#1e1b2e] text-white rounded-[20px] p-5 flex flex-col gap-3">
              <h2 className="text-[15px] font-bold">Needs attention</h2>
              {data.attention.length === 0 && <p className="text-sm text-[#c9c4dc]">Nothing needs attention right now.</p>}
              {data.attention.map((n, i) => (
                <button key={i} type="button" onClick={() => setOpen((n.target as DrawerKey) || 'headcount')} className="w-full text-left flex gap-2.5 items-start px-3 py-2.5 bg-[#2b2740] hover:bg-[#35304d] rounded-[14px]">
                  <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: dot[n.level] }} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-semibold">{n.title}</span>
                    <span className="text-xs text-[#c9c4dc]">{n.detail} · open →</span>
                  </span>
                </button>
              ))}
            </section>

            <section className={card}>
              <h2 className="text-[15px] font-bold">Workforce</h2>
              {[
                ['Joined this month', data.workforce.joined],
                ['Left this month', data.workforce.left],
                ['On probation', data.workforce.probation],
                ['Resignations in progress', data.workforce.in_notice],
                ['Average tenure', data.workforce.avg_tenure_years == null ? '—' : `${data.workforce.avg_tenure_years} yrs`],
                [
                  'Male / Female',
                  data.workforce.male + data.workforce.female
                    ? `${Math.round((data.workforce.male / (data.workforce.male + data.workforce.female)) * 100)}% / ${Math.round((data.workforce.female / (data.workforce.male + data.workforce.female)) * 100)}%`
                    : '—'
                ]
              ].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between text-[13px] py-1 border-b border-[#f1eff8]">
                  <span className="text-[#5b5570]">{l}</span>
                  <span className="font-bold">{v}</span>
                </div>
              ))}
            </section>

            <section className={card}>
              <h2 className="text-[15px] font-bold">Recruitment pipeline</h2>
              {(() => {
                const r = data.recruitment;
                const stages: [string, number][] = [['Open positions', r.open_positions], ['Applied', r.applied], ['Interview', r.interview], ['Offered', r.offered], ['Hired', r.hired]];
                const max = Math.max(1, ...stages.map((s) => s[1]));
                return stages.map(([s, n]) => (
                  <div key={s} className="grid items-center gap-2.5 text-xs" style={{ gridTemplateColumns: '96px minmax(0,1fr) 36px' }}>
                    <span className="text-[#5b5570]">{s}</span>
                    <span className="block h-[18px] bg-[#ddd2fb] rounded-md" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
                    <span className="text-right font-bold">{n}</span>
                  </div>
                ));
              })()}
            </section>

            <section className={card}>
              <h2 className="text-[15px] font-bold">Fleet and assets</h2>
              {[
                ['Rides this month', data.fleet.rides],
                ['Vehicles on a ride now', data.fleet.vehicles_busy_pct == null ? '—' : `${data.fleet.vehicles_busy_pct}%`],
                ['Assets in use', data.fleet.assets_in_use.toLocaleString('en-US')],
                ['Assets awaiting acknowledgement', data.fleet.awaiting_ack]
              ].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between text-[13px]">
                  <span className="text-[#5b5570]">{l}</span>
                  <span className="font-bold">{v}</span>
                </div>
              ))}
            </section>
          </div>
        </div>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-[70] bg-[rgba(30,27,46,0.35)]" onClick={() => setOpen(null)}>
          <aside
            role="dialog"
            aria-label={drawer.title}
            onClick={(e) => e.stopPropagation()}
            className="absolute top-0 right-0 bottom-0 w-full sm:w-[520px] bg-white shadow-[-18px_0_40px_rgba(30,27,46,0.25)] flex flex-col"
          >
            <div className="px-6 pt-5 pb-4 border-b border-[#ece9f5] flex gap-3 items-start">
              <div className="flex-1 flex flex-col gap-1">
                <span className="text-[11px] font-bold tracking-[0.06em] text-[#6d28d9]">{drawer.kicker}</span>
                <h2 className="text-xl font-extrabold">{drawer.title}</h2>
                <span className="text-[13px] text-[#5b5570]">{drawer.sub}</span>
              </div>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="w-10 h-10 rounded-full border border-[#e7e3f3] flex items-center justify-center text-[#5b5570] hover:bg-slate-50">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-4 grid grid-cols-3 gap-2.5">
              {drawer.stats.map(([v, l]) => (
                <div key={l} className="bg-[#f7f5fd] rounded-[14px] px-3 py-2.5">
                  <div className="text-lg font-extrabold">{v}</div>
                  <div className="text-[11px] text-[#5b5570]">{l}</div>
                </div>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-6">
              <div className="grid gap-2 text-[11px] font-bold text-[#6b6585] py-2 border-b border-[#ece9f5] sticky top-0 bg-white" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)' }}>
                <span>{drawer.head[0]}</span>
                <span className="text-right">{drawer.head[1]}</span>
                <span className="text-right">{drawer.head[2]}</span>
              </div>
              {drawer.rows.length === 0 && <p className="py-6 text-center text-sm text-slate-400">Nothing to show.</p>}
              {drawer.rows.map((r, i) => (
                <div key={i} className="grid gap-2 text-[13px] py-2.5 border-b border-[#f1eff8]" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)' }}>
                  <span className="font-semibold">{r.a}</span>
                  <span className="text-right">{r.b}</span>
                  <span className="text-right font-semibold" style={{ color: r.tone === 'good' ? UP : r.tone === 'bad' ? DOWN : '#1e1b2e' }}>
                    {r.c}
                  </span>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-[#ece9f5] flex gap-2.5">
              <button type="button" onClick={exportDrawer} disabled={drawer.rows.length === 0} className="flex-1 h-11 rounded-xl bg-[#6d28d9] text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                <Download className="w-4 h-4" /> Export Excel
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};
