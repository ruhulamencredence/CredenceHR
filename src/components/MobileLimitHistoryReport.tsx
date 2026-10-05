/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Mobile Bill -> Reports -> Limit changes
// (GET /api/mobile-bill/limit-history; Mobile Bill's "Limit Change History"
// layer): every change to a SIM's limit in a date range — who changed it,
// from what to what, and why (HR edit, employee-type limit, approved request
// for good or for one month, a new SIM). PDF and Excel.

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileDown, FileSpreadsheet, Search } from 'lucide-react';
import { Spinner } from './Spinner';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, pdfMoney, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { inputCls, labelCls, mbApi, monthLabel, num, OperatorBadge } from './MobileBillParts';

interface LimitChangeRow {
  id: number;
  at: string;
  phone_number: string;
  operator: string;
  employee: { name: string; employee_code: string | null; department: string | null; designation: string | null } | null;
  old_limit: number | null;
  new_limit: number | null;
  change: number | null;
  kind: 'added' | 'manual' | 'type' | 'permanent' | 'month' | null;
  for_month: string | null;
  by: string | null;
  note: string;
}

const OPERATORS = ['Grameenphone', 'Robi', 'Airtel', 'Banglalink', 'Teletalk'];
const KIND_LABEL: Record<string, string> = {
  added: 'New SIM',
  manual: 'Changed by HR',
  type: 'Employee type limit',
  permanent: 'Request — from month',
  month: 'Request — one month only'
};
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const when = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
};

export const MobileLimitHistoryReport: React.FC<{ token: string }> = ({ token }) => {
  const now = new Date();
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth() - 5, 1)));
  const [to, setTo] = useState(ymd(now));
  const [operator, setOperator] = useState('');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<LimitChangeRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRows(null);
    setError('');
    mbApi<{ rows: LimitChangeRow[] }>(token, `/api/mobile-bill/limit-history?from=${from}&to=${to}`)
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e.message));
  }, [token, from, to]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        (!operator || r.operator === operator) &&
        (!kind || r.kind === kind) &&
        (!q || `${r.phone_number} ${r.employee?.name || ''} ${r.employee?.employee_code || ''} ${r.by || ''}`.toLowerCase().includes(q))
    );
  }, [rows, operator, kind, search]);

  const kindText = (r: LimitChangeRow) => `${KIND_LABEL[r.kind || ''] || ''}${r.for_month ? ` (${monthLabel(r.for_month)})` : ''}`;
  const head = ['SL', 'Date & time', 'Mobile Number', 'Operator', 'Employee', 'Emp. ID', 'Department', 'Old limit', 'New limit', 'Change', 'Type', 'Changed by'];
  const body = shown.map((r, i) => [
    i + 1,
    when(r.at),
    r.phone_number,
    r.operator,
    r.employee?.name || '—',
    r.employee?.employee_code || '',
    r.employee?.department || '',
    r.old_limit ?? '',
    r.new_limit ?? '',
    r.change ?? '',
    kindText(r),
    r.by || ''
  ]);
  const filterText: [string, string][] = [
    ['Period', `${from} to ${to}`],
    ['Operator', operator || 'All'],
    ...(kind ? ([['Type', KIND_LABEL[kind]]] as [string, string][]) : []),
    ['Changes', String(shown.length)]
  ];
  const title = 'Mobile Limit Change History';

  const excel = () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[title], filterText.map(([k, v]) => `${k}: ${v}`), [], head, ...body]);
    ws['!cols'] = [6, 20, 15, 13, 24, 12, 22, 11, 11, 10, 26, 20].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, 'Limit Changes');
    XLSX.writeFile(wb, `Mobile-Limit-Changes-${from}-to-${to}.xlsx`);
  };
  const pdf = async () => {
    setBusy(true);
    try {
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const startY = drawStandardHeader(doc, co, title, filterText);
      const money = (v: number | string, signed = false) =>
        v === '' ? '-' : signed && Number(v) > 0 ? `+${pdfMoney(Number(v))}` : pdfMoney(Number(v));
      autoTable(doc, {
        ...standardTable(startY),
        head: [head],
        body: body.map((r) => r.map((c, j) => (j >= 7 && j <= 9 ? money(c as any, j === 9) : String(c)))),
        styles: { ...standardTable(startY).styles, fontSize: 7 },
        columnStyles: { 0: { halign: 'center', cellWidth: 9 }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'right' } }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Mobile-Limit-Changes-${from}-to-${to}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className={labelCls}>From</label>
          <input type="date" className={inputCls} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>To</label>
          <input type="date" className={inputCls} value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
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
          <label className={labelCls}>Type</label>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="relative">
          <label className={labelCls}>Search</label>
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 bottom-2.5" />
          <input className={`${inputCls} pl-8`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, name, ID…" />
        </div>
        <div className="flex gap-2 ml-auto">
          <button type="button" disabled={!rows || busy} onClick={pdf} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <FileDown className="w-3.5 h-3.5" /> PDF
          </button>
          <button type="button" disabled={!rows} onClick={excel} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!rows ? (
        !error && (
          <div className="py-10 flex justify-center">
            <Spinner size={24} />
          </div>
        )
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Mobile</th>
                <th className="px-3 py-2 text-left">Employee</th>
                <th className="px-3 py-2 text-right">Old</th>
                <th className="px-3 py-2 text-right">New</th>
                <th className="px-3 py-2 text-right">Change</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                    No limit changes in this period.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 align-top" title={r.note}>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{when(r.at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="font-medium text-slate-800">{r.phone_number}</div>
                    <OperatorBadge op={r.operator} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{r.employee?.name || '—'}</div>
                    <div className="text-[11px] text-slate-500">{[r.employee?.employee_code, r.employee?.department].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">{r.old_limit == null ? '—' : num(r.old_limit)}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{r.new_limit == null ? '—' : num(r.new_limit)}</td>
                  <td
                    className={`px-3 py-2 text-right font-semibold ${
                      r.change == null ? 'text-slate-300' : r.change > 0 ? 'text-rose-600' : r.change < 0 ? 'text-emerald-600' : 'text-slate-500'
                    }`}
                  >
                    {r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${num(r.change)}`}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{kindText(r)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{r.by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
