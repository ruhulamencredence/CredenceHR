// Payroll -> Approval -> Top Sheet (Payroll layer "top_sheet"): Accounts'
// salary top sheet, laid out like the paper one — one line per Branch / site
// (or Department): Actual Salary, Salary after deduction, Allowance, Arrear,
// Gross, Other Deduction, Advance, TDS, Loan, Employee Contribution, Net, and
// how it is paid (EBL Card / Cash / Bank, MFS when used), the total, and
// Prepared / Authorized / Approved By from the month's approval. A site's
// name opens its own sheet (one line per employee, with the "Salary
// payable … Total withdraw" block). Excel: the top sheet plus one sheet per
// site; PDF the same; Email sends the PDF.
// GET /api/payroll/approval/:month/top-sheet?by=branch|department.
import { maskMoney, amountsHidden, AMOUNT_MASK } from '../lib/payrollAmounts';
import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import { ChevronDown, ChevronRight, FileDown, FileSpreadsheet, Layers, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { drawStandardHeader, loadPdfCompany, standardTable } from '../lib/pdfStandard';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform, saveWorkbookCrossPlatform } from '../lib/saveFile';
import { EmailReportButton, emailReport, useCanEmailReports } from '../lib/reportEmail';
import { LoadingBlock } from './LoadingBlock';
import { Spinner } from './Spinner';

type Amounts = {
  actual: number; after: number; allowance: number; arrear: number; gross: number; other: number; advance: number; loan: number;
  tds: number; pf: number; total_deduction: number; net: number; bank: number; card: number; cash: number; mfs: number;
};
interface Row extends Amounts {
  id: number;
  employee_code: string;
  employee_name: string;
  designation: string;
  department: string;
  joining_date: string | null;
  working_days: number;
  present_days: number;
  status: string;
  remarks: string;
}
interface Group { name: string; employees: number; totals: Amounts; rows: Row[] }
interface Sign { name: string | null; at: string | null }
interface TopSheet {
  month_year: string;
  by: 'branch' | 'department';
  company: string;
  status: string;
  payment_date: string | null;
  signatures: { prepared: Sign; authorized: Sign; approved: Sign };
  totals: Amounts & { employees: number };
  groups: Group[];
  held: { count: number; net: number; people: { name: string; code: string; net: number; reason: string | null }[] };
}

const n0 = maskMoney((v: number) => (Number(v) ? Math.round(Number(v)).toLocaleString('en-US') : '–'));
const monthTitle = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }).toUpperCase() + `-${y}`;
};
const dmy = (d: string | null | undefined, short = false) => {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  return `${dd}-${m}-${short ? y.slice(2) : y}`;
};
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

// The top sheet's columns, in the paper sheet's order.
const TOP_COLS: { key: keyof Amounts; label: string }[] = [
  { key: 'actual', label: 'Actual Salary' },
  { key: 'after', label: 'Salary after deduction' },
  { key: 'allowance', label: 'Allowance' },
  { key: 'arrear', label: 'Arrear' },
  { key: 'gross', label: 'Gross Salary' },
  { key: 'other', label: 'Other Deduction' },
  { key: 'advance', label: 'Advance' },
  { key: 'tds', label: 'TDS' },
  { key: 'loan', label: 'Loan' },
  { key: 'pf', label: 'Employee Contribution' },
  { key: 'net', label: 'Net Salary' },
  { key: 'card', label: 'By EBL Card' },
  { key: 'cash', label: 'By Cash' },
  { key: 'bank', label: 'By Bank' },
  { key: 'mfs', label: 'By MFS' }
];
// A site's own sheet.
const SITE_COLS: { key: keyof Row; label: string; num?: boolean }[] = [
  { key: 'actual', label: 'Actual Salary (A)', num: true },
  { key: 'working_days', label: 'Working Day' },
  { key: 'present_days', label: 'Present' },
  { key: 'after', label: 'Salary after penalty deduction', num: true },
  { key: 'allowance', label: 'Allowance (B)', num: true },
  { key: 'arrear', label: 'Arrear (C)', num: true },
  { key: 'gross', label: 'Gross Salary (A+B+C=D)', num: true },
  { key: 'other', label: 'Other Deduction', num: true },
  { key: 'advance', label: 'Advance (E)', num: true },
  { key: 'loan', label: 'Loan (F)', num: true },
  { key: 'tds', label: 'TDS (G)', num: true },
  { key: 'pf', label: 'Employee Contribution (H)', num: true },
  { key: 'total_deduction', label: 'Total (E+F+G+H=I)', num: true },
  { key: 'net', label: 'Net Payable (D-I=J)', num: true },
  { key: 'bank', label: 'Bank Salary', num: true },
  { key: 'card', label: 'Salary EBL Card', num: true },
  { key: 'cash', label: 'Cash Salary', num: true },
  { key: 'mfs', label: 'MFS', num: true }
];

const signLine = (s: Sign, role: string) => (s.name ? `${s.name}${s.at ? ` · ${dmy(s.at)}` : ''}` : role);
const siteSummary = (t: Amounts): [string, number][] => [
  ['Salary Payable', t.gross],
  ['Less: Advance & Deduction', t.total_deduction],
  ['Total withdraw', t.net],
  ['Salary From Bank (Transfer from Bank)', t.bank],
  ['Salary From Bank (Transfer from EBL Card)', t.card],
  ['Salary from Cash (withdraw by cheque)', t.cash],
  ...(t.mfs ? ([['Salary through MFS', t.mfs]] as [string, number][]) : []),
  ['Total Withdraw From Cash and Bank', t.cash + t.bank]
];

export const PayrollTopSheet: React.FC<{ token: string; month: string }> = ({ token, month }) => {
  const [by, setBy] = useState<'branch' | 'department'>('branch');
  const [data, setData] = useState<TopSheet | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [site, setSite] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'pdf' | 'email'>('');
  const canEmail = useCanEmailReports();

  useEffect(() => {
    if (!open) return;
    let gone = false;
    setData(null);
    setError('');
    setSite(null);
    fetch(apiUrl(`/api/payroll/approval/${month}/top-sheet?by=${by}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || `Could not load the top sheet (${r.status}).`);
        if (!gone) setData(d);
      })
      .catch((e) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, [token, month, by, open]);

  // MFS only when someone is paid that way (the paper sheet has no MFS column).
  const topCols = useMemo(() => TOP_COLS.filter((c) => c.key !== 'mfs' || (data?.totals.mfs || 0) > 0), [data]);
  const siteCols = useMemo(() => SITE_COLS.filter((c) => c.key !== 'mfs' || (data?.totals.mfs || 0) > 0), [data]);
  const sheetDate = data?.payment_date || todayIso();
  const title = `SALARY FOR THE MONTH OF ${monthTitle(month)}`;
  const groupLabel = by === 'department' ? 'Department' : 'Branch / Site';
  const fileBase = `Top-Sheet-${month}`;
  const shown = data?.groups.find((g) => g.name === site) || null;

  // ---- Excel: the top sheet, then one sheet per site ----------------------
  const exportExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const sig = data.signatures;
    const signRow = ['', `Prepared By: ${signLine(sig.prepared, 'HR')}`, '', '', '', `Authorized By: ${signLine(sig.authorized, 'HR Director')}`, '', '', '', `Approved By: ${signLine(sig.approved, 'Accounts')}`];
    const top: any[][] = [
      [data.company || 'Credence Housing Limited'],
      ['SALARY SHEET'],
      [title],
      [`Date: ${dmy(sheetDate, true)}`],
      ['SL', groupLabel, ...topCols.map((c) => c.label)],
      ...data.groups.map((g, i) => [i + 1, g.name, ...topCols.map((c) => g.totals[c.key] || 0)]),
      ['TOTAL', '', ...topCols.map((c) => data.totals[c.key] || 0)],
      [],
      signRow
    ];
    const ws = XLSX.utils.aoa_to_sheet(top);
    ws['!cols'] = [{ wch: 5 }, { wch: 42 }, ...topCols.map(() => ({ wch: 14 }))];
    XLSX.utils.book_append_sheet(wb, ws, 'Top Sheet');
    const used = new Set<string>(['Top Sheet']);
    for (const g of data.groups) {
      let name = g.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Site';
      for (let k = 2; used.has(name); k++) name = `${name.slice(0, 25)} ${k}`;
      used.add(name);
      const rows: any[][] = [
        [(data.company || 'Credence Housing Limited').toUpperCase()],
        [title],
        [g.name],
        ['Sl No.', 'Name', 'Designation', 'ID No.', 'DOJ', ...siteCols.map((c) => c.label), 'Remarks'],
        ...g.rows.map((r, i) => [i + 1, r.employee_name, r.designation, r.employee_code, dmy(r.joining_date), ...siteCols.map((c) => r[c.key] as any), r.remarks]),
        ['Total', '', '', '', '', ...siteCols.map((c) => (c.num ? (g.totals as any)[c.key] || 0 : '')), ''],
        [],
        ...siteSummary(g.totals).map(([l, v]) => ['', l, '', '', '', v]),
        [],
        ['', 'Prepared By:', '', '', '', '', '', 'Authorized', '', '', '', '', 'Approved By:']
      ];
      const sw = XLSX.utils.aoa_to_sheet(rows);
      sw['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, ...siteCols.map(() => ({ wch: 13 })), { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, sw, name);
    }
    void saveWorkbookCrossPlatform(wb, `${fileBase}.xlsx`);
  };

  // ---- PDF: the top sheet, then each site on its own page ----------------
  const buildPdf = async () => {
    if (!data) return null;
    const co = await loadPdfCompany(token);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const signatures = (y: number, s: TopSheet['signatures']) => {
      const parts: [string, string][] = [['Prepared By', signLine(s.prepared, 'HR')], ['Authorized By', signLine(s.authorized, 'HR Director')], ['Approved By', signLine(s.approved, 'Accounts')]];
      const w = (W - 28) / 3;
      parts.forEach(([h, v], i) => {
        const x = 14 + i * w;
        doc.setDrawColor(150);
        doc.line(x + 6, y, x + w - 6, y);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(h, x + w / 2, y + 4, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(v, x + w / 2, y + 8, { align: 'center' });
      });
    };
    const afterTable = () => (doc as any).lastAutoTable?.finalY || 40;
    let y = drawStandardHeader(doc, co, 'Salary Sheet — Top Sheet', [
      ['Month', title.replace('SALARY FOR THE MONTH OF ', '')],
      ['Date', dmy(sheetDate)],
      ['Grouped by', groupLabel],
      ...(data.held.count ? ([['On hold (not included)', `${data.held.count} · ${n0(data.held.net)}`]] as [string, string][]) : [])
    ]);
    autoTable(doc, {
      ...standardTable(y + 3),
      styles: { ...standardTable(0).styles, fontSize: 6.3, cellPadding: 1.2 },
      head: [['SL', groupLabel, ...topCols.map((c) => c.label)]],
      body: data.groups.map((g, i) => [i + 1, g.name, ...topCols.map((c) => n0(g.totals[c.key]))]),
      foot: [[{ content: 'TOTAL', colSpan: 2, styles: { halign: 'left' } }, ...topCols.map((c) => n0(data.totals[c.key]))]],
      columnStyles: Object.fromEntries([[0, { halign: 'center', cellWidth: 7 }], [1, { halign: 'left', cellWidth: 48 }], ...topCols.map((_, i) => [i + 2, { halign: 'right' }])])
    });
    y = afterTable() + 16;
    if (y > doc.internal.pageSize.getHeight() - 20) {
      doc.addPage();
      y = 30;
    }
    signatures(y, data.signatures);
    for (const g of data.groups) {
      doc.addPage();
      const gy = drawStandardHeader(doc, co, g.name, [['Month', title.replace('SALARY FOR THE MONTH OF ', '')], ['Employees', String(g.employees)]]);
      autoTable(doc, {
        ...standardTable(gy + 3),
        styles: { ...standardTable(0).styles, fontSize: 5.6, cellPadding: 1 },
        head: [['Sl', 'Name', 'Designation', 'ID No.', 'DOJ', ...siteCols.map((c) => c.label), 'Remarks']],
        body: g.rows.map((r, i) => [i + 1, r.employee_name, r.designation, r.employee_code, dmy(r.joining_date), ...siteCols.map((c) => (c.num ? n0(r[c.key] as number) : String(r[c.key] ?? ''))), r.remarks]),
        foot: [[{ content: 'Total', colSpan: 5, styles: { halign: 'left' } }, ...siteCols.map((c) => (c.num ? n0((g.totals as any)[c.key]) : '')), '']],
        columnStyles: Object.fromEntries([[0, { halign: 'center', cellWidth: 6 }], [1, { halign: 'left' }], ...siteCols.map((c, i) => [i + 5, { halign: c.num ? 'right' : 'center' }])])
      });
      autoTable(doc, {
        ...standardTable(afterTable() + 4),
        margin: { left: W - 14 - 110, right: 14 },
        tableWidth: 110,
        body: siteSummary(g.totals).map(([l, v]) => [l, n0(v)]),
        columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right', fontStyle: 'bold' } }
      });
      let sy = afterTable() + 14;
      if (sy > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage();
        sy = 30;
      }
      signatures(sy, data.signatures);
    }
    finalizePdfPageNumbers(doc);
    return doc;
  };
  const exportPdf = async (mode: 'save' | 'email') => {
    setBusy(mode === 'save' ? 'pdf' : 'email');
    setError('');
    try {
      const doc = await buildPdf();
      if (!doc) return;
      if (mode === 'email') await emailReport(doc, { fileName: `${fileBase}.pdf`, title: `Salary Top Sheet — ${title.replace('SALARY FOR THE MONTH OF ', '')}` });
      else await savePdfCrossPlatform(doc, `${fileBase}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy('');
    }
  };

  const th = 'px-2.5 py-2 text-right font-semibold whitespace-nowrap border border-violet-100';
  const td = 'px-2.5 py-1.5 text-right whitespace-nowrap tabular-nums border border-slate-100';
  const kpi = (label: string, v: number, money = true) => (
    <div className="rounded-xl border border-slate-200 px-3 py-2 min-w-0">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-sm font-bold text-slate-800 tabular-nums truncate">{money ? (amountsHidden(v) ? AMOUNT_MASK : `৳ ${Math.round(v).toLocaleString('en-US')}`) : v}</p>
    </div>
  );
  const SignBlock: React.FC<{ s: TopSheet['signatures'] }> = ({ s }) => (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-4 pt-8 pb-4">
      {([['Prepared By', s.prepared, 'HR'], ['Authorized By', s.authorized, 'HR Director'], ['Approved By', s.approved, 'Accounts']] as [string, Sign, string][]).map(([h, v, role]) => (
        <div key={h} className="border-t border-slate-300 pt-1.5 text-center">
          <p className="text-xs font-bold text-slate-800">{h}</p>
          <p className="text-[11px] text-slate-500">{signLine(v, role)}</p>
        </div>
      ))}
    </div>
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-violet-600 shrink-0" />
          <span className="text-sm font-bold text-slate-800">Top Sheet</span>
          {data && <span className="text-[11px] text-slate-500 truncate">{data.groups.length} {by === 'department' ? 'departments' : 'branches / sites'} · {data.totals.employees} employees — Accounts' salary top sheet</span>}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 space-y-3">
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="ts-by" className="block text-[10px] font-semibold text-slate-500 mb-1">Group by</label>
              <select id="ts-by" value={by} onChange={(e) => setBy(e.target.value === 'department' ? 'department' : 'branch')} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none">
                <option value="branch">Branch / Site</option>
                <option value="department">Department</option>
              </select>
            </div>
            {data && (
              <span className={`self-center text-[11px] font-semibold px-2.5 py-1 rounded-full ${data.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                {data.status === 'paid' ? `Paid${data.payment_date ? ` · ${dmy(data.payment_date)}` : ''}` : data.status.charAt(0).toUpperCase() + data.status.slice(1)}
              </span>
            )}
            <div className="flex-1" />
            {canEmail && <EmailReportButton onClick={() => void exportPdf('email')} disabled={!data?.groups.length || !!busy} />}
            <button type="button" onClick={exportExcel} disabled={!data?.groups.length} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel (Top Sheet + each site)
            </button>
            <button type="button" onClick={() => void exportPdf('save')} disabled={!data?.groups.length || !!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
              {busy === 'pdf' ? <Spinner size={14} /> : <FileDown className="w-3.5 h-3.5" />} PDF
            </button>
          </div>

          {!data ? (
            !error && <LoadingBlock />
          ) : data.groups.length === 0 ? (
            <p className="text-xs text-slate-500">No salary for this month yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {kpi('Employees', data.totals.employees, false)}
                {kpi('Gross Salary', data.totals.gross)}
                {kpi('Net Salary', data.totals.net)}
                {kpi('By Bank', data.totals.bank)}
                {kpi('By EBL Card', data.totals.card)}
                {kpi(data.totals.mfs ? 'By Cash / MFS' : 'By Cash', data.totals.cash + data.totals.mfs)}
              </div>
              {data.held.count > 0 && (
                <p className="text-[11px] text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
                  On hold, not in this sheet: {data.held.people.map((p) => `${p.name} (${n0(p.net)})`).join(', ')}
                </p>
              )}

              <div className="border border-slate-300 rounded-xl overflow-hidden">
                <div className="text-center py-2.5 border-b border-slate-200 bg-violet-50/40">
                  <p className="text-sm font-bold text-slate-900">{data.company || 'Credence Housing Limited'}</p>
                  <p className="text-xs font-bold tracking-wide text-slate-800">SALARY SHEET</p>
                  <p className="text-[11px] text-slate-500">{title} · Date: {dmy(sheetDate, true)}</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-violet-50 text-violet-950 text-[10.5px]">
                      <tr>
                        <th className="px-2 py-2 text-center font-semibold border border-violet-100">SL</th>
                        <th className="px-2.5 py-2 text-left font-semibold border border-violet-100 sticky left-0 bg-violet-50 z-10 min-w-[200px] sm:min-w-[260px]">Name ({groupLabel})</th>
                        {topCols.map((c) => (
                          <th key={c.key} className={th}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((g, i) => (
                        <tr key={g.name} className={site === g.name ? 'bg-amber-50' : 'hover:bg-slate-50'}>
                          <td className="px-2 py-1.5 text-center text-slate-400 border border-slate-100">{i + 1}</td>
                          <td className={`px-2.5 py-1.5 border border-slate-100 sticky left-0 z-10 min-w-[200px] sm:min-w-[260px] ${site === g.name ? 'bg-amber-50' : 'bg-white'}`}>
                            <button type="button" onClick={() => setSite(site === g.name ? null : g.name)} className="text-left font-semibold text-violet-800 underline decoration-dotted underline-offset-2 hover:text-violet-950">
                              {g.name}
                            </button>
                            <span className="ml-1.5 text-[10px] text-slate-400">{g.employees} জন</span>
                          </td>
                          {topCols.map((c) => (
                            <td key={c.key} className={`${td} ${c.key === 'net' ? 'font-bold text-blue-700 bg-blue-50/50' : 'text-slate-700'}`}>{n0(g.totals[c.key])}</td>
                          ))}
                        </tr>
                      ))}
                      <tr className="bg-violet-50/60 font-bold text-slate-900">
                        <td className="border border-violet-100" />
                        <td className="px-2.5 py-2 border border-violet-100 sticky left-0 bg-violet-50 z-10">TOTAL</td>
                        {topCols.map((c) => (
                          <td key={c.key} className={`${td} border-violet-100`}>{n0(data.totals[c.key])}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <SignBlock s={data.signatures} />
              </div>
              <p className="text-[11px] text-slate-500">যেকোনো {by === 'department' ? 'Department' : 'সাইটের'} নামে চাপলে তার বিস্তারিত sheet খোলে।</p>

              {shown && (
                <div className="border border-amber-200 rounded-xl overflow-hidden">
                  <div className="flex items-start justify-between gap-2 px-4 py-2.5 bg-amber-50/60 border-b border-amber-100">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{shown.name}</p>
                      <p className="text-[11px] text-slate-500">{title} · {shown.employees} employees</p>
                    </div>
                    <button type="button" onClick={() => setSite(null)} aria-label="Close site sheet" className="p-1.5 rounded-full text-slate-500 hover:bg-white">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600 text-[10.5px]">
                        <tr>
                          <th className="px-2 py-2 text-center font-semibold border border-slate-200">Sl</th>
                          <th className="px-2.5 py-2 text-left font-semibold border border-slate-200 sticky left-0 bg-slate-50 z-10">Name</th>
                          <th className="px-2.5 py-2 text-left font-semibold border border-slate-200">Designation</th>
                          <th className="px-2.5 py-2 text-left font-semibold border border-slate-200">ID No.</th>
                          <th className="px-2.5 py-2 text-left font-semibold border border-slate-200">DOJ</th>
                          {siteCols.map((c) => (
                            <th key={c.key} className="px-2.5 py-2 text-right font-semibold whitespace-nowrap border border-slate-200">{c.label}</th>
                          ))}
                          <th className="px-2.5 py-2 text-left font-semibold border border-slate-200">Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.rows.map((r, i) => (
                          <tr key={r.id} className="hover:bg-slate-50">
                            <td className="px-2 py-1.5 text-center text-slate-400 border border-slate-100">{i + 1}</td>
                            <td className="px-2.5 py-1.5 font-semibold text-slate-800 whitespace-nowrap border border-slate-100 sticky left-0 bg-white z-10">{r.employee_name}</td>
                            <td className="px-2.5 py-1.5 text-slate-600 whitespace-nowrap border border-slate-100">{r.designation}</td>
                            <td className="px-2.5 py-1.5 text-slate-600 whitespace-nowrap border border-slate-100">{r.employee_code}</td>
                            <td className="px-2.5 py-1.5 text-slate-600 whitespace-nowrap border border-slate-100">{dmy(r.joining_date)}</td>
                            {siteCols.map((c) => (
                              <td key={c.key} className={`${td} ${c.key === 'net' ? 'font-bold text-blue-700' : 'text-slate-700'}`}>
                                {c.num ? n0(r[c.key] as number) : String(r[c.key] ?? '')}
                              </td>
                            ))}
                            <td className="px-2.5 py-1.5 text-[11px] text-amber-700 border border-slate-100">{r.remarks}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-50 font-bold">
                          <td className="border border-slate-200" />
                          <td className="px-2.5 py-2 border border-slate-200 sticky left-0 bg-slate-50 z-10">Total</td>
                          <td className="border border-slate-200" colSpan={3} />
                          {siteCols.map((c) => (
                            <td key={c.key} className={`${td} border-slate-200`}>{c.num ? n0((shown.totals as any)[c.key]) : ''}</td>
                          ))}
                          <td className="border border-slate-200" />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end px-4 pt-3">
                    <table className="text-xs min-w-[300px]">
                      <tbody>
                        {siteSummary(shown.totals).map(([l, v]) => (
                          <tr key={l} className={/^Total/.test(l) ? 'font-bold border-b-2 border-violet-300' : 'border-b border-dashed border-slate-200'}>
                            <td className="py-1.5 pr-4 text-slate-700">{l}</td>
                            <td className="py-1.5 text-right tabular-nums font-semibold">{n0(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <SignBlock s={data.signatures} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
