/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Monthly Report": pick a month and a grouping (Department,
// Branch, Project, Grade, Designation…) and see headcount movement, joiners,
// separations, promotions, transfers, increments and confirmations, what's
// coming up (probation / contract ends), and a 12-month trend. Exports to
// PDF (company letterhead) and Excel.

import React, { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileDown, FileSpreadsheet, UserPlus, UserMinus, TrendingUp, ArrowLeftRight, BadgeCheck, Users, AlertTriangle } from 'lucide-react';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { useHrApi, taka, fmtDate, monthLabel, btnGhost, inputCls, labelCls, Notice } from './HrOpsShared';

const DIM_LABEL: Record<string, string> = {
  department: 'Department',
  branch: 'Branch',
  designation: 'Designation',
  grade: 'Grade',
  project: 'Project',
  employment_category: 'Employment Category',
  job_base: 'Job Base',
  division: 'Division',
  unit: 'Unit',
  gender: 'Gender'
};

interface Report {
  month: string;
  group_by: string;
  dimensions: string[];
  dimension_values: Record<string, string[]>;
  summary: Record<string, number>;
  lists: Record<string, any[]>;
  groups: { key: string; opening: number; closing: number; joined: number; separated: number; promotions: number; transfers: number; increments: number; confirmations: number }[];
  upcoming: { probation_ending: any[]; contract_ending: any[] };
  trend: { month: string; headcount: number; joined: number; separated: number }[];
}

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const HrOpsDashboard: React.FC<{ token: string; onOpenEmployee?: (id: number) => void }> = ({ token, onOpenEmployee }) => {
  const api = useHrApi(token);
  const [month, setMonth] = useState(thisMonth());
  const [groupBy, setGroupBy] = useState('department');
  const [filterBy, setFilterBy] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [openList, setOpenList] = useState<string | null>('joined');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const qs = new URLSearchParams({ month, group_by: groupBy });
    if (filterBy && filterValue) {
      qs.set('filter_by', filterBy);
      qs.set('filter_value', filterValue);
    }
    api
      .get<Report>(`/api/hr-ops/reports/monthly?${qs.toString()}`)
      .then((r) => alive && setReport(r))
      .catch((e) => alive && setMsg({ type: 'error', text: e.message }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, month, groupBy, filterBy, filterValue]);

  const s = report?.summary || {};
  const tiles: { key: string; label: string; value: React.ReactNode; icon: React.ComponentType<{ className?: string }>; tint: string; sub?: string }[] = [
    { key: 'headcount', label: 'Headcount', value: `${s.opening ?? 0} → ${s.closing ?? 0}`, icon: Users, tint: 'bg-slate-100 text-slate-700', sub: 'Start → end of month' },
    { key: 'joined', label: 'New Joiners', value: s.joined ?? 0, icon: UserPlus, tint: 'bg-emerald-50 text-emerald-700' },
    { key: 'separated', label: 'Separations', value: s.separated ?? 0, icon: UserMinus, tint: 'bg-rose-50 text-rose-700', sub: `Turnover ${s.turnover_pct ?? 0}% · ${s.resignations_submitted ?? 0} resignations submitted` },
    { key: 'promotions', label: 'Promotions', value: s.promotions ?? 0, icon: TrendingUp, tint: 'bg-violet-50 text-violet-700' },
    { key: 'transfers', label: 'Transfers', value: s.transfers ?? 0, icon: ArrowLeftRight, tint: 'bg-sky-50 text-sky-700' },
    { key: 'increments', label: 'Increments', value: s.increments ?? 0, icon: TrendingUp, tint: 'bg-amber-50 text-amber-700', sub: `${taka(s.increment_total ?? 0)} / month added` },
    { key: 'confirmations', label: 'Confirmations', value: s.confirmations ?? 0, icon: BadgeCheck, tint: 'bg-teal-50 text-teal-700' }
  ];

  const LISTS: { key: string; label: string; cols: [string, string][] }[] = [
    { key: 'joined', label: 'New Joiners', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['designation', 'Designation'], ['department', 'Department'], ['date', 'Joining Date']] },
    { key: 'separated', label: 'Separations', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['designation', 'Designation'], ['type', 'Type'], ['date', 'Last Working Day']] },
    { key: 'resignations_submitted', label: 'Resignations Submitted', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['date', 'Submitted'], ['last_working_day', 'Last Working Day'], ['status', 'Status']] },
    { key: 'promotions', label: 'Promotions', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['summary', 'Change'], ['effective_date', 'Effective']] },
    { key: 'transfers', label: 'Transfers', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['summary', 'Change'], ['effective_date', 'Effective']] },
    { key: 'increments', label: 'Increments', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['old_gross', 'Old Gross'], ['new_gross', 'New Gross'], ['difference', 'Increase'], ['effective_date', 'Effective']] },
    { key: 'confirmations', label: 'Confirmations', cols: [['name', 'Employee'], ['employee_code', 'ID'], ['effective_date', 'Confirmed On']] },
    { key: 'other_actions', label: 'Other HR Actions', cols: [['name', 'Employee'], ['type', 'Action'], ['summary', 'Change'], ['effective_date', 'Effective']] }
  ];
  const cell = (row: any, key: string) => {
    const v = row[key];
    if (['old_gross', 'new_gross', 'difference'].includes(key)) return taka(v);
    if (['date', 'effective_date', 'last_working_day'].includes(key)) return fmtDate(v);
    return v ?? '—';
  };

  const exportPdf = async () => {
    if (!report) return;
    try {
      const logo = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape' });
      const filters: [string, string][] = [
        ['Month', monthLabel(report.month)],
        ['Grouped By', DIM_LABEL[report.group_by] || report.group_by]
      ];
      if (filterBy && filterValue) filters.push([DIM_LABEL[filterBy], filterValue]);
      let y = drawPdfLetterhead(doc, logo, { reportTitle: 'Monthly HR Operations Report', filters });
      autoTable(doc, {
        startY: y,
        head: [['Opening', 'Closing', 'Joined', 'Separated', 'Turnover %', 'Promotions', 'Transfers', 'Increments', 'Increment Total', 'Confirmations']],
        body: [[s.opening, s.closing, s.joined, s.separated, s.turnover_pct, s.promotions, s.transfers, s.increments, taka(s.increment_total), s.confirmations].map(String)],
        styles: { fontSize: 8.5, halign: 'center' },
        headStyles: { fillColor: [124, 58, 237] }
      });
      y = (doc as any).lastAutoTable.finalY + 6;
      autoTable(doc, {
        startY: y,
        head: [[DIM_LABEL[report.group_by], 'Opening', 'Closing', 'Joined', 'Separated', 'Promotions', 'Transfers', 'Increments', 'Confirmations']],
        body: report.groups.map((g) => [g.key, g.opening, g.closing, g.joined, g.separated, g.promotions, g.transfers, g.increments, g.confirmations].map(String)),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [71, 85, 105] }
      });
      for (const l of LISTS) {
        const rows = report.lists[l.key] || [];
        if (rows.length === 0) continue;
        y = (doc as any).lastAutoTable.finalY + 8;
        if (y > 180) {
          doc.addPage();
          y = 16;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 41, 59);
        doc.text(`${l.label} (${rows.length})`, 14, y);
        autoTable(doc, {
          startY: y + 2,
          head: [l.cols.map((c) => c[1])],
          body: rows.map((r) => l.cols.map((c) => String(cell(r, c[0])))),
          styles: { fontSize: 8 },
          headStyles: { fillColor: [148, 163, 184] }
        });
      }
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `HR_Operations_${report.month}.pdf`);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message || 'Could not build the PDF.' });
    }
  };

  const exportExcel = () => {
    if (!report) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        { Metric: 'Month', Value: monthLabel(report.month) },
        ...Object.entries(report.summary).map(([k, v]) => ({ Metric: k.replace(/_/g, ' '), Value: v }))
      ]),
      'Summary'
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(report.groups.map((g) => ({ [DIM_LABEL[report.group_by]]: g.key, ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'key')) }))),
      `By ${DIM_LABEL[report.group_by]}`.slice(0, 31)
    );
    for (const l of LISTS) {
      const rows = report.lists[l.key] || [];
      if (rows.length === 0) continue;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map((r) => Object.fromEntries(l.cols.map(([k, label]) => [label, r[k] ?? ''])))), l.label.slice(0, 31));
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.trend), 'Trend');
    XLSX.writeFile(wb, `HR_Operations_${report.month}.xlsx`);
  };

  const maxTrend = Math.max(1, ...(report?.trend || []).map((t) => Math.max(t.headcount, t.joined, t.separated)));

  return (
    <div className="space-y-5">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelCls}>Month</label>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Group by</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={inputCls}>
            {Object.keys(DIM_LABEL).map((d) => (
              <option key={d} value={d}>
                {DIM_LABEL[d]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Only show</label>
          <div className="flex gap-2">
            <select
              value={filterBy}
              onChange={(e) => {
                setFilterBy(e.target.value);
                setFilterValue('');
              }}
              className={inputCls}
            >
              <option value="">Everyone</option>
              {Object.keys(DIM_LABEL).map((d) => (
                <option key={d} value={d}>
                  {DIM_LABEL[d]}
                </option>
              ))}
            </select>
            {filterBy && (
              <select value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className={inputCls}>
                <option value="">Pick…</option>
                {(report?.dimension_values?.[filterBy] || []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex gap-2 ml-auto">
          <button type="button" onClick={exportPdf} disabled={!report} className={btnGhost}>
            <FileDown className="w-3.5 h-3.5" /> PDF
          </button>
          <button type="button" onClick={exportExcel} disabled={!report} className={btnGhost}>
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>

      {loading || !report ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner size={16} /> Loading report…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            {tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setOpenList(t.key === 'headcount' ? null : t.key)}
                className={`text-left rounded-xl border p-3 transition-colors ${openList === t.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'} bg-white`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${t.tint}`}>
                  <t.icon className="w-4 h-4" />
                </div>
                <div className="text-[11px] font-semibold text-slate-500 mt-2">{t.label}</div>
                <div className="text-xl font-bold text-slate-900 leading-tight">{t.value}</div>
                {t.sub && <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{t.sub}</div>}
              </button>
            ))}
          </div>

          {(s.pending_actions > 0 || s.letters_unacknowledged > 0 || s.pending_letter_requests > 0) && (
            <div className="flex flex-wrap gap-2 text-[11px]">
              {s.pending_actions > 0 && <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{s.pending_actions} HR action(s) waiting for approval</span>}
              {s.letters_unacknowledged > 0 && <span className="px-2.5 py-1 rounded-full bg-sky-50 text-sky-700 border border-sky-200">{s.letters_unacknowledged} letter(s) not yet acknowledged</span>}
              {s.pending_letter_requests > 0 && <span className="px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 border border-violet-200">{s.pending_letter_requests} certificate request(s) pending</span>}
            </div>
          )}

          {openList && (
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {(() => {
                const l = LISTS.find((x) => x.key === openList)!;
                const rows = report.lists[l.key] || [];
                return (
                  <>
                    <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-bold text-slate-700 flex items-center justify-between">
                      <span>
                        {l.label} — {monthLabel(report.month)} ({rows.length})
                      </span>
                      {openList === 'separated' && (report.lists.resignations_submitted || []).length > 0 && (
                        <button type="button" className="text-[11px] text-blue-600 font-semibold" onClick={() => setOpenList('resignations_submitted')}>
                          Resignations submitted this month →
                        </button>
                      )}
                    </div>
                    {rows.length === 0 ? (
                      <p className="px-4 py-6 text-xs text-slate-400 text-center">Nothing this month.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-xs">
                          <thead className="bg-slate-50 text-slate-500">
                            <tr>
                              {l.cols.map((c) => (
                                <th key={c[0]} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                                  {c[1]}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {rows.map((r, i) => (
                              <tr key={i} className="hover:bg-slate-50 cursor-pointer" onClick={() => r.employee_id && onOpenEmployee?.(r.employee_id)}>
                                {l.cols.map((c) => (
                                  <td key={c[0]} className="px-3 py-2 text-slate-700 whitespace-nowrap">
                                    {cell(r, c[0])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          <div className="grid lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3 rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-bold text-slate-700">By {DIM_LABEL[report.group_by]}</div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      {[DIM_LABEL[report.group_by], 'Opening', 'Closing', 'Joined', 'Separated', 'Promoted', 'Transferred', 'Increment', 'Confirmed'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.groups.map((g) => (
                      <tr key={g.key}>
                        <td className="px-3 py-2 font-semibold text-slate-800">{g.key}</td>
                        {[g.opening, g.closing, g.joined, g.separated, g.promotions, g.transfers, g.increments, g.confirmations].map((v, i) => (
                          <td key={i} className={`px-3 py-2 ${v ? 'text-slate-800' : 'text-slate-300'}`}>
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-bold text-slate-700 mb-3">12-month trend</div>
              <div className="flex items-end gap-1.5 h-36">
                {report.trend.map((t) => (
                  <div key={t.month} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${monthLabel(t.month)}: ${t.headcount} staff, +${t.joined} / -${t.separated}`}>
                    <div className="w-full flex items-end gap-px h-28">
                      <div className="flex-1 bg-slate-300 rounded-t" style={{ height: `${(t.headcount / maxTrend) * 100}%` }} />
                      <div className="flex-1 bg-emerald-400 rounded-t" style={{ height: `${(t.joined / maxTrend) * 100}%` }} />
                      <div className="flex-1 bg-rose-400 rounded-t" style={{ height: `${(t.separated / maxTrend) * 100}%` }} />
                    </div>
                    <div className={`text-[9px] ${t.month === report.month ? 'font-bold text-slate-800' : 'text-slate-400'}`}>{monthLabel(t.month).slice(0, 3)}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 mt-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <i className="w-2 h-2 rounded-sm bg-slate-300 inline-block" /> Headcount
                </span>
                <span className="flex items-center gap-1">
                  <i className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" /> Joined
                </span>
                <span className="flex items-center gap-1">
                  <i className="w-2 h-2 rounded-sm bg-rose-400 inline-block" /> Separated
                </span>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {[
              { key: 'probation_ending', label: 'Probation ending (next 60 days)' },
              { key: 'contract_ending', label: 'Contract ending (next 60 days)' }
            ].map((u) => {
              const rows = (report.upcoming as any)[u.key] as any[];
              return (
                <div key={u.key} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> {u.label}
                  </div>
                  {rows.length === 0 ? (
                    <p className="px-4 py-5 text-xs text-slate-400 text-center">None.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {rows.map((r) => (
                        <li key={r.employee_id} className="px-4 py-2 flex items-center justify-between gap-2 text-xs cursor-pointer hover:bg-slate-50" onClick={() => onOpenEmployee?.(r.employee_id)}>
                          <span>
                            <span className="font-semibold text-slate-800">{r.name}</span> <span className="text-slate-400">{r.designation}</span>
                          </span>
                          <span className={r.overdue ? 'text-rose-600 font-semibold' : 'text-slate-600'}>
                            {fmtDate(r.date)}
                            {r.overdue ? ' · overdue' : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
