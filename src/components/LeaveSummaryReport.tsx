/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Leave -> Employee Leave Summary. Every approved leave in a
// date range, one block per employee (Id, Name, Join Date, Job Status,
// Designation, Branch, Division, Department), then Leave Year -> Leave Type
// rows with a total per type and per year — the same layout as HR's
// "Leave Summary Report" Excel, so the download can replace that sheet.
// Gated by the 'summary_report' layer of the 'leave_applications' module.

import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Search, CalendarRange } from 'lucide-react';
import * as XLSX from 'xlsx';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { loadPdfCompany, drawStandardHeader, PdfCompany } from '../lib/pdfStandard';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';

interface LeaveRow {
  from: string | null;
  to: string | null;
  days: number;
  remarks: string;
}
interface LeaveTypeGroup {
  leave_type: string;
  is_paid: boolean;
  rows: LeaveRow[];
}
interface SummaryEmployee {
  employee_pk: number | null;
  employee_id: string;
  name: string;
  designation: string;
  branch: string;
  division: string;
  department: string;
  job_status: string;
  joining_date: string | null;
  years: { year: string; types: LeaveTypeGroup[] }[];
}

// 2026-08-06 -> 06-08-2026 (the sheet's date style)
const dmy = (d: string | null) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}-${m}-${y}`;
};
const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const sum = (rows: { days: number }[]) => rows.reduce((s, r) => s + (Number(r.days) || 0), 0);

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- Excel: 16 columns (A-P) with the same merged pairs as the HR sheet ----
function buildWorkbook(employees: SummaryEmployee[], co: PdfCompany, from: string, to: string) {
  const rows: (string | number | null)[][] = [];
  const merges: XLSX.Range[] = [];
  const blank = () => new Array(16).fill(null);
  const m = (r: number, c1: number, c2: number, r2 = r) => merges.push({ s: { r, c: c1 }, e: { r: r2, c: c2 } });
  const put = (cells: [number, string | number | null][]) => {
    const row = blank();
    for (const [c, v] of cells) row[c] = v;
    rows.push(row);
    return rows.length - 1;
  };

  let r = put([[0, co.name]]);
  rows.push(blank());
  m(r, 0, 15, r + 1);
  r = put([[0, (co.address || '').replace(/\n+/g, ', ')]]);
  m(r, 0, 15);
  r = put([[0, `Leave Summary Report (${dmy(from)} To ${dmy(to)})`]]);
  m(r, 0, 15);
  for (let i = 0; i < 4; i++) rows.push(blank());

  employees.forEach((e, idx) => {
    if (idx > 0) {
      rows.push(blank());
      rows.push(blank());
    }
    const info: [string, string, string, string][] = [
      ['Employee Id', e.employee_id, 'Designation', e.designation],
      ['Employee Name', e.name, 'Branch', e.branch],
      ['Join Date', dmy(e.joining_date), 'Division', e.division],
      ['Job Status', e.job_status, 'Department', e.department]
    ];
    for (const [l1, v1, l2, v2] of info) {
      r = put([[0, l1], [4, v1 || ''], [8, l2], [12, v2 || '']]);
      m(r, 0, 3);
      m(r, 4, 7);
      m(r, 8, 11);
      m(r, 12, 15);
    }
    rows.push(blank());
    r = put([[0, 'Leave Year'], [2, 'Leave Type'], [4, 'Is Paid \n Leave'], [6, 'Leave From'], [8, 'Leave To'], [10, 'Leave Availed'], [12, 'Remarks']]);
    [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 15]].forEach(([a, b]) => m(r, a, b));

    for (const y of e.years) {
      y.types.forEach((t, ti) => {
        t.rows.forEach((lr, ri) => {
          r = put([
            [0, ti === 0 && ri === 0 ? y.year : null],
            [2, ri === 0 ? t.leave_type : null],
            [4, ri === 0 ? (t.is_paid ? 'Yes' : 'No') : null],
            [6, dmy(lr.from)],
            [8, dmy(lr.to)],
            [10, Number(lr.days) || 0],
            [12, lr.remarks || '']
          ]);
          [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 15]].forEach(([a, b]) => m(r, a, b));
        });
        r = put([[0, 'Total Leave Availed'], [10, sum(t.rows)]]);
        m(r, 0, 9);
        m(r, 10, 11);
      });
      r = put([[0, `Total Leave Availed in ${y.year}`], [10, y.types.reduce((s, t) => s + sum(t.rows), 0)]]);
      m(r, 0, 9);
      m(r, 10, 11);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  ws['!cols'] = new Array(16).fill({ wch: 9.14 });
  // Leave Availed as 1.0 / 2.0, like the sheet.
  for (let i = 0; i < rows.length; i++) {
    const cell = ws[XLSX.utils.encode_cell({ r: i, c: 10 })];
    if (cell && typeof cell.v === 'number') cell.z = '0.0';
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${dmy(from)} To ${dmy(to)}`.slice(0, 31));
  return wb;
}

// ---- PDF: company header once, then each employee's block ----
async function buildPdf(employees: SummaryEmployee[], co: PdfCompany, from: string, to: string) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  let y = drawStandardHeader(doc, co, `Leave Summary Report (${dmy(from)} To ${dmy(to)})`);
  const pageH = doc.internal.pageSize.getHeight();
  const grid = { theme: 'grid' as const, margin: { left: 8, right: 8, top: 12, bottom: 14 }, styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.4, textColor: [40, 40, 40] as [number, number, number], lineColor: [215, 215, 215] as [number, number, number], lineWidth: 0.1 } };

  for (const e of employees) {
    if (y > pageH - 60) {
      doc.addPage();
      y = 14;
    }
    autoTable(doc, {
      ...grid,
      startY: y,
      body: [
        ['Employee Id', e.employee_id || '', 'Designation', e.designation || ''],
        ['Employee Name', e.name, 'Branch', e.branch || ''],
        ['Join Date', dmy(e.joining_date), 'Division', e.division || ''],
        ['Job Status', e.job_status || '', 'Department', e.department || '']
      ],
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 }, 1: { cellWidth: 63 }, 2: { fontStyle: 'bold', cellWidth: 30 }, 3: { cellWidth: 71 } }
    });
    y = (doc as any).lastAutoTable.finalY + 2;
    const body: any[] = [];
    for (const yr of e.years) {
      yr.types.forEach((t, ti) => {
        t.rows.forEach((lr, ri) =>
          body.push([ti === 0 && ri === 0 ? yr.year : '', ri === 0 ? t.leave_type : '', ri === 0 ? (t.is_paid ? 'Yes' : 'No') : '', dmy(lr.from), dmy(lr.to), one(lr.days), lr.remarks || ''])
        );
        body.push([{ content: 'Total Leave Availed', colSpan: 5, styles: { fontStyle: 'bold' } }, { content: one(sum(t.rows)), styles: { fontStyle: 'bold', halign: 'right' } }, '']);
      });
      body.push([
        { content: `Total Leave Availed in ${yr.year}`, colSpan: 5, styles: { fontStyle: 'bold' } },
        { content: one(yr.types.reduce((s, t) => s + sum(t.rows), 0)), styles: { fontStyle: 'bold', halign: 'right' } },
        ''
      ]);
    }
    autoTable(doc, {
      ...grid,
      startY: y,
      head: [['Leave Year', 'Leave Type', 'Is Paid Leave', 'Leave From', 'Leave To', 'Leave Availed', 'Remarks']],
      headStyles: { fillColor: [246, 246, 246], textColor: [40, 40, 40], fontStyle: 'bold', halign: 'center' },
      body,
      columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 32 }, 2: { cellWidth: 18, halign: 'center' }, 3: { cellWidth: 22 }, 4: { cellWidth: 22 }, 5: { cellWidth: 20, halign: 'right' } }
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  }
  finalizePdfPageNumbers(doc);
  return doc;
}

export const LeaveSummaryReport: React.FC<{ token: string; departments: string[] }> = ({ token, departments }) => {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [department, setDepartment] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<SummaryEmployee[] | null>(null);
  const [loaded, setLoaded] = useState<{ from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<'' | 'excel' | 'pdf'>('');

  const load = async () => {
    if (!from || !to || from > to) return setError('Pick a valid From and To date.');
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ from, to, ...(department ? { department } : {}) });
      const res = await fetch(apiUrl(`/api/leave-applications/summary-report?${qs}`), { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load the report.');
      setData(d.employees || []);
      setLoaded({ from, to });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data || [];
    return needle ? list.filter((e) => e.name.toLowerCase().includes(needle) || e.employee_id.toLowerCase().includes(needle)) : list;
  }, [data, q]);

  const exportFile = async (kind: 'excel' | 'pdf') => {
    if (!loaded || shown.length === 0) return;
    setExporting(kind);
    try {
      const co = await loadPdfCompany(token);
      const name = `Employee_Leave_Summary_Report_${dmy(loaded.from)}_To_${dmy(loaded.to)}`;
      if (kind === 'excel') XLSX.writeFile(buildWorkbook(shown, co, loaded.from, loaded.to), `${name}.xlsx`);
      else await savePdfCrossPlatform(await buildPdf(shown, co, loaded.from, loaded.to), `${name}.pdf`);
    } catch (err: any) {
      setError(err.message || 'Could not create the file.');
    } finally {
      setExporting('');
    }
  };

  const inputCls = 'px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500';
  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <CalendarRange className="w-5 h-5 text-blue-600" />
            Employee Leave Summary
          </h3>
          <p className="text-sm text-slate-500 mt-1">Approved leave in the period, employee by employee — totals per leave type and per year.</p>
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs font-semibold text-slate-500">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} block mt-1`} />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} block mt-1`} />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Department
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className={`${inputCls} block mt-1`}>
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={load} disabled={loading} className="px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            {loading ? 'Loading…' : 'Show Report'}
          </button>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or Employee Id…" className={`${inputCls} w-full pl-9`} />
          </div>
          <button
            type="button"
            onClick={() => exportFile('excel')}
            disabled={!shown.length || !!exporting}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          >
            {exporting === 'excel' ? <Spinner size={14} /> : <Download className="w-4 h-4" />} Excel
          </button>
          <button
            type="button"
            onClick={() => exportFile('pdf')}
            disabled={!shown.length || !!exporting}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50"
          >
            {exporting === 'pdf' ? <Spinner size={14} /> : <FileText className="w-4 h-4" />} PDF
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="p-10 flex justify-center">
          <Spinner />
        </div>
      ) : error ? (
        <p className="p-6 text-sm text-rose-600">{error}</p>
      ) : shown.length === 0 ? (
        <p className="p-10 text-center text-sm text-slate-400">No approved leave in this period.</p>
      ) : (
        <div className="p-4 sm:p-6 space-y-6">
          <p className="text-xs text-slate-500">
            {shown.length} employee(s) · {loaded ? `${dmy(loaded.from)} To ${dmy(loaded.to)}` : ''}
          </p>
          {shown.map((e) => (
            <div key={`${e.employee_pk ?? e.name}`} className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 p-4 bg-slate-50 text-sm">
                {(
                  [
                    ['Employee Id', e.employee_id],
                    ['Designation', e.designation],
                    ['Employee Name', e.name],
                    ['Branch', e.branch],
                    ['Join Date', dmy(e.joining_date)],
                    ['Division', e.division],
                    ['Job Status', e.job_status],
                    ['Department', e.department]
                  ] as [string, string][]
                ).map(([l, v]) => (
                  <div key={l} className="flex gap-2">
                    <span className="w-32 shrink-0 font-semibold text-slate-600">{l}</span>
                    <span className="text-slate-900">{v || '—'}</span>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white text-xs font-semibold text-slate-500 border-b border-slate-200">
                    <tr>
                      {['Leave Year', 'Leave Type', 'Is Paid Leave', 'Leave From', 'Leave To', 'Leave Availed', 'Remarks'].map((h) => (
                        <th key={h} className={`px-3 py-2 ${h === 'Leave Availed' ? 'text-right' : 'text-left'} whitespace-nowrap`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {e.years.map((yr) => (
                      <React.Fragment key={yr.year}>
                        {yr.types.map((t, ti) => (
                          <React.Fragment key={t.leave_type}>
                            {t.rows.map((lr, ri) => (
                              <tr key={ri} className="border-b border-slate-100">
                                <td className="px-3 py-1.5">{ti === 0 && ri === 0 ? yr.year : ''}</td>
                                <td className="px-3 py-1.5">{ri === 0 ? t.leave_type : ''}</td>
                                <td className="px-3 py-1.5">{ri === 0 ? (t.is_paid ? 'Yes' : 'No') : ''}</td>
                                <td className="px-3 py-1.5 whitespace-nowrap">{dmy(lr.from)}</td>
                                <td className="px-3 py-1.5 whitespace-nowrap">{dmy(lr.to)}</td>
                                <td className="px-3 py-1.5 text-right">{one(lr.days)}</td>
                                <td className="px-3 py-1.5 text-slate-600">{lr.remarks}</td>
                              </tr>
                            ))}
                            <tr className="border-b border-slate-200 bg-slate-50/60 font-semibold">
                              <td colSpan={5} className="px-3 py-1.5">Total Leave Availed</td>
                              <td className="px-3 py-1.5 text-right">{one(sum(t.rows))}</td>
                              <td />
                            </tr>
                          </React.Fragment>
                        ))}
                        <tr className="border-b border-slate-300 bg-blue-50/60 font-bold">
                          <td colSpan={5} className="px-3 py-1.5">Total Leave Availed in {yr.year}</td>
                          <td className="px-3 py-1.5 text-right">{one(yr.types.reduce((s, t) => s + sum(t.rows), 0))}</td>
                          <td />
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LeaveSummaryReport;
