/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  ArrowLeft,
  BarChart3,
  CalendarCheck,
  CalendarClock,
  Car,
  FileDown,
  FileSpreadsheet,
  Inbox,
  Package,
  Play,
  Receipt,
  Route,
  Search
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { pdfSafe } from './HrOps360Parts';
import { fmtDate, taka } from './HrOpsShared';
import { Spinner } from './Spinner';

// Admin Panel -> Reports & Insights: every operational report (Attendance,
// Leave, Claim, Bill, Asset, Vehicle) in one place. The list, filters and
// data come from ReportsInsightsRoutes.ts; this page only renders them and
// exports what's on screen to Excel or PDF.

type ColType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'percent';
interface Column {
  key: string;
  label: string;
  type?: ColType;
}
interface ReportMeta {
  key: string;
  category: string;
  title: string;
  description: string;
  filters: ('date' | 'department' | 'employee' | 'status')[];
  dateLabel: string;
  maxDays: number | null;
  statuses: { value: string; label: string }[];
}
interface Catalog {
  categories: string[];
  reports: ReportMeta[];
  departments: string[];
  today: string;
}
interface Result {
  key: string;
  title: string;
  from: string | null;
  to: string | null;
  columns: Column[];
  rows: Record<string, any>[];
  summary: { label: string; value: string | number }[];
  generated_at: string;
}

const CATEGORY_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; tint: string }> = {
  Attendance: { icon: CalendarCheck, tint: 'bg-blue-50 text-blue-600' },
  Leave: { icon: CalendarClock, tint: 'bg-violet-50 text-violet-600' },
  Claim: { icon: Route, tint: 'bg-emerald-50 text-emerald-600' },
  Bill: { icon: Receipt, tint: 'bg-amber-50 text-amber-600' },
  Asset: { icon: Package, tint: 'bg-lime-50 text-lime-700' },
  Vehicle: { icon: Car, tint: 'bg-sky-50 text-sky-600' }
};

const display = (v: any, type?: ColType): string => {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') return fmtDate(String(v));
  if (type === 'datetime') return `${fmtDate(String(v).slice(0, 10))} ${String(v).slice(11, 16)}`.trim();
  if (type === 'money') return taka(Number(v));
  if (type === 'percent') return `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
  if (type === 'number') return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return String(v);
};
// Excel keeps numbers as numbers.
const raw = (v: any, type?: ColType) => {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'number' || type === 'money' || type === 'percent') return Number(v);
  if (type === 'date') return fmtDate(String(v));
  return String(v);
};
const isNumeric = (t?: ColType) => t === 'number' || t === 'money' || t === 'percent';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function presetRange(preset: 'this_month' | 'last_month' | 'last_7' | 'today', today: string): [string, string] {
  const t = new Date(`${today}T00:00:00`);
  if (preset === 'today') return [today, today];
  if (preset === 'last_7') {
    const s = new Date(t);
    s.setDate(s.getDate() - 6);
    return [ymd(s), today];
  }
  if (preset === 'last_month') {
    const s = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const e = new Date(t.getFullYear(), t.getMonth(), 0);
    return [ymd(s), ymd(e)];
  }
  return [`${today.slice(0, 7)}-01`, today];
}

const fileBase = (r: Result) => `${r.title.replace(/[^\w]+/g, '_')}${r.from ? `_${r.from}_to_${r.to}` : ''}`;

function exportExcel(r: Result, filtersText: string) {
  const wb = XLSX.utils.book_new();
  const head: any[][] = [
    [r.title],
    ...(r.from ? [[`Period: ${fmtDate(r.from)} to ${fmtDate(r.to)}`]] : []),
    ...(filtersText ? [[`Filters: ${filtersText}`]] : []),
    []
  ];
  const sheet = XLSX.utils.aoa_to_sheet([
    ...head,
    r.columns.map((c) => c.label),
    ...r.rows.map((row) => r.columns.map((c) => raw(row[c.key], c.type)))
  ]);
  sheet['!cols'] = r.columns.map((c) => ({ wch: Math.min(40, Math.max(c.label.length + 2, isNumeric(c.type) ? 10 : 14)) }));
  XLSX.utils.book_append_sheet(wb, sheet, 'Report');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary', ''], ...r.summary.map((s) => [s.label, s.value])]), 'Summary');
  XLSX.writeFile(wb, `${fileBase(r)}.xlsx`);
}

async function exportPdf(r: Result, filtersText: string) {
  const logo = await loadImageElement(credenceLogo);
  const wide = r.columns.length > 7;
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait' });
  const y = drawPdfLetterhead(doc, logo, {
    reportTitle: pdfSafe(r.title),
    filters: [
      ...(r.from ? ([['Period', `${fmtDate(r.from)} to ${fmtDate(r.to)}`]] as [string, string][]) : []),
      ...(filtersText ? ([['Filters', pdfSafe(filtersText)]] as [string, string][]) : []),
      ...r.summary.map((s) => [pdfSafe(s.label), pdfSafe(typeof s.value === 'number' ? s.value.toLocaleString('en-IN') : s.value)] as [string, string])
    ]
  });
  autoTable(doc, {
    startY: y,
    head: [r.columns.map((c) => pdfSafe(c.label))],
    body: r.rows.map((row) => r.columns.map((c) => pdfSafe(display(row[c.key], c.type)))),
    styles: { fontSize: r.columns.length > 11 ? 6 : wide ? 6.8 : 7.8, cellPadding: 1.4 },
    headStyles: { fillColor: [109, 40, 217] },
    alternateRowStyles: { fillColor: [248, 245, 255] },
    columnStyles: Object.fromEntries(r.columns.map((c, i) => [i, isNumeric(c.type) ? { halign: 'right' as const } : {}]))
  });
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `${fileBase(r)}.pdf`);
}

export const ReportsInsights: React.FC<{ token: string }> = ({ token }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [category, setCategory] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<ReportMeta | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [employee, setEmployee] = useState('');
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [tableFilter, setTableFilter] = useState('');
  const [exporting, setExporting] = useState<'' | 'pdf' | 'xlsx'>('');

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/reports-insights/catalog'), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load reports.');
        if (!cancelled) setCatalog(data);
      })
      .catch((e) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const openReport = (r: ReportMeta) => {
    setActive(r);
    setResult(null);
    setRunError('');
    setStatus('');
    setTableFilter('');
    const [f, t] = presetRange('this_month', catalog?.today || ymd(new Date()));
    setFrom(f);
    setTo(t);
  };

  const run = async () => {
    if (!active) return;
    setRunning(true);
    setRunError('');
    try {
      const res = await fetch(apiUrl('/api/reports-insights/run'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: active.key, from, to, department, employee, status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not run the report.');
      setResult(data);
      setTableFilter('');
    } catch (e: any) {
      setRunError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const filtersText = useMemo(() => {
    if (!active) return '';
    const parts: string[] = [];
    if (department) parts.push(`Department: ${department}`);
    if (employee) parts.push(`Employee: ${employee}`);
    if (status) parts.push(`Status: ${active.statuses.find((s) => s.value === status)?.label || status}`);
    return parts.join(' · ');
  }, [active, department, employee, status]);

  // Quick find inside the result (doesn't change what's exported unless the
  // export is taken while a find is active — then the export matches screen).
  const shownRows = useMemo(() => {
    if (!result) return [];
    const q = tableFilter.trim().toLowerCase();
    if (!q) return result.rows;
    return result.rows.filter((row) => result.columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(q)));
  }, [result, tableFilter]);
  const shownResult: Result | null = result ? { ...result, rows: shownRows } : null;

  const doExport = async (kind: 'pdf' | 'xlsx') => {
    if (!shownResult) return;
    setExporting(kind);
    try {
      const text = [filtersText, tableFilter ? `Find: ${tableFilter}` : ''].filter(Boolean).join(' · ');
      if (kind === 'xlsx') exportExcel(shownResult, text);
      else await exportPdf(shownResult, text);
    } finally {
      setExporting('');
    }
  };

  const visibleReports = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    return catalog.reports.filter(
      (r) => (category === 'All' || r.category === category) && (!q || `${r.title} ${r.description} ${r.category}`.toLowerCase().includes(q))
    );
  }, [catalog, category, search]);

  const inputCls =
    'w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-800 focus:ring-2 focus:ring-blue-600 focus:border-blue-600 focus:outline-none';
  const labelCls = 'block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1';

  if (loadError) {
    return <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">{loadError}</div>;
  }
  if (!catalog) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={22} className="text-slate-400" />
      </div>
    );
  }

  // ---------------- report list ----------------
  if (!active) {
    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-violet-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Reports & Insights</h2>
              <p className="text-xs text-slate-500">Pick a report, set the period and filters, then download it as Excel or PDF.</p>
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reports…" className={`${inputCls} pl-9`} />
          </div>
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {['All', ...catalog.categories].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                category === c ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-violet-300'
              }`}
            >
              {c}
              <span className={`ml-1.5 ${category === c ? 'text-white/80' : 'text-slate-400'}`}>
                {c === 'All' ? catalog.reports.length : catalog.reports.filter((r) => r.category === c).length}
              </span>
            </button>
          ))}
        </div>

        {catalog.reports.length === 0 ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-10 text-center text-sm text-slate-500">
            No reports are available for your account. Reports appear here for the modules you have access to.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {visibleReports.map((r) => {
              const st = CATEGORY_STYLE[r.category] || CATEGORY_STYLE.Attendance;
              const Icon = st.icon;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => openReport(r)}
                  className="text-left bg-white border border-slate-200 rounded-2xl p-4 hover:border-violet-300 hover:shadow-md transition-all flex gap-3"
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${st.tint}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{r.category}</div>
                    <div className="text-sm font-bold text-slate-900">{r.title}</div>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{r.description}</p>
                  </div>
                </button>
              );
            })}
            {visibleReports.length === 0 && <p className="text-sm text-slate-500 px-1">No report matches your search.</p>}
          </div>
        )}
      </div>
    );
  }

  // ---------------- one report ----------------
  const st = CATEGORY_STYLE[active.category] || CATEGORY_STYLE.Attendance;
  const Icon = st.icon;
  const has = (f: ReportMeta['filters'][number]) => active.filters.includes(f);
  const presets: [string, 'today' | 'last_7' | 'this_month' | 'last_month'][] = [
    ['Today', 'today'],
    ['Last 7 days', 'last_7'],
    ['This month', 'this_month'],
    ['Last month', 'last_month']
  ];

  return (
    <div className="space-y-4">
      <button type="button" onClick={() => setActive(null)} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800">
        <ArrowLeft className="w-3.5 h-3.5" /> All reports
      </button>

      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${st.tint}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{active.category}</div>
            <h2 className="text-base font-bold text-slate-900">{active.title}</h2>
            <p className="text-xs text-slate-500">{active.description}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          {has('date') && (
            <>
              <div>
                <label className={labelCls}>{active.dateLabel} from</label>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>To</label>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
              </div>
            </>
          )}
          {has('department') && (
            <div>
              <label className={labelCls}>Department</label>
              <select value={department} onChange={(e) => setDepartment(e.target.value)} className={inputCls}>
                <option value="">All departments</option>
                {catalog.departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          {has('employee') && (
            <div>
              <label className={labelCls}>Employee</label>
              <input value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="Name or Emp ID" className={inputCls} />
            </div>
          )}
          {has('status') && active.statuses.length > 0 && (
            <div>
              <label className={labelCls}>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                <option value="">All</option>
                {active.statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          {has('date') ? (
            <div className="flex gap-1.5 flex-wrap">
              {presets.map(([label, p]) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    const [f, t] = presetRange(p, catalog.today);
                    setFrom(f);
                    setTo(t);
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-slate-200 text-slate-600 hover:border-violet-300 hover:text-violet-700"
                >
                  {label}
                </button>
              ))}
              {active.maxDays && <span className="text-[11px] text-slate-400 self-center">Up to {active.maxDays} days</span>}
            </div>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-60"
          >
            {running ? <Spinner size={14} /> : <Play className="w-4 h-4 fill-current" />} {running ? 'Running…' : 'Run Report'}
          </button>
        </div>
        {runError && <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">{runError}</div>}
      </div>

      {result && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-slate-500">
                {result.from && (
                  <>
                    <span className="font-semibold text-slate-700">
                      {fmtDate(result.from)} – {fmtDate(result.to)}
                    </span>
                    {' · '}
                  </>
                )}
                {shownRows.length} row{shownRows.length === 1 ? '' : 's'}
                {filtersText && ` · ${filtersText}`}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={tableFilter}
                    onChange={(e) => setTableFilter(e.target.value)}
                    placeholder="Find in result…"
                    className="pl-8 pr-3 py-1.5 w-44 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => doExport('xlsx')}
                  disabled={!shownRows.length || !!exporting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> {exporting === 'xlsx' ? 'Exporting…' : 'Excel'}
                </button>
                <button
                  type="button"
                  onClick={() => doExport('pdf')}
                  disabled={!shownRows.length || !!exporting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-50"
                >
                  <FileDown className="w-3.5 h-3.5" /> {exporting === 'pdf' ? 'Exporting…' : 'PDF'}
                </button>
              </div>
            </div>
            {result.summary.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {(tableFilter ? [{ label: 'Rows shown', value: shownRows.length }] : result.summary).map((s) => (
                  <div key={s.label} className="px-3 py-2 rounded-xl bg-violet-50/70 border border-violet-100">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-500">{s.label}</div>
                    <div className="text-sm font-bold text-slate-900 tabular-nums">
                      {typeof s.value === 'number' ? s.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : s.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {shownRows.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-12 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-xs font-semibold text-slate-500">No records for these filters.</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-22rem)] min-h-[16rem]">
              <table className="w-full border-collapse text-[11.5px] leading-snug">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2.5 py-2 border-b border-slate-200 text-right font-semibold w-10">SL</th>
                    {result.columns.map((c) => (
                      <th
                        key={c.key}
                        className={`px-2.5 py-2 border-b border-slate-200 font-semibold whitespace-nowrap ${isNumeric(c.type) ? 'text-right' : 'text-left'}`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((row, i) => (
                    <tr key={i} className="odd:bg-white even:bg-slate-50/60 hover:bg-violet-50/50">
                      <td className="px-2.5 py-1.5 border-b border-slate-100 text-right text-slate-400 tabular-nums">{i + 1}</td>
                      {result.columns.map((c) => (
                        <td
                          key={c.key}
                          className={`px-2.5 py-1.5 border-b border-slate-100 text-slate-700 ${
                            isNumeric(c.type)
                              ? 'text-right tabular-nums whitespace-nowrap'
                              : c.type === 'date' || c.type === 'datetime' || c.key === 'emp_code' || c.key.endsWith('_no')
                                ? 'whitespace-nowrap'
                                : ''
                          }`}
                        >
                          {display(row[c.key], c.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
