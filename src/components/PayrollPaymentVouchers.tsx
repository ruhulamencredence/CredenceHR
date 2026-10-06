/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval -> "Payment vouchers": the month's net salaries grouped by
// WHERE they are paid — each Bank, and each MFS (bKash / Nagad / Rocket…) —
// from the Bank/MFS split every salary row snapshotted when it was generated
// (Admin Panel -> Employees -> Payment). The software does not send money:
// Accounts takes one voucher to that bank / MFS, pays from the bank's or the
// MFS's own app, then confirms here with Pay. One Excel and one printable PDF
// per Bank / MFS, or all of them together.

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { FileSpreadsheet, Landmark, Printer, Smartphone } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, pdfMoney, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';

interface SheetRow {
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  designation: string | null;
  net_salary: number;
  status: string;
  account_type: '' | 'Bank' | 'MFS';
  bank: string;
  branch: string;
  account_number: string;
  amount: number;
}

interface Group {
  key: string;
  kind: 'Bank' | 'MFS' | 'None';
  name: string;
  title: string;
  rows: SheetRow[];
  total: number;
}

const tk = (n: number) => `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const KIND_ORDER = { Bank: 0, MFS: 1, None: 2 } as const;

function buildGroups(rows: SheetRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    if (r.status === 'held') continue; // held salaries are not paid this run
    const kind = r.account_type === 'MFS' ? 'MFS' : r.account_type === 'Bank' ? 'Bank' : 'None';
    const name = kind === 'None' ? 'No Bank / MFS set up' : r.bank || (kind === 'MFS' ? 'MFS' : 'Bank');
    const key = `${kind}|${name}`;
    if (!map.has(key)) {
      map.set(key, { key, kind, name, title: kind === 'None' ? name : `${kind === 'MFS' ? 'MFS' : 'Bank'} — ${name}`, rows: [], total: 0 });
    }
    const g = map.get(key)!;
    g.rows.push(r);
    g.total += Number(r.amount) || 0;
  }
  return [...map.values()]
    .map((g) => ({ ...g, total: Math.round(g.total * 100) / 100, rows: [...g.rows].sort((a, b) => String(a.employee_code || '').localeCompare(String(b.employee_code || ''), undefined, { numeric: true })) }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

const safe = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'Voucher';
const voucherNo = (month: string, i: number) => `SAL-${month}-${String(i + 1).padStart(2, '0')}`;
const sheetRows = (g: Group) =>
  g.rows.map((r, i) => [i + 1, r.employee_code || '', r.employee_name, r.department || '', r.designation || '', g.kind === 'Bank' ? r.branch || '' : '', r.account_number || '', Number(r.amount) || 0]);
const HEAD = ['SL', 'Employee ID', 'Name', 'Department', 'Designation', 'Branch', 'Account / Wallet No', 'Amount'];

export const PayrollPaymentVouchers: React.FC<{ token: string; month: string; paid: boolean }> = ({ token, month, paid }) => {
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setRows(null);
    setError('');
    fetch(apiUrl(`/api/payroll/approval/${month}/payment-sheet`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the payment sheet.');
        setRows(d.rows || []);
      })
      .catch((e) => setError(e.message));
  }, [token, month]);

  const groups = useMemo(() => (rows ? buildGroups(rows) : []), [rows]);
  const grand = groups.reduce((n, g) => n + g.total, 0);

  const excelFor = (list: Group[], all: boolean) => {
    const wb = XLSX.utils.book_new();
    const sheetName = (g: Group, used: Set<string>) => {
      let n = g.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28);
      while (used.has(n)) n = `${n.slice(0, 26)}_${used.size}`;
      used.add(n);
      return n;
    };
    const used = new Set<string>();
    if (all) {
      const summary = XLSX.utils.aoa_to_sheet([
        [`Salary Payment Vouchers — ${month}`],
        [],
        ['Voucher No', 'Pay through', 'Employees', 'Amount'],
        ...groups.map((g, i) => [voucherNo(month, i), g.title, g.rows.length, g.total]),
        ['', 'Total', groups.reduce((n, g) => n + g.rows.length, 0), Math.round(grand * 100) / 100]
      ]);
      summary['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 11 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, summary, 'Summary');
      used.add('Summary');
    }
    for (const g of list) {
      const i = groups.indexOf(g);
      const ws = XLSX.utils.aoa_to_sheet([
        [`Salary Payment Voucher — ${g.title}`],
        [`Voucher No: ${voucherNo(month, i)}   Salary month: ${month}   Employees: ${g.rows.length}`],
        [],
        HEAD,
        ...sheetRows(g),
        ['', '', '', '', '', '', 'Total', g.total]
      ]);
      ws['!cols'] = [5, 12, 24, 18, 18, 18, 22, 14].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, sheetName(g, used));
    }
    XLSX.writeFile(wb, all ? `Salary-Vouchers-${month}.xlsx` : `Salary-Voucher-${month}-${safe(list[0].title)}.xlsx`);
  };

  const pdfFor = async (list: Group[], all: boolean) => {
    setBusy(all ? 'all' : list[0].key);
    try {
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const left = { halign: 'left' as const };
      list.forEach((g, n) => {
        if (n > 0) doc.addPage();
        const i = groups.indexOf(g);
        const y0 = drawStandardHeader(doc, co, 'Salary Payment Voucher', [
          ['Voucher No', voucherNo(month, i)],
          ['Salary month', month],
          ['Pay through', g.title],
          ['Employees', String(g.rows.length)],
          ['Total amount', `Tk ${pdfMoney(g.total)}`]
        ]);
        autoTable(doc, {
          ...standardTable(y0 + 2),
          head: [['SL', 'ID', 'Name', 'Department', ...(g.kind === 'Bank' ? ['Branch'] : []), g.kind === 'MFS' ? 'Wallet No' : 'Account No', 'Amount']],
          body: g.rows.map((r, k) => [String(k + 1), r.employee_code || '', r.employee_name, r.department || '', ...(g.kind === 'Bank' ? [r.branch || ''] : []), r.account_number || '-', pdfMoney(r.amount)]),
          foot: [[{ content: `Total (${g.rows.length})`, colSpan: g.kind === 'Bank' ? 6 : 5, styles: left }, pdfMoney(g.total)]],
          columnStyles: { 0: { cellWidth: 9, halign: 'center' }, [g.kind === 'Bank' ? 6 : 5]: { cellWidth: 26, halign: 'right' } }
        });
        let y = (doc as any).lastAutoTable.finalY + 14;
        if (y > pageHeight - 36) {
          doc.addPage();
          y = 30;
        }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(40, 40, 40);
        const slots = ['Prepared by (HR)', 'Audit', 'Accounts', 'Approved by'];
        const w = (pageWidth - 16) / slots.length;
        slots.forEach((label, k) => {
          const x = 8 + k * w;
          doc.line(x + 3, y, x + w - 3, y);
          doc.text(label, x + w / 2, y + 4, { align: 'center' });
        });
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, all ? `Salary-Vouchers-${month}.pdf` : `Salary-Voucher-${month}-${safe(list[0].title)}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-bold text-slate-700">Payment vouchers — Bank &amp; MFS wise</div>
          <p className="text-[11px] text-slate-500 mt-0.5 max-w-xl">
            This software does not send the money. Take each voucher to that bank or MFS, pay from its own app, then press <b>Pay (Accounts)</b> here to confirm
            {paid ? ' (this month is already confirmed paid).' : '.'} Salaries on hold are left out.
          </p>
        </div>
        {groups.length > 1 && (
          <div className="flex gap-2">
            <button type="button" onClick={() => excelFor(groups, true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> All (Excel)
            </button>
            <button type="button" disabled={busy === 'all'} onClick={() => pdfFor(groups, true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Printer className="w-3.5 h-3.5" /> All (PDF)
            </button>
          </div>
        )}
      </div>
      {error && <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!rows && !error ? (
        <div className="py-8 flex justify-center">
          <Spinner size={20} />
        </div>
      ) : groups.length === 0 ? (
        <p className="text-xs text-slate-400 mt-3">Nothing to pay for this month.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {groups.map((g) => (
              <div key={g.key} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-start gap-2">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${g.kind === 'MFS' ? 'bg-pink-50 text-pink-600' : g.kind === 'Bank' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
                    {g.kind === 'MFS' ? <Smartphone className="w-4 h-4" /> : <Landmark className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-slate-800 truncate" title={g.title}>
                      {g.title}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {g.rows.length} employee{g.rows.length === 1 ? '' : 's'} · <b className="text-slate-800">{tk(g.total)}</b>
                    </div>
                    {g.kind === 'None' && <div className="text-[10px] text-amber-700 mt-0.5">No account set in Employees → Payment; paid by the single method chosen in Run Payroll.</div>}
                  </div>
                </div>
                <div className="flex gap-2 mt-2.5">
                  <button type="button" onClick={() => excelFor([g], false)} className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                    <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
                  </button>
                  <button type="button" disabled={busy === g.key} onClick={() => pdfFor([g], false)} className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                    <Printer className="w-3.5 h-3.5" /> {busy === g.key ? 'Making…' : 'PDF / Print'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-500 text-right">
            Total to pay: <b className="text-slate-800">{tk(grand)}</b>
          </div>
        </>
      )}
    </div>
  );
};
