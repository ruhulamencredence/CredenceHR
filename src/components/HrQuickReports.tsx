/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Reports -> Quick reports (HrQuickReports.ts): five ready
// reports, one click each — Probation / Confirmation, New joiners,
// Transfers, Resignations, Religion. Period and Department can be changed;
// Excel / PDF in one click. Shown only with the hr_operations layer
// "quick_reports" (the API checks the same).

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileSpreadsheet, FileDown } from 'lucide-react';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform, saveWorkbookCrossPlatform } from '../lib/saveFile';
import { STD_STYLES, STD_HEAD } from '../lib/pdfStandard';
import credenceLogo from '../assets/credence-logo.png';
import { pdfSafe } from './HrOps360Parts';
import { useHrApi, Notice, fmtDate, btnGhost } from './HrOpsShared';
import { SearchSelect } from './Combobox';
import { LoadingBlock } from './LoadingBlock';

import { type QuickKind, type QuickSummary, QUICK_KIND_STORAGE_KEY, QUICK_KINDS as ALL_KINDS, quickCardText, otHours } from './hrQuickShared';

type PeriodKey = 'this_month' | 'last_month' | 'last_3' | 'this_year' | 'custom';
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m is 1-based
function periodRange(p: PeriodKey, today: string, custom: { from: string; to: string }) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const month = (yy: number, mm: number) => ({ from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}` });
  if (p === 'this_month') return month(y, m);
  if (p === 'last_month') return m === 1 ? month(y - 1, 12) : month(y, m - 1);
  if (p === 'last_3') {
    const s = m <= 2 ? { y: y - 1, m: m + 10 } : { y, m: m - 2 };
    return { from: `${s.y}-${pad(s.m)}-01`, to: month(y, m).to };
  }
  if (p === 'this_year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  return custom;
}

interface Col {
  label: string;
  get: (r: any) => string;
}
const dShort = (d: string | null | undefined) => (d ? fmtDate(d) : '—');
const daysText = (n: number | null) => (n == null ? '' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`);
const STATE_TEXT: Record<string, string> = { overdue: 'Overdue', due_soon: 'Due soon', confirmed: 'Confirmed' };
const EXIT_STATUS: Record<string, string> = { pending: 'In notice', clearance: 'Clearance', settled: 'Settled' };

const COLUMNS: Record<QuickKind, Col[]> = {
  probation: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Joined', get: (r) => dShort(r.joining_date) },
    { label: 'Probation ends', get: (r) => `${dShort(r.probation_end_date)}${r.days != null ? ` (${daysText(r.days)})` : ''}` },
    { label: 'Status', get: (r) => (r.state === 'confirmed' ? `Confirmed ${dShort(r.confirmation_date)}` : STATE_TEXT[r.state] || r.state) }
  ],
  joiners: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Joined', get: (r) => dShort(r.joining_date) },
    { label: 'Probation ends', get: (r) => dShort(r.probation_end_date) },
    { label: 'Onboarding', get: (r) => (r.onboarding_total ? `${r.onboarding_done} of ${r.onboarding_total} done` : 'Not started') }
  ],
  transfers: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'From → To (department)', get: (r) => (r.from_department || r.to_department ? `${r.from_department || '—'} → ${r.to_department || '—'}` : '—') },
    { label: 'Designation change', get: (r) => (r.to_designation && r.to_designation !== r.from_designation ? `${r.from_designation || '—'} → ${r.to_designation}` : `${r.from_designation || r.to_designation || '—'} (same)`) },
    { label: 'Effective', get: (r) => dShort(r.effective_date) },
    { label: 'Reason', get: (r) => r.reason || '' },
    { label: 'State', get: (r) => (r.scheduled ? `From ${dShort(r.effective_date)}` : 'Done') }
  ],
  resignations: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Type', get: (r) => (r.type === 'termination' ? 'Termination' : 'Resign') },
    { label: 'Submitted', get: (r) => dShort(r.submitted) },
    { label: 'Last working day', get: (r) => (r.last_working_day ? `${dShort(r.last_working_day)}${r.in_notice ? ` (${daysText(r.days_left)})` : r.days_left != null && r.days_left < 0 ? ' (left)' : ''}` : '—') },
    { label: 'Clearance', get: (r) => (r.clearance_total ? `${r.clearance_done} of ${r.clearance_total}` : '—') },
    { label: 'Status', get: (r) => EXIT_STATUS[r.status] || r.status }
  ],
  religion: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Religion', get: (r) => r.religion || 'Not recorded' }
  ],
  attendance: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Present / working days', get: (r) => `${r.present} / ${r.working}` },
    { label: 'Absent', get: (r) => String(r.absent) },
    { label: 'Leave', get: (r) => String(r.leave) },
    { label: 'Late', get: (r) => `${r.late}${r.extreme_late ? ` (${r.extreme_late} extreme)` : ''}` },
    { label: 'Attendance', get: (r) => (r.percent == null ? '—' : `${r.percent}%`) }
  ],
  leave: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Casual (taken / left)', get: (r) => `${r.casual_taken} / ${r.casual_balance ?? '—'}` },
    { label: 'Sick (taken / left)', get: (r) => `${r.sick_taken} / ${r.sick_balance ?? '—'}` },
    { label: 'Without pay', get: (r) => (r.lwp ? `${r.lwp} day${r.lwp === 1 ? '' : 's'}` : '—') },
    { label: 'Last leave', get: (r) => dShort(r.last_leave) }
  ],
  contracts: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Category', get: (r) => r.employment_category || '' },
    { label: 'Joined', get: (r) => dShort(r.joining_date) },
    { label: 'Contract ends', get: (r) => `${dShort(r.contract_end_date)} (${daysText(r.days)})` }
  ],
  headcount: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Gender', get: (r) => r.gender || 'Not recorded' },
    { label: 'Branch', get: (r) => r.branch || '—' },
    { label: 'Project', get: (r) => r.project || '—' },
    { label: 'Category', get: (r) => r.category || '—' }
  ],
  records: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Expired documents', get: (r) => (r.expired.length ? r.expired.join(', ') : '—') },
    { label: 'Awaiting signature', get: (r) => (r.unsigned ? String(r.unsigned) : '—') },
    { label: 'App login', get: (r) => (r.no_login ? 'None' : 'Yes') }
  ],
  overtime: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Total OT', get: (r) => otHours(r.total) },
    { label: 'Approved', get: (r) => otHours(r.approved) },
    { label: 'Waiting approval', get: (r) => (r.waiting ? otHours(r.waiting) : '—') },
    { label: 'Off-day / holiday', get: (r) => (r.off ? otHours(r.off) : '—') },
    { label: 'Days with OT', get: (r) => String(r.day_count) },
    { label: 'Days', get: (r) => r.days.map((d: any) => `${otDay(d.date)} ${otHours(d.minutes)}`).join(', ') }
  ]
};
// "2026-11-03" -> "03 Nov".
const OT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const otDay = (d: string) => `${d.slice(8, 10)} ${OT_MON[Number(d.slice(5, 7)) - 1] || ''}`;
const otMonth = (m: string) => `${OT_MON[Number(m.slice(5, 7)) - 1] || ''} ${m.slice(0, 4)}`;
// One person's OT totals from the days kept (same sums as the server's otTotals).
const otTotals = (r: any) => {
  const add = (f: (d: any) => number) => r.days.reduce((a: number, d: any) => a + f(d), 0);
  return { ...r, total: add((d) => d.minutes), approved: add((d) => d.approved), waiting: add((d) => d.waiting), off: add((d) => (d.off ? d.minutes : 0)), day_count: r.days.length };
};
// The later reports' views: chips above the table, and which rows each keeps.
const HEADCOUNT_DIMS: { key: string; label: string; field: string; none: string }[] = [
  { key: 'gender', label: 'Gender', field: 'gender', none: 'Not recorded' },
  { key: 'branch', label: 'Branch', field: 'branch', none: 'No branch' },
  { key: 'project', label: 'Project', field: 'project', none: 'No project' },
  { key: 'category', label: 'Employment category', field: 'category', none: 'Not recorded' }
];
const VIEW_FILTER: Partial<Record<QuickKind, Record<string, (r: any) => boolean>>> = {
  attendance: { low: (r) => r.low, late: (r) => r.often_late },
  leave: { low: (r) => r.low, lwp: (r) => r.took_lwp },
  contracts: { due: (r) => r.state === 'due', ended: (r) => r.state === 'ended' },
  records: { expired: (r) => r.expired.length > 0, unsigned: (r) => r.unsigned > 0, no_login: (r) => r.no_login }
};

const pill = (on: boolean) =>
  `text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`;
const toneBadge: Record<string, string> = {
  overdue: 'bg-rose-100 text-rose-800',
  due_soon: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-sky-100 text-sky-800',
  clearance: 'bg-amber-100 text-amber-800',
  settled: 'bg-emerald-100 text-emerald-800',
  done: 'bg-emerald-100 text-emerald-800',
  scheduled: 'bg-sky-100 text-sky-800'
};
const Chip: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${toneBadge[tone] || 'bg-slate-100 text-slate-700'}`}>{children}</span>
);

export const HrQuickReports: React.FC<{ token: string; onOpenEmployee: (id: number) => void; canOt?: boolean }> = ({ token, onOpenEmployee, canOt = false }) => {
  const api = useHrApi(token);
  // The Overtime report needs its own layer (quick_ot) on top of Quick reports.
  const KINDS = ALL_KINDS.filter((k) => k.key !== 'overtime' || canOt);
  const [kind, setKind] = useState<QuickKind>(() => {
    try {
      const k = sessionStorage.getItem(QUICK_KIND_STORAGE_KEY) as QuickKind | null;
      if (k && KINDS.some((x) => x.key === k)) return k;
    } catch {
      // storage unavailable
    }
    return 'probation';
  });
  const [summary, setSummary] = useState<QuickSummary | null>(null);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<PeriodKey>('this_month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [department, setDepartment] = useState('');
  const [exitType, setExitType] = useState('');
  // A filter inside the result: probation state, religion, joiners' department.
  const [view, setView] = useState('');

  useEffect(() => {
    try {
      sessionStorage.setItem(QUICK_KIND_STORAGE_KEY, kind);
    } catch {
      // ignore
    }
  }, [kind]);
  useEffect(() => {
    api.get<QuickSummary>('/api/hr-ops/quick/summary').then(setSummary).catch((e) => setError(e.message));
  }, [api]);

  const today = data?.today || new Date().toISOString().slice(0, 10);
  const range = periodRange(period, today, custom);
  // Religion, contracts, headcount and records are about today, not a period.
  const usesPeriod = !['religion', 'contracts', 'headcount', 'records'].includes(kind);
  useEffect(() => {
    if (period === 'custom' && (!custom.from || !custom.to)) return;
    let live = true;
    setLoading(true);
    setError('');
    const qs = new URLSearchParams();
    if (usesPeriod) {
      qs.set('from', range.from);
      qs.set('to', range.to);
    }
    if (department) qs.set('department', department);
    if (kind === 'resignations' && exitType) qs.set('type', exitType);
    api
      .get(`/api/hr-ops/quick/${kind}?${qs.toString()}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kind, range.from, range.to, department, exitType]);
  useEffect(() => setView(kind === 'probation' ? 'open' : kind === 'headcount' ? 'gender:' : ''), [kind]);

  const rows: any[] = useMemo(() => {
    if (!data || data.kind !== kind) return [];
    const all: any[] = data.rows || [];
    if (kind === 'probation') return view === 'open' ? all.filter((r) => r.state !== 'confirmed') : view ? all.filter((r) => r.state === view) : all;
    if (kind === 'religion') return view ? all.filter((r) => (r.religion || 'Not recorded') === view) : all;
    if (kind === 'joiners') return view ? all.filter((r) => (r.department || 'No department') === view) : all;
    if (kind === 'headcount') {
      // view = "<dimension>:<value>" — empty value lists everyone.
      const [dimKey, value] = [view.split(':')[0], view.slice(view.indexOf(':') + 1)];
      const dim = HEADCOUNT_DIMS.find((d) => d.key === dimKey);
      return dim && value ? all.filter((r) => (r[dim.field] || dim.none) === value) : all;
    }
    if (kind === 'overtime') {
      // view: "" everyone · "waiting" · "off" · "m:YYYY-MM" one month (its own hours).
      if (view.startsWith('m:')) {
        const ym = view.slice(2);
        return all.map((r) => otTotals({ ...r, days: r.days.filter((d: any) => d.date.startsWith(ym)) })).filter((r) => r.total > 0);
      }
      return view === 'waiting' ? all.filter((r) => r.waiting > 0) : view === 'off' ? all.filter((r) => r.off > 0) : all;
    }
    const f = VIEW_FILTER[kind]?.[view];
    return f ? all.filter(f) : all;
  }, [data, kind, view]);

  const title = KINDS.find((k) => k.key === kind)!.title;
  const periodText = kind === 'attendance' && data?.month ? `Month ${data.month}` : kind === 'leave' && data?.year ? `Year ${data.year}` : usesPeriod ? `${fmtDate(range.from)} – ${fmtDate(range.to)}` : 'Active employees';
  const viewText = kind === 'overtime' ? (view.startsWith('m:') ? otMonth(view.slice(2)) : view === 'waiting' ? 'Waiting approval' : view === 'off' ? 'Off-day / holiday OT' : '') : view && view !== 'open' ? STATE_TEXT[view] || view : '';
  const filterText = [department || 'All departments', kind === 'resignations' && exitType ? exitType : '', viewText].filter(Boolean).join(' · ');

  const exportExcel = () => {
    const cols = COLUMNS[kind];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.get(r)))]), title.slice(0, 30).replace(/[\\/?*[\]:]/g, ''));
    if (kind === 'religion' && data?.groups) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Religion', 'Employees', '%'], ...data.groups.map((g: any) => [g.label, g.count, g.percent])]), 'Summary');
    }
    if (kind === 'headcount' && data?.dimensions) {
      const aoa: any[][] = [];
      for (const d of HEADCOUNT_DIMS) {
        aoa.push([d.label, 'Employees', '%'], ...(data.dimensions[d.key] || []).map((g: any) => [g.label, g.count, g.percent]), []);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Summary');
    }
    if (kind === 'resignations' && data?.reasons) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Why people leave (this year)', 'Count'],
          ...data.reasons.map((g: any) => [g.label, g.count]),
          [],
          ['By department (this year)', 'Count'],
          ...data.by_department.map((g: any) => [g.label, g.count]),
          [],
          ['Turnover this year', `${data.turnover.left_this_year} of ${data.turnover.base} (${data.turnover.percent}%)`]
        ]),
        'Summary'
      );
    }
    if (kind === 'overtime') {
      // Which day: one row per person per day.
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Employee', 'Employee ID', 'Department', 'Designation', 'Date', 'Day', 'In', 'Out', 'OT hours', 'Approved', 'Waiting approval', 'Status'],
          ...rows.flatMap((r) =>
            r.days.map((d: any) => [r.name, r.employee_code || '', r.department || '', r.designation || '', d.date, d.off ? 'Off-day / holiday' : 'Working day', d.in || '', d.out || '', d.minutes / 60, d.approved / 60, d.waiting / 60, d.status])
          )
        ]),
        'By day'
      );
      // Which month: one row per person, a column per month.
      const ms = [...new Set(rows.flatMap((r) => r.days.map((d: any) => d.date.slice(0, 7))))].sort();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Employee', 'Employee ID', 'Department', ...ms.map(otMonth), 'Total hours'],
          ...rows.map((r) => [r.name, r.employee_code || '', r.department || '', ...ms.map((m) => r.days.filter((d: any) => d.date.startsWith(m)).reduce((a: number, d: any) => a + d.minutes, 0) / 60), r.total / 60])
        ]),
        'By month'
      );
    }
    void saveWorkbookCrossPlatform(wb, `${title.replace(/[^\w]+/g, '_')}.xlsx`);
  };
  const exportPdf = async () => {
    const cols = COLUMNS[kind];
    const logo = await loadImageElement(credenceLogo).catch(() => null);
    const doc = new jsPDF({ orientation: cols.length > 6 ? 'landscape' : 'portrait' });
    let y = drawPdfLetterhead(doc, logo as any, {
      reportTitle: pdfSafe(title),
      filters: [
        ['Period', pdfSafe(periodText)],
        ['Filters', pdfSafe(filterText)],
        ['Employees', String(rows.length)]
      ]
    });
    if (kind === 'religion' && data?.groups) {
      autoTable(doc, { theme: 'grid', startY: y, head: [['Religion', 'Employees', '%']], body: data.groups.map((g: any) => [pdfSafe(g.label), String(g.count), `${g.percent}%`]), styles: { ...STD_STYLES, fontSize: 8 }, headStyles: { ...STD_HEAD }, tableWidth: 110 });
      y = (doc as any).lastAutoTable.finalY + 6;
    }
    autoTable(doc, {
      theme: 'grid',
      startY: y,
      head: [cols.map((c) => pdfSafe(c.label))],
      body: rows.map((r) => cols.map((c) => pdfSafe(c.get(r)))),
      styles: { ...STD_STYLES, fontSize: 7.5, cellPadding: 1.4 },
      headStyles: { ...STD_HEAD }
    });
    finalizePdfPageNumbers(doc);
    await savePdfCrossPlatform(doc, `${title.replace(/[^\w]+/g, '_')}.pdf`);
  };

  const card = (k: QuickKind) => {
    const t = summary ? quickCardText(k, summary) : null;
    const on = kind === k;
    return (
      <button
        key={k}
        type="button"
        data-quick-card={k}
        onClick={() => setKind(k)}
        className={`text-left rounded-2xl p-4 bg-white flex flex-col gap-1 transition-shadow hover:shadow-md ${on ? 'border-2 border-blue-600' : 'border border-slate-200'}`}
      >
        <span className={`text-[11px] font-bold uppercase tracking-wide ${on ? 'text-blue-700' : 'text-slate-500'}`}>{t?.label || KINDS.find((x) => x.key === k)!.title}</span>
        <b className="text-2xl text-slate-900">{t ? t.big : '…'}</b>
        <span className="text-xs text-slate-500 leading-snug">{t?.small || ' '}</span>
      </button>
    );
  };

  const clickable = (r: any) => (r.employee_id ?? (kind === 'transfers' || kind === 'resignations' ? null : r.id)) as number | null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">{KINDS.map((k) => card(k.key))}</div>
      {error && <Notice msg={{ type: 'error', text: error }} />}

      <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-800 flex-1 min-w-[10rem]">{title}</h2>
          {usesPeriod && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              Period
              <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-800" aria-label="Period">
                <option value="this_month">This month</option>
                <option value="last_month">Last month</option>
                <option value="last_3">Last 3 months</option>
                <option value="this_year">This year</option>
                <option value="custom">Custom…</option>
              </select>
            </label>
          )}
          {usesPeriod && period === 'custom' && (
            <span className="flex items-center gap-1 text-xs">
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="px-2 py-1.5 rounded-lg border border-slate-200" aria-label="From" />
              –
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="px-2 py-1.5 rounded-lg border border-slate-200" aria-label="To" />
            </span>
          )}
          {kind === 'resignations' && (
            <select value={exitType} onChange={(e) => setExitType(e.target.value)} className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-800" aria-label="Type">
              <option value="">All types</option>
              <option value="resignation">Resignation</option>
              <option value="termination">Termination</option>
            </select>
          )}
          <div className="w-48">
            <SearchSelect value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department" className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white">
              <option value="">All departments</option>
              {(data?.departments || []).map((d: string) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </SearchSelect>
          </div>
          <button type="button" className={btnGhost} onClick={exportExcel} disabled={!rows.length}>
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
          <button type="button" className={btnGhost} onClick={() => void exportPdf()} disabled={!rows.length}>
            <FileDown className="w-3.5 h-3.5" /> PDF
          </button>
        </div>

        {data && data.kind === kind && <ReportTop kind={kind} data={data} view={view} setView={setView} />}

        {loading && !data ? (
          <LoadingBlock />
        ) : !rows.length ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">{loading ? 'Loading…' : 'Nobody here for this period and department.'}</p>
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
                  {COLUMNS[kind]
                    .filter((c) => c.label !== 'Employee ID')
                    .map((c) => (
                      <th key={c.label} className="px-4 py-2 font-bold whitespace-nowrap">
                        {c.label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const id = clickable(r);
                  return (
                    <tr
                      key={`${r.id}-${i}`}
                      onClick={id ? () => onOpenEmployee(id) : undefined}
                      title={id ? 'Open Service Book' : undefined}
                      className={`border-t border-slate-100 ${id ? 'cursor-pointer hover:bg-blue-50/40' : ''}`}
                    >
                      <Cells kind={kind} r={r} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-slate-500">
        Tap a row to open that person's Service Book.{kind === 'resignations' ? ' No amounts here — settlement money stays in Exit / Offboarding and Payroll.' : ''}
      </p>
    </div>
  );
};

// The first three columns of every quick report: Employee (name, ID under
// it), Department, Designation.
const who = (r: any) => (
  <>
    <td className="px-4 py-2.5">
      <b className="text-slate-800">{r.name}</b>
      {r.employee_code && <div className="text-[11px] text-slate-500">{r.employee_code}</div>}
    </td>
    <td className="px-4 py-2.5">{r.department || '—'}</td>
    <td className="px-4 py-2.5">{r.designation || '—'}</td>
  </>
);
const td = (v: React.ReactNode, cls = '') => <td className={`px-4 py-2.5 ${cls}`}>{v}</td>;

const Cells: React.FC<{ kind: QuickKind; r: any }> = ({ kind, r }) => {
  if (kind === 'probation')
    return (
      <>
        {who(r)}
        {td(dShort(r.joining_date), 'whitespace-nowrap')}
        {td(
          <>
            {dShort(r.probation_end_date)}
            {r.days != null && <span className="block text-[11px]">{daysText(r.days)}</span>}
          </>,
          `whitespace-nowrap font-semibold ${r.state === 'overdue' ? 'text-rose-700' : ''}`
        )}
        {td(<Chip tone={r.state}>{r.state === 'confirmed' ? `Confirmed ${dShort(r.confirmation_date)}` : STATE_TEXT[r.state]}</Chip>)}
      </>
    );
  if (kind === 'joiners')
    return (
      <>
        {who(r)}
        {td(dShort(r.joining_date), 'whitespace-nowrap')}
        {td(dShort(r.probation_end_date), 'whitespace-nowrap')}
        {td(
          r.onboarding_total ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <span className="block h-full bg-emerald-500" style={{ width: `${Math.round((r.onboarding_done / r.onboarding_total) * 100)}%` }} />
              </span>
              {r.onboarding_done} of {r.onboarding_total}
            </span>
          ) : (
            <span className="text-slate-400">Not started</span>
          ),
          'whitespace-nowrap text-xs'
        )}
      </>
    );
  if (kind === 'transfers')
    return (
      <>
        {who(r)}
        {td(
          <>
            {r.from_department || '—'} → <b>{r.to_department || '—'}</b>
          </>
        )}
        {td(
          r.to_designation && r.to_designation !== r.from_designation ? (
            <>
              {r.from_designation || '—'} → <b>{r.to_designation}</b>
            </>
          ) : (
            <span className="text-slate-400">Same</span>
          )
        )}
        {td(r.effective_date ? dShort(r.effective_date) : '—', 'whitespace-nowrap')}
        {td(r.reason || '—', 'text-slate-600')}
        {td(<Chip tone={r.scheduled ? 'scheduled' : 'done'}>{r.scheduled ? `From ${dShort(r.effective_date)}` : 'Done'}</Chip>)}
      </>
    );
  if (kind === 'resignations')
    return (
      <>
        {who(r)}
        {td(r.type === 'termination' ? 'Termination' : 'Resign')}
        {td(dShort(r.submitted), 'whitespace-nowrap')}
        {td(
          r.last_working_day ? (
            <>
              {dShort(r.last_working_day)}
              <span className="block text-[11px]">{r.in_notice ? daysText(r.days_left) : 'left'}</span>
            </>
          ) : (
            '—'
          ),
          `whitespace-nowrap ${r.in_notice && r.days_left != null && r.days_left <= 10 ? 'font-bold text-rose-700' : r.in_notice ? 'font-semibold' : 'text-slate-500'}`
        )}
        {td(
          r.clearance_total ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-14 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <span className="block h-full bg-emerald-500" style={{ width: `${Math.round((r.clearance_done / r.clearance_total) * 100)}%` }} />
              </span>
              {r.clearance_done} of {r.clearance_total}
            </span>
          ) : (
            '—'
          ),
          'whitespace-nowrap text-xs'
        )}
        {td(<Chip tone={r.status}>{EXIT_STATUS[r.status] || r.status}</Chip>)}
      </>
    );
  if (kind !== 'religion')
    // The later reports: the shown columns, as plain text.
    return (
      <>
        {who(r)}
        {COLUMNS[kind]
          .filter((c) => !['Employee', 'Employee ID', 'Department', 'Designation'].includes(c.label))
          .map((c) => (
            <React.Fragment key={c.label}>
              {td(c.get(r), `${kind === 'overtime' && c.label === 'Days' ? 'min-w-[16rem] text-xs text-slate-600' : 'whitespace-nowrap'} ${kind === 'overtime' && c.label === 'Total OT' ? 'font-bold text-slate-900' : ''} ${kind === 'overtime' && c.label === 'Waiting approval' && r.waiting ? 'text-amber-700 font-semibold' : ''} ${(kind === 'attendance' && c.label === 'Attendance' && r.low) || (kind === 'contracts' && r.state === 'ended' && c.label === 'Contract ends') ? 'font-bold text-rose-700' : ''}`)}
            </React.Fragment>
          ))}
      </>
    );
  return (
    <>
      {who(r)}
      {td(r.religion || <span className="text-rose-700 font-semibold">Not recorded</span>)}
    </>
  );
};

// What sits between the toolbar and the table: state chips, totals, bars.
const ReportTop: React.FC<{ kind: QuickKind; data: any; view: string; setView: (v: string) => void }> = ({ kind, data, view, setView }) => {
  let s = data.summary || {};
  if (kind === 'probation')
    return (
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <button type="button" className={pill(view === 'open')} onClick={() => setView('open')}>
          Not confirmed ({s.due_30 + s.overdue})
        </button>
        <button type="button" className={pill(view === 'due_soon')} onClick={() => setView('due_soon')}>
          Ends in 30 days ({s.due_30})
        </button>
        <button type="button" className={pill(view === 'overdue')} onClick={() => setView('overdue')}>
          Overdue — not confirmed ({s.overdue})
        </button>
        <button type="button" className={pill(view === 'confirmed')} onClick={() => setView('confirmed')}>
          Confirmed in period ({s.confirmed})
        </button>
      </div>
    );
  if (kind === 'joiners')
    return (
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <button type="button" className={pill(!view)} onClick={() => setView('')}>
          {s.joined} joined
        </button>
        {(s.by_department || []).map((g: any) => (
          <button key={g.label} type="button" className={pill(view === g.label)} onClick={() => setView(view === g.label ? '' : g.label)}>
            {g.label} {g.count}
          </button>
        ))}
      </div>
    );
  if (kind === 'transfers')
    return (
      <div className="flex flex-wrap gap-2 px-4 py-3 text-xs text-slate-600">
        <span className="font-semibold">{s.transfers} transfer{s.transfers === 1 ? '' : 's'}</span>
        {s.scheduled > 0 && <span>· {s.scheduled} take{s.scheduled === 1 ? 's' : ''} effect later</span>}
      </div>
    );
  if (kind === 'religion') {
    const max = Math.max(1, ...(data.groups || []).map((g: any) => g.count));
    return (
      <div className="px-4 py-3 space-y-1.5 max-w-xl">
        {(data.groups || []).map((g: any) => {
          const none = g.label === 'Not recorded';
          return (
            <button
              key={g.label}
              type="button"
              onClick={() => setView(view === g.label ? '' : g.label)}
              className={`w-full grid grid-cols-[8rem_1fr_3rem_3rem] items-center gap-2 text-sm text-left rounded-lg px-1.5 py-1 ${view === g.label ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
            >
              <span className={none ? 'text-rose-700 font-semibold' : 'text-slate-700'}>{g.label}</span>
              <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                <span className={`block h-full rounded-full ${none ? 'bg-rose-300' : 'bg-violet-500'}`} style={{ width: `${Math.max(2, (g.count / max) * 100)}%` }} />
              </span>
              <b className={none ? 'text-rose-700' : 'text-slate-800'}>{g.count}</b>
              <span className="text-xs text-slate-500">{g.percent}%</span>
            </button>
          );
        })}
        <p className="text-xs text-slate-500 pt-1">Tap a religion to list its people. "Not recorded" shows who still needs it filled in.</p>
      </div>
    );
  }
  const chips = (items: [string, string][]) => (
    <div className="flex flex-wrap gap-2 px-4 py-3">
      <button type="button" className={pill(!view)} onClick={() => setView('')}>
        Everyone listed ({(data.rows || []).length})
      </button>
      {items.map(([k, label]) => (
        <button key={k} type="button" className={pill(view === k)} onClick={() => setView(view === k ? '' : k)}>
          {label}
        </button>
      ))}
    </div>
  );
  if (kind === 'attendance') return chips([['low', `Under 80% (${s.low})`], ['late', `Late more than 3 times (${s.often_late})`]]);
  if (kind === 'leave') return chips([['low', `Casual / Sick left 2 days or less (${s.low})`], ['lwp', `Took leave without pay (${s.lwp})`]]);
  if (kind === 'contracts') return chips([['due', `Ends in 60 days (${s.due_60})`], ['ended', `Already ended (${s.ended})`]]);
  if (kind === 'overtime') {
    const ms: { month: string; minutes: number }[] = data.months || [];
    // One month picked: the four boxes count that month only, like the table.
    if (view.startsWith('m:')) {
      const ym = view.slice(2);
      const rs = (data.rows || []).map((r: any) => otTotals({ ...r, days: r.days.filter((d: any) => d.date.startsWith(ym)) })).filter((r: any) => r.total > 0);
      const sum = (k: string) => rs.reduce((a: number, r: any) => a + r[k], 0);
      s = { people: rs.length, total_minutes: sum('total'), approved_minutes: sum('approved'), waiting_minutes: sum('waiting'), off_minutes: sum('off'), waiting_people: rs.filter((r: any) => r.waiting > 0).length };
    }
    const max = Math.max(1, ...ms.map((m) => m.minutes));
    const box = (label: string, big: string, small: string, strong = false) => (
      <div className={`rounded-2xl bg-white px-4 py-3 ${strong ? 'border-2 border-blue-600' : 'border border-slate-200'}`}>
        <span className={`text-[11px] font-bold uppercase tracking-wide ${strong ? 'text-blue-700' : 'text-slate-500'}`}>{label}</span>
        <div className="flex items-baseline gap-2">
          <b className="text-2xl text-slate-900">{big}</b>
          <span className="text-xs text-slate-500">{small}</span>
        </div>
      </div>
    );
    return (
      <div className="px-4 py-3 space-y-3">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {box('Total OT', otHours(s.total_minutes), `${s.people} ${s.people === 1 ? 'person' : 'people'}`, true)}
          {box('Approved', otHours(s.approved_minutes), 'counts for Payroll')}
          {box('Waiting approval', otHours(s.waiting_minutes), `${s.waiting_people} ${s.waiting_people === 1 ? 'person' : 'people'}`)}
          {box('Off-day / holiday', otHours(s.off_minutes), 'worked on a day off')}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={pill(!view)} onClick={() => setView('')}>
            Everyone ({(data.rows || []).length})
          </button>
          <button type="button" className={pill(view === 'waiting')} onClick={() => setView(view === 'waiting' ? '' : 'waiting')}>
            Waiting approval ({s.waiting_people})
          </button>
          <button type="button" className={pill(view === 'off')} onClick={() => setView(view === 'off' ? '' : 'off')}>
            Off-day / holiday OT
          </button>
        </div>
        {ms.length > 1 && (
          <div className="space-y-1.5 max-w-xl">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">By month — tap one to see only that month</p>
            {ms.map((m) => (
              <button
                key={m.month}
                type="button"
                onClick={() => setView(view === `m:${m.month}` ? '' : `m:${m.month}`)}
                className={`w-full grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2 text-sm text-left rounded-lg px-1.5 py-1 ${view === `m:${m.month}` ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
              >
                <span className="text-slate-700">{otMonth(m.month)}</span>
                <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, (m.minutes / max) * 100)}%` }} />
                </span>
                <b className="text-slate-800 text-right">{otHours(m.minutes)}</b>
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500">From Duty Roster OT (worked out from attendance). Only people set to get OT; rejected days left out. Excel has "By day" and "By month" sheets too.</p>
      </div>
    );
  }
  if (kind === 'records') return chips([['expired', `Expired documents (${s.expired})`], ['unsigned', `Awaiting signature (${s.unsigned})`], ['no_login', `No app login (${s.no_login})`]]);
  if (kind === 'headcount') {
    const dimKey = view.split(':')[0] || 'gender';
    const value = view.slice(view.indexOf(':') + 1);
    const groups: any[] = data.dimensions?.[dimKey] || [];
    const max = Math.max(1, ...groups.map((g) => g.count));
    return (
      <div className="px-4 py-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          {HEADCOUNT_DIMS.map((d) => (
            <button key={d.key} type="button" className={pill(dimKey === d.key)} onClick={() => setView(`${d.key}:`)}>
              {d.label}
            </button>
          ))}
          <span className="text-xs text-slate-500 self-center">
            {s.total} active · {s.male} male · {s.female} female
          </span>
        </div>
        <div className="space-y-1.5 max-w-xl">
          {groups.map((g) => {
            const none = /^(not recorded|no )/i.test(g.label);
            return (
              <button
                key={g.label}
                type="button"
                onClick={() => setView(value === g.label ? `${dimKey}:` : `${dimKey}:${g.label}`)}
                className={`w-full grid grid-cols-[9rem_1fr_3rem_3rem] items-center gap-2 text-sm text-left rounded-lg px-1.5 py-1 ${value === g.label ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
              >
                <span className={`truncate ${none ? 'text-rose-700 font-semibold' : 'text-slate-700'}`}>{g.label}</span>
                <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <span className={`block h-full rounded-full ${none ? 'bg-rose-300' : 'bg-blue-500'}`} style={{ width: `${Math.max(2, (g.count / max) * 100)}%` }} />
                </span>
                <b className={none ? 'text-rose-700' : 'text-slate-800'}>{g.count}</b>
                <span className="text-xs text-slate-500">{g.percent}%</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-500">Tap a bar to list its people.</p>
      </div>
    );
  }
  // resignations
  const box = (label: string, big: number, small: string, strong = false) => (
    <div className={`rounded-2xl bg-white px-4 py-3 ${strong ? 'border-2 border-blue-600' : 'border border-slate-200'}`}>
      <span className={`text-[11px] font-bold uppercase tracking-wide ${strong ? 'text-blue-700' : 'text-slate-500'}`}>{label}</span>
      <div className="flex items-baseline gap-2">
        <b className="text-2xl text-slate-900">{big}</b>
        <span className="text-xs text-slate-500">{small}</span>
      </div>
    </div>
  );
  return (
    <div className="px-4 py-3 grid gap-3 items-start lg:grid-cols-[1fr_18rem]">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {box('Submitted in period', s.submitted, `${s.resignations} resign · ${s.terminations} termination`)}
        {box('In notice now', s.in_notice, 'still working', true)}
        {box('Leaving in 30 days', s.leaving_30, 'plan the handover')}
        {box('Settled', s.settled, 'clearance done')}
      </div>
      <div className="rounded-2xl border border-slate-200 px-4 py-3 text-sm space-y-2">
        <b className="text-slate-800 text-xs uppercase tracking-wide">Why people leave (this year)</b>
        {(data.reasons || []).length ? (
          (data.reasons || []).map((g: any) => (
            <div key={g.label} className="flex justify-between text-xs">
              <span className="text-slate-600">{g.label}</span>
              <b>{g.count}</b>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-400">No exits this year.</p>
        )}
        {(data.by_department || []).length > 0 && (
          <p className="text-xs text-slate-600 border-t border-slate-100 pt-2">
            <b className="text-slate-800">By department:</b> {data.by_department.map((g: any) => `${g.label} ${g.count}`).join(' · ')}
          </p>
        )}
        <p className="text-[11px] text-slate-500">
          Turnover this year: {data.turnover.left_this_year} of {data.turnover.base} ({data.turnover.percent}%)
        </p>
      </div>
    </div>
  );
};
