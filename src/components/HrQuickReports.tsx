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

import { type QuickKind, type QuickSummary, QUICK_KIND_STORAGE_KEY, QUICK_KINDS as KINDS, quickCardText } from './hrQuickShared';

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
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Joined', get: (r) => dShort(r.joining_date) },
    { label: 'Probation ends', get: (r) => `${dShort(r.probation_end_date)}${r.days != null ? ` (${daysText(r.days)})` : ''}` },
    { label: 'Status', get: (r) => (r.state === 'confirmed' ? `Confirmed ${dShort(r.confirmation_date)}` : STATE_TEXT[r.state] || r.state) }
  ],
  joiners: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Joined', get: (r) => dShort(r.joining_date) },
    { label: 'Probation ends', get: (r) => dShort(r.probation_end_date) },
    { label: 'Onboarding', get: (r) => (r.onboarding_total ? `${r.onboarding_done} of ${r.onboarding_total} done` : 'Not started') }
  ],
  transfers: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'From → To (department)', get: (r) => (r.from_department || r.to_department ? `${r.from_department || '—'} → ${r.to_department || '—'}` : '—') },
    { label: 'Designation', get: (r) => (r.to_designation && r.to_designation !== r.from_designation ? `${r.from_designation || '—'} → ${r.to_designation}` : `${r.from_designation || r.to_designation || '—'} (same)`) },
    { label: 'Effective', get: (r) => dShort(r.effective_date) },
    { label: 'Reason', get: (r) => r.reason || '' },
    { label: 'State', get: (r) => (r.scheduled ? `From ${dShort(r.effective_date)}` : 'Done') }
  ],
  resignations: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Type', get: (r) => (r.type === 'termination' ? 'Termination' : 'Resign') },
    { label: 'Submitted', get: (r) => dShort(r.submitted) },
    { label: 'Last working day', get: (r) => (r.last_working_day ? `${dShort(r.last_working_day)}${r.in_notice ? ` (${daysText(r.days_left)})` : r.days_left != null && r.days_left < 0 ? ' (left)' : ''}` : '—') },
    { label: 'Clearance', get: (r) => (r.clearance_total ? `${r.clearance_done} of ${r.clearance_total}` : '—') },
    { label: 'Status', get: (r) => EXIT_STATUS[r.status] || r.status }
  ],
  religion: [
    { label: 'Employee', get: (r) => r.name },
    { label: 'Employee ID', get: (r) => r.employee_code || '' },
    { label: 'Designation', get: (r) => r.designation || '' },
    { label: 'Department', get: (r) => r.department || '' },
    { label: 'Religion', get: (r) => r.religion || 'Not recorded' }
  ]
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

export const HrQuickReports: React.FC<{ token: string; onOpenEmployee: (id: number) => void }> = ({ token, onOpenEmployee }) => {
  const api = useHrApi(token);
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
  const usesPeriod = kind !== 'religion';
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
  useEffect(() => setView(kind === 'probation' ? 'open' : ''), [kind]);

  const rows: any[] = useMemo(() => {
    if (!data || data.kind !== kind) return [];
    const all: any[] = data.rows || [];
    if (kind === 'probation') return view === 'open' ? all.filter((r) => r.state !== 'confirmed') : view ? all.filter((r) => r.state === view) : all;
    if (kind === 'religion') return view ? all.filter((r) => (r.religion || 'Not recorded') === view) : all;
    if (kind === 'joiners') return view ? all.filter((r) => (r.department || 'No department') === view) : all;
    return all;
  }, [data, kind, view]);

  const title = KINDS.find((k) => k.key === kind)!.title;
  const periodText = usesPeriod ? `${fmtDate(range.from)} – ${fmtDate(range.to)}` : 'Active employees';
  const filterText = [department || 'All departments', kind === 'resignations' && exitType ? exitType : '', view && view !== 'open' ? (STATE_TEXT[view] || view) : ''].filter(Boolean).join(' · ');

  const exportExcel = () => {
    const cols = COLUMNS[kind];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.get(r)))]), title.slice(0, 30).replace(/[\\/?*[\]:]/g, ''));
    if (kind === 'religion' && data?.groups) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Religion', 'Employees', '%'], ...data.groups.map((g: any) => [g.label, g.count, g.percent])]), 'Summary');
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
                    .filter((c) => c.label !== 'Employee ID' && c.label !== 'Designation')
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

const who = (r: any) => (
  <td className="px-4 py-2.5">
    <b className="text-slate-800">{r.name}</b>
    <div className="text-[11px] text-slate-500">{[r.employee_code, r.designation].filter(Boolean).join(' · ')}</div>
  </td>
);
const td = (v: React.ReactNode, cls = '') => <td className={`px-4 py-2.5 ${cls}`}>{v}</td>;

const Cells: React.FC<{ kind: QuickKind; r: any }> = ({ kind, r }) => {
  if (kind === 'probation')
    return (
      <>
        {who(r)}
        {td(r.department || '—')}
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
        {td(r.department || '—')}
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
            {r.to_designation && r.to_designation !== r.from_designation && (
              <span className="block text-[11px] text-slate-500">
                {r.from_designation || '—'} → {r.to_designation}
              </span>
            )}
          </>
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
        {td(r.department || '—')}
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
  return (
    <>
      {who(r)}
      {td(r.department || '—')}
      {td(r.religion || <span className="text-rose-700 font-semibold">Not recorded</span>)}
    </>
  );
};

// What sits between the toolbar and the table: state chips, totals, bars.
const ReportTop: React.FC<{ kind: QuickKind; data: any; view: string; setView: (v: string) => void }> = ({ kind, data, view, setView }) => {
  const s = data.summary || {};
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
