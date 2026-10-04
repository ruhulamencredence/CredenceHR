/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Mobile Bill -> Reports (GET /api/mobile-bill/report):
//   Month by month   — every number, its limit and the last 2–12 months' bills
//                      with the average (HR's "All Numbers" sheet).
//   Operator-wise    — SIMs, limit and bill per operator, month by month.
//   Over / under     — average use against the limit: who spends more, who less.
//   Excess           — bill over the limit for one month (HR's "Excess Limit
//                      Users" sheet) — what could be cut from salary. Only a
//                      report for now; nothing is deducted.
// Every view: PDF and Excel.

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileDown, FileSpreadsheet } from 'lucide-react';
import { Spinner } from './Spinner';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, pdfMoney, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { inputCls, labelCls, MbSim, mbApi, monthLabel, monthsBetween, num, OperatorBadge, shiftMonth, thisMonth, tk } from './MobileBillParts';

type View = 'matrix' | 'operator' | 'usage' | 'excess';
interface Bill {
  sim_id: number;
  month: string;
  amount: number;
  limit_amount: number;
  paid: boolean;
}
const OPERATORS = ['Grameenphone', 'Robi', 'Airtel', 'Banglalink', 'Teletalk'];
const BANDS = [
  { key: 'over', label: 'Over the limit', test: (p: number) => p > 100, cls: 'text-rose-600 bg-rose-50 border-rose-200' },
  { key: 'near', label: 'Near the limit (80–100%)', test: (p: number) => p >= 80 && p <= 100, cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  { key: 'normal', label: 'Normal (50–80%)', test: (p: number) => p >= 50 && p < 80, cls: 'text-teal-700 bg-teal-50 border-teal-200' },
  { key: 'low', label: 'Low use (under 50%)', test: (p: number) => p < 50, cls: 'text-sky-700 bg-sky-50 border-sky-200' }
];

export const MobileBillReports: React.FC<{ token: string }> = ({ token }) => {
  const [view, setView] = useState<View>('matrix');
  const [to, setTo] = useState(shiftMonth(thisMonth(), -1));
  const [span, setSpan] = useState(6);
  const [operator, setOperator] = useState('');
  const [dept, setDept] = useState('');
  const [data, setData] = useState<{ sims: MbSim[]; bills: Bill[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const from = shiftMonth(to, -(span - 1));
  const months = useMemo(() => monthsBetween(from, to).reverse(), [from, to]);
  useEffect(() => {
    setData(null);
    setError('');
    mbApi(token, `/api/mobile-bill/report?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token, from, to]);

  const departments = useMemo(() => Array.from(new Set((data?.sims || []).map((s) => s.employee?.department).filter(Boolean) as string[])).sort(), [data]);

  // One row per SIM in the filter with its bills by month.
  const rows = useMemo(() => {
    if (!data) return [];
    const bySim = new Map<number, Map<string, Bill>>();
    for (const b of data.bills) {
      if (!bySim.has(b.sim_id)) bySim.set(b.sim_id, new Map());
      bySim.get(b.sim_id)!.set(b.month, b);
    }
    return data.sims
      .filter((s) => (!operator || s.operator === operator) && (!dept || s.employee?.department === dept))
      .filter((s) => s.status === 'active' || bySim.has(s.id))
      .map((s) => {
        const bills = bySim.get(s.id) || new Map<string, Bill>();
        const amounts = months.map((m) => bills.get(m)?.amount ?? null);
        const have = amounts.filter((a): a is number => a != null);
        const avg = have.length ? have.reduce((a, b) => a + b, 0) / have.length : null;
        const limit = bills.get(to)?.limit_amount ?? s.limit_amount;
        const pct = avg != null && limit > 0 ? Math.round((avg / limit) * 100) : null;
        const overMonths = months.filter((m) => {
          const b = bills.get(m);
          return b && b.amount > b.limit_amount;
        }).length;
        return { sim: s, bills, amounts, avg, limit, pct, overMonths };
      })
      .sort((a, b) => String(a.sim.employee?.name || '~').localeCompare(String(b.sim.employee?.name || '~')));
  }, [data, months, operator, dept, to]);

  const filterText: [string, string][] = [
    ['Period', `${monthLabel(from)} – ${monthLabel(to)}`],
    ['Operator', operator || 'All'],
    ...(dept ? ([['Department', dept]] as [string, string][]) : [])
  ];

  // ---- the tables each view shows / exports ------------------------------
  const person = (s: MbSim) => [s.employee?.name || '—', s.employee?.employee_code || '', s.employee?.designation || '', s.employee?.department || ''];

  const matrix = {
    title: 'Mobile Usage — Month by Month',
    head: ['SL', 'Name', 'Emp. ID', 'Designation', 'Department', 'Work Station', 'Duty Location', 'Mobile Number', 'Operator', 'Official Ceiling', ...months.map((m) => monthLabel(m, true)), 'Avg. usage'],
    body: rows.map((r, i) => [
      i + 1,
      ...person(r.sim),
      r.sim.employee?.work_station || '',
      r.sim.duty_location || '',
      r.sim.phone_number,
      r.sim.operator,
      r.limit,
      ...r.amounts.map((a) => (a == null ? '' : a)),
      r.avg == null ? '' : Math.round(r.avg * 100) / 100
    ])
  };

  const opRows = OPERATORS.map((op) => {
    const rs = rows.filter((r) => r.sim.operator === op);
    const perMonth = months.map((m) => rs.reduce((a, r) => a + (r.bills.get(m)?.amount || 0), 0));
    const limit = rs.filter((r) => r.sim.status === 'active').reduce((a, r) => a + r.sim.limit_amount, 0);
    const excess = rs.reduce((a, r) => a + months.reduce((x, m) => x + Math.max(0, (r.bills.get(m)?.amount || 0) - (r.bills.get(m)?.limit_amount || 0)), 0), 0);
    const billedMonths = perMonth.filter((v) => v > 0);
    return { op, sims: rs.length, limit, perMonth, avg: billedMonths.length ? billedMonths.reduce((a, b) => a + b, 0) / billedMonths.length : 0, excess };
  }).filter((o) => o.sims > 0);
  const operatorTable = {
    title: 'Mobile Bill — Operator-wise',
    head: ['Operator', 'SIMs', 'Monthly limit (total)', ...months.map((m) => monthLabel(m, true)), 'Monthly average', 'Excess (period)'],
    body: [
      ...opRows.map((o) => [o.op, o.sims, Math.round(o.limit), ...o.perMonth.map((v) => Math.round(v * 100) / 100), Math.round(o.avg), Math.round(o.excess * 100) / 100]),
      [
        'Total',
        opRows.reduce((a, o) => a + o.sims, 0),
        Math.round(opRows.reduce((a, o) => a + o.limit, 0)),
        ...months.map((_, i) => Math.round(opRows.reduce((a, o) => a + o.perMonth[i], 0) * 100) / 100),
        Math.round(opRows.reduce((a, o) => a + o.avg, 0)),
        Math.round(opRows.reduce((a, o) => a + o.excess, 0) * 100) / 100
      ]
    ]
  };

  const usageRows = rows.filter((r) => r.pct != null).sort((a, b) => (b.pct || 0) - (a.pct || 0));
  const usageTable = {
    title: 'Mobile Usage against Limit',
    head: ['SL', 'Name', 'Emp. ID', 'Designation', 'Department', 'Mobile Number', 'Operator', 'Limit', `Avg. bill (${span} mo.)`, 'Avg. vs limit', 'Months over limit', 'Band'],
    body: usageRows.map((r, i) => [
      i + 1,
      ...person(r.sim),
      r.sim.phone_number,
      r.sim.operator,
      r.limit,
      Math.round((r.avg || 0) * 100) / 100,
      `${r.pct}%`,
      `${r.overMonths} of ${r.amounts.filter((a) => a != null).length}`,
      BANDS.find((b) => b.test(r.pct || 0))?.label || ''
    ])
  };

  const excessRows = rows
    .map((r) => ({ r, b: r.bills.get(to) }))
    .filter((x) => x.b && x.b.amount > x.b.limit_amount)
    .sort((a, b) => b.b!.amount - b.b!.limit_amount - (a.b!.amount - a.b!.limit_amount));
  const excessTotal = excessRows.reduce((a, x) => a + (x.b!.amount - x.b!.limit_amount), 0);
  const excessTable = {
    title: `Excess Limit Users — ${monthLabel(to)}`,
    head: ['SL', 'Name', 'Emp. ID', 'Designation', 'Department', 'Work Station', 'Duty Location', 'Mobile Number', 'Official Ceiling', `${monthLabel(to, true)} Bill`, 'Excess Amount'],
    body: [
      ...excessRows.map((x, i) => [
        i + 1,
        ...person(x.r.sim),
        x.r.sim.employee?.work_station || '',
        x.r.sim.duty_location || '',
        x.r.sim.phone_number,
        x.b!.limit_amount,
        x.b!.amount,
        Math.round((x.b!.amount - x.b!.limit_amount) * 100) / 100
      ]),
      ...(excessRows.length ? [['', 'Total', '', '', '', '', '', '', '', '', Math.round(excessTotal * 100) / 100]] : [])
    ]
  };

  const current = view === 'matrix' ? matrix : view === 'operator' ? operatorTable : view === 'usage' ? usageTable : excessTable;
  // PDF: which columns are taka amounts (2 decimals, right-aligned), and
  // whether the last body row is the Total (printed as the table's footer).
  const pdfShape = {
    matrix: { moneyFrom: 9, moneyTo: 99, total: false },
    operator: { moneyFrom: 2, moneyTo: 99, total: true },
    usage: { moneyFrom: 7, moneyTo: 8, total: false },
    excess: { moneyFrom: 8, moneyTo: 99, total: excessRows.length > 0 }
  }[view];

  const excel = () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[current.title], filterText.map(([k, v]) => `${k}: ${v}`), [], current.head, ...current.body]);
    XLSX.utils.book_append_sheet(wb, ws, current.title.slice(0, 28).replace(/[\\/?*[\]:]/g, ''));
    XLSX.writeFile(wb, `${current.title.replace(/[^\w]+/g, '-')}-${to}.xlsx`);
  };
  const pdf = async () => {
    setBusy(true);
    try {
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const startY = drawStandardHeader(doc, co, current.title, filterText);
      const isMoney = (j: number) => j >= pdfShape.moneyFrom && j <= pdfShape.moneyTo;
      // An empty amount reads "-" in the rows; the Total row leaves it blank.
      const fmt = (r: (string | number)[], total = false) =>
        r.map((c, j) => (typeof c === 'number' && isMoney(j) ? pdfMoney(c) : c === '' && isMoney(j) && !total ? '-' : String(c)));
      const body = pdfShape.total ? current.body.slice(0, -1) : current.body;
      const totalRow = pdfShape.total ? current.body[current.body.length - 1] : null;
      const columnStyles: Record<number, any> = current.head[0] === 'SL' ? { 0: { halign: 'center' } } : {};
      current.head.forEach((_, j) => {
        if (isMoney(j)) columnStyles[j] = { halign: 'right' };
      });
      autoTable(doc, {
        ...standardTable(startY),
        head: [current.head],
        body: body.map((r) => fmt(r)),
        foot: totalRow ? [fmt(totalRow, true).map((c, j) => (isMoney(j) ? c : { content: c, styles: { halign: 'left' as const } }))] : undefined,
        styles: { ...standardTable(startY).styles, fontSize: current.head.length > 14 ? 6.3 : 7 },
        columnStyles
      });
      if (view === 'excess') {
        const y = (doc as any).lastAutoTable?.finalY || startY;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(90);
        doc.text('Excess = bill over the official ceiling. Report only - not deducted from salary.', 8, y + 6);
      }
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `${current.title.replace(/[^\w]+/g, '-')}-${to}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy(false);
    }
  };

  const views: { key: View; label: string }[] = [
    { key: 'matrix', label: 'Month by month' },
    { key: 'operator', label: 'Operator-wise' },
    { key: 'usage', label: 'Over / under limit' },
    { key: 'excess', label: 'Excess (deduction)' }
  ];
  const cell = (b: Bill | undefined) =>
    b ? <span className={b.amount > b.limit_amount ? 'text-rose-600 font-semibold' : ''}>{num(b.amount)}</span> : <span className="text-slate-300">—</span>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {views.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${view === v.key ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className={labelCls}>{view === 'excess' ? 'Month' : 'Up to month'}</label>
          <input type="month" className={inputCls} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
        {view !== 'excess' && (
          <div>
            <label className={labelCls}>Months</label>
            <select className={inputCls} value={span} onChange={(e) => setSpan(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 12].map((n) => (
                <option key={n} value={n}>
                  Last {n} months
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Operator</label>
          <select className={inputCls} value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="">All</option>
            {OPERATORS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Department</label>
          <select className={inputCls} value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All</option>
            {departments.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 ml-auto">
          <button type="button" disabled={!data || busy} onClick={pdf} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <FileDown className="w-3.5 h-3.5" /> PDF
          </button>
          <button type="button" disabled={!data} onClick={excel} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!data ? (
        <div className="py-10 flex justify-center">
          <Spinner size={24} />
        </div>
      ) : view === 'matrix' ? (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Employee</th>
                <th className="px-3 py-2 text-left">Mobile</th>
                <th className="px-3 py-2 text-right">Limit</th>
                {months.map((m) => (
                  <th key={m} className="px-2 py-2 text-right whitespace-nowrap">
                    {monthLabel(m, true)}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Avg.</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={months.length + 4} className="px-3 py-8 text-center text-slate-400">
                    No SIMs.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.sim.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">
                    <div className="font-semibold text-slate-800">{r.sim.employee?.name || '—'}</div>
                    <div className="text-[10px] text-slate-400">{[r.sim.employee?.employee_code, r.sim.employee?.department, r.sim.duty_location].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className="font-mono">{r.sim.phone_number}</span> <OperatorBadge op={r.sim.operator} />
                  </td>
                  <td className="px-3 py-1.5 text-right">{num(r.limit)}</td>
                  {months.map((m) => (
                    <td key={m} className="px-2 py-1.5 text-right">
                      {cell(r.bills.get(m))}
                    </td>
                  ))}
                  <td className={`px-3 py-1.5 text-right font-semibold ${r.avg != null && r.avg > r.limit ? 'text-rose-600' : ''}`}>{r.avg == null ? '' : num(Math.round(r.avg))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-400 px-3 py-2">Red = over that month's limit. Average is over the months that have a bill.</p>
        </div>
      ) : view === 'operator' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {opRows.map((o) => (
              <div key={o.op} className="rounded-2xl bg-white border border-slate-200 px-4 py-3">
                <OperatorBadge op={o.op} />
                <div className="text-xl font-bold mt-1">{tk(Math.round(o.avg))}</div>
                <div className="text-[10px] text-slate-500">
                  avg / month · {o.sims} SIMs · limit {tk(Math.round(o.limit))}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {operatorTable.head.map((h, i) => (
                    <th key={i} className={`px-3 py-2 whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {operatorTable.body.map((r, i) => (
                  <tr key={i} className={`border-t border-slate-100 ${i === operatorTable.body.length - 1 ? 'font-bold bg-slate-50' : ''}`}>
                    {r.map((c, j) => (
                      <td key={j} className={`px-3 py-1.5 ${j === 0 ? 'text-left' : 'text-right'}`}>
                        {typeof c === 'number' && j > 1 ? num(c) : c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : view === 'usage' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {BANDS.map((b) => (
              <div key={b.key} className={`rounded-2xl border px-4 py-3 ${b.cls}`}>
                <div className="text-[11px] font-semibold">{b.label}</div>
                <div className="text-2xl font-bold">{usageRows.filter((r) => b.test(r.pct || 0)).length}</div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-left">Mobile</th>
                  <th className="px-3 py-2 text-right">Limit</th>
                  <th className="px-3 py-2 text-right">Avg. bill</th>
                  <th className="px-3 py-2 text-left w-40">Use of limit</th>
                  <th className="px-3 py-2 text-right">Months over</th>
                </tr>
              </thead>
              <tbody>
                {usageRows.map((r) => {
                  const band = BANDS.find((b) => b.test(r.pct || 0))!;
                  return (
                    <tr key={r.sim.id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">
                        <div className="font-semibold text-slate-800">{r.sim.employee?.name || '—'}</div>
                        <div className="text-[10px] text-slate-400">{[r.sim.employee?.designation, r.sim.employee?.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className="font-mono">{r.sim.phone_number}</span> <OperatorBadge op={r.sim.operator} />
                      </td>
                      <td className="px-3 py-1.5 text-right">{num(r.limit)}</td>
                      <td className="px-3 py-1.5 text-right font-semibold">{num(Math.round(r.avg || 0))}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                            <div className={`h-full ${(r.pct || 0) > 100 ? 'bg-rose-500' : (r.pct || 0) >= 80 ? 'bg-amber-500' : (r.pct || 0) >= 50 ? 'bg-teal-500' : 'bg-sky-400'}`} style={{ width: `${Math.min(100, r.pct || 0)}%` }} />
                          </div>
                          <span className={`text-[10px] font-semibold px-1.5 rounded border ${band.cls}`}>{r.pct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {r.overMonths} / {r.amounts.filter((a) => a != null).length}
                      </td>
                    </tr>
                  );
                })}
                {usageRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                      No bills in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="rounded-2xl bg-white border border-slate-200 px-4 py-3">
              <div className="text-[11px] font-semibold text-slate-500">People over the limit</div>
              <div className="text-2xl font-bold text-rose-600">{excessRows.length}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-200 px-4 py-3">
              <div className="text-[11px] font-semibold text-slate-500">Total excess</div>
              <div className="text-2xl font-bold text-rose-600">{tk(Math.round(excessTotal * 100) / 100)}</div>
            </div>
          </div>
          <p className="text-[11px] text-slate-500">Excess = bill over the official ceiling. This is a report only — nothing is cut from salary yet.</p>
          <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-left">Department</th>
                  <th className="px-3 py-2 text-left">Mobile</th>
                  <th className="px-3 py-2 text-right">Official ceiling</th>
                  <th className="px-3 py-2 text-right">{monthLabel(to, true)} bill</th>
                  <th className="px-3 py-2 text-right">Excess</th>
                </tr>
              </thead>
              <tbody>
                {excessRows.map(({ r, b }) => (
                  <tr key={r.sim.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">
                      <div className="font-semibold text-slate-800">{r.sim.employee?.name || '—'}</div>
                      <div className="text-[10px] text-slate-400">{[r.sim.employee?.employee_code, r.sim.employee?.designation].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-1.5 text-slate-600">{r.sim.employee?.department || ''}</td>
                    <td className="px-3 py-1.5 font-mono">{r.sim.phone_number}</td>
                    <td className="px-3 py-1.5 text-right">{num(b!.limit_amount)}</td>
                    <td className="px-3 py-1.5 text-right">{num(b!.amount)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-rose-600">{num(Math.round((b!.amount - b!.limit_amount) * 100) / 100)}</td>
                  </tr>
                ))}
                {excessRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                      Nobody went over the limit in {monthLabel(to)}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
