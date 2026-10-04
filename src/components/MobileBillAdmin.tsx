/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HRM -> Mobile Bill (module "mobile_bill", MobileBillRoutes.ts):
//   Bills     — one month: import the operator's bill (number + amount), see
//               what the company pays up to each limit and the excess, print /
//               Excel the payment sheet, mark the month paid.
//   SIMs      — every company SIM, who holds it, its limit; add, import HR's
//               own list (with past months' usage), edit, history.
//   Limits    — the monthly limit per employee type.
//   Requests  — employees' requests for a higher limit.
//   Reports   — MobileBillReports.tsx.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { BarChart3, CheckCircle2, FileDown, FileSpreadsheet, Inbox, Pencil, Plus, Receipt, Search, Smartphone, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import {
  fmtDate,
  findHeaderRow,
  guessColumn,
  filterCls,
  inputCls,
  labelCls,
  MbEmployee,
  MbPolicy,
  MbRequest,
  MbSim,
  mbApi,
  Modal,
  monthLabel,
  num,
  OperatorBadge,
  parseMonthHeader,
  requestStage,
  StatusPill,
  thisMonth,
  tk
} from './MobileBillParts';
import { MobileBillReports } from './MobileBillReports';

type Tab = 'bills' | 'sims' | 'limits' | 'requests' | 'reports';
const OPERATORS = ['Grameenphone', 'Robi', 'Airtel', 'Banglalink', 'Teletalk'];

export const MobileBillAdmin: React.FC<{ token: string }> = ({ token }) => {
  const [tab, setTab] = useState<Tab>('bills');
  const [pending, setPending] = useState(0);
  const refreshPending = useCallback(() => {
    mbApi<MbRequest[]>(token, '/api/mobile-bill/requests')
      .then((rs) => setPending(rs.filter((r) => r.status === 'pending').length))
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }[] = [
    { key: 'bills', label: 'Monthly Bills', icon: Receipt },
    { key: 'sims', label: 'SIMs', icon: Smartphone },
    { key: 'limits', label: 'Limits', icon: SlidersHorizontal },
    { key: 'requests', label: 'Limit Requests', icon: Inbox, count: pending },
    { key: 'reports', label: 'Reports', icon: BarChart3 }
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
        <Smartphone className="w-5 h-5 text-teal-600" /> Mobile Bill
      </h2>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold ${tab === t.key ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
            {!!t.count && <span className={`px-1.5 rounded-full ${tab === t.key ? 'bg-white/25' : 'bg-amber-100 text-amber-700'}`}>{t.count}</span>}
          </button>
        ))}
      </div>
      {tab === 'bills' && <BillsTab token={token} />}
      {tab === 'sims' && <SimsTab token={token} />}
      {tab === 'limits' && <LimitsTab token={token} />}
      {tab === 'requests' && <RequestsTab token={token} onChange={refreshPending} />}
      {tab === 'reports' && <MobileBillReports token={token} />}
    </div>
  );
};

const Card: React.FC<{ label: string; value: string; cls?: string }> = ({ label, value, cls }) => (
  <div className="rounded-2xl bg-white border border-slate-200 px-4 py-3">
    <div className="text-[11px] font-semibold text-slate-500">{label}</div>
    <div className={`text-xl font-bold ${cls || 'text-slate-900'}`}>{value}</div>
  </div>
);

const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold';
const btnLight = `${btn} bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50`;
const btnMain = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50`;

// ============================================================================
// Monthly Bills
// ============================================================================
interface BillRow {
  sim_id: number;
  bill_id: number | null;
  phone_number: string;
  operator: string;
  employee: MbEmployee | null;
  duty_location: string | null;
  limit_amount: number;
  amount: number | null;
  payable: number | null;
  excess: number | null;
  paid_at: string | null;
}

const BillsTab: React.FC<{ token: string }> = ({ token }) => {
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [operator, setOperator] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<BillRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setRows(null);
    mbApi<{ rows: BillRow[] }>(token, `/api/mobile-bill/bills?month=${month}`)
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e.message));
  }, [token, month]);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        (!operator || r.operator === operator) &&
        (!s || [r.phone_number, r.employee?.name, r.employee?.employee_code, r.employee?.department, r.duty_location].some((v) => String(v || '').toLowerCase().includes(s)))
    );
  }, [rows, operator, q]);
  const billed = shown.filter((r) => r.amount != null);
  const sum = (k: 'amount' | 'payable' | 'excess') => billed.reduce((a, r) => a + Number(r[k] || 0), 0);
  const unpaid = billed.filter((r) => !r.paid_at).length;

  const markPaid = async (paid: boolean) => {
    const what = operator ? `${operator} bills` : 'all bills';
    if (!window.confirm(paid ? `Mark ${what} of ${monthLabel(month)} as paid?` : `Undo "paid" for ${what} of ${monthLabel(month)}?`)) return;
    setBusy(true);
    try {
      await mbApi(token, '/api/mobile-bill/bills/mark-paid', 'POST', { month, operator: operator || null, paid });
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sheetRows = billed.map((r, i) => ({
    SL: i + 1,
    Name: r.employee?.name || '',
    'Emp. ID': r.employee?.employee_code || '',
    Designation: r.employee?.designation || '',
    Department: r.employee?.department || '',
    'Work Station': r.employee?.work_station || '',
    'Duty Location': r.duty_location || '',
    'Mobile Number': r.phone_number,
    Operator: r.operator,
    'Official Ceiling': r.limit_amount,
    [`${monthLabel(month, true)} Bill`]: r.amount,
    'Company Pays': r.payable,
    'Excess Amount': r.excess
  }));

  const excel = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows.length ? sheetRows : [{ Note: 'No bills this month' }]), 'Payment Sheet');
    const over = sheetRows.filter((r) => Number(r['Excess Amount']) > 0).map((r, i) => ({ ...r, SL: i + 1 }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(over.length ? over : [{ Note: 'Nobody went over the limit' }]), 'Excess Limit Users');
    XLSX.writeFile(wb, `Mobile-Bill-${month}${operator ? `-${operator}` : ''}.xlsx`);
  };

  const pdf = async () => {
    setBusy(true);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const opts = {
        reportTitle: 'Mobile Bill Payment Sheet',
        filters: [
          ['Month', monthLabel(month)],
          ['Operator', operator || 'All'],
          ['Numbers', String(billed.length)],
          // The PDF font has no ৳ — "Tk" there.
          ['Total bill', `Tk ${num(sum('amount'))}`],
          ['Company pays', `Tk ${num(sum('payable'))}`],
          ['Excess', `Tk ${num(sum('excess'))}`]
        ] as [string, string][]
      };
      const startY = drawPdfLetterhead(doc, logoImg, opts);
      autoTable(doc, {
        startY,
        margin: { top: startY, left: 8, right: 8 },
        head: [['SL', 'Name', 'Emp. ID', 'Designation', 'Department', 'Duty Location', 'Mobile', 'Operator', 'Ceiling', 'Bill', 'Company Pays', 'Excess']],
        body: billed.map((r, i) => [
          String(i + 1),
          r.employee?.name || '—',
          r.employee?.employee_code || '',
          r.employee?.designation || '',
          r.employee?.department || '',
          r.duty_location || '',
          r.phone_number,
          r.operator,
          num(r.limit_amount),
          num(r.amount),
          num(r.payable),
          r.excess ? num(r.excess) : '—'
        ]),
        foot: [['', 'Total', '', '', '', '', '', '', '', num(sum('amount')), num(sum('payable')), num(sum('excess'))]],
        styles: { fontSize: 7.5, cellPadding: 1.4 },
        headStyles: { fillColor: [13, 148, 136], textColor: 255, fontSize: 7.5 },
        footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' },
        columnStyles: { 8: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' }, 11: { halign: 'right' } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didDrawPage: () => {
          drawPdfLetterhead(doc, logoImg, opts);
        }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Mobile-Bill-${month}${operator ? `-${operator}` : ''}.pdf`);
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
          <label className={labelCls}>Bill month</label>
          <input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Operator</label>
          <select className={inputCls} value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="">All operators</option>
            {OPERATORS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[180px] relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input className={`${inputCls} pl-9`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number, department…" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnMain} onClick={() => setImporting(true)}>
          <Upload className="w-3.5 h-3.5" /> Import bill
        </button>
        <button type="button" className={btnLight} disabled={!billed.length || busy} onClick={pdf}>
          <FileDown className="w-3.5 h-3.5" /> Payment sheet PDF
        </button>
        <button type="button" className={btnLight} disabled={!billed.length} onClick={excel}>
          <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
        </button>
        {unpaid > 0 ? (
          <button type="button" className={btnLight} disabled={busy} onClick={() => markPaid(true)}>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Mark {operator || 'all'} paid
          </button>
        ) : (
          billed.length > 0 && (
            <button type="button" className={btnLight} disabled={busy} onClick={() => markPaid(false)}>
              Undo paid
            </button>
          )
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Card label="Numbers billed" value={rows ? `${billed.length} / ${shown.length}` : '–'} />
        <Card label="Total bill" value={rows ? tk(sum('amount')) : '–'} />
        <Card label="Company pays" value={rows ? tk(sum('payable')) : '–'} cls="text-teal-700" />
        <Card label="Excess (over limit)" value={rows ? tk(sum('excess')) : '–'} cls="text-rose-600" />
        <Card label="Unpaid" value={rows ? String(unpaid) : '–'} cls={unpaid ? 'text-amber-600' : 'text-emerald-700'} />
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!rows ? (
        <div className="py-10 flex justify-center">
          <Spinner size={24} />
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {['Employee', 'Department', 'Duty location', 'Mobile', 'Limit', 'Bill', 'Company pays', 'Excess', ''].map((h, i) => (
                  <th key={h + i} className={`px-3 py-2 font-semibold whitespace-nowrap ${i >= 4 && i <= 7 ? 'text-right' : 'text-left'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-slate-400">
                    No SIMs yet — add them under SIMs.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.sim_id} className="border-t border-slate-100 hover:bg-slate-50/60">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-800">{r.employee?.name || <span className="text-slate-400">Not given</span>}</div>
                    <div className="text-[10px] text-slate-400">{[r.employee?.employee_code, r.employee?.designation].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.employee?.department || ''}</td>
                  <td className="px-3 py-2 text-slate-600">{r.duty_location || ''}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="font-mono">{r.phone_number}</div>
                    <OperatorBadge op={r.operator} />
                  </td>
                  <td className="px-3 py-2 text-right">{tk(r.limit_amount)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{r.amount == null ? <span className="text-slate-300">—</span> : tk(r.amount)}</td>
                  <td className="px-3 py-2 text-right text-teal-700">{r.payable == null ? '' : tk(r.payable)}</td>
                  <td className={`px-3 py-2 text-right ${r.excess ? 'text-rose-600 font-semibold' : 'text-slate-300'}`}>{r.excess ? tk(r.excess) : r.amount == null ? '' : '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.paid_at ? (
                      <span className="text-[10px] font-semibold text-emerald-700">Paid</span>
                    ) : (
                      <button type="button" onClick={() => setEditing(r)} className="p-1 rounded-lg hover:bg-slate-100" title="Enter / change the bill">
                        <Pencil className="w-3.5 h-3.5 text-slate-400" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {importing && (
        <ImportBillModal
          token={token}
          month={month}
          onClose={() => setImporting(false)}
          onDone={(m) => {
            setImporting(false);
            if (m !== month) setMonth(m);
            else load();
          }}
        />
      )}
      {editing && (
        <EditBillModal
          token={token}
          month={month}
          row={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
};

const EditBillModal: React.FC<{ token: string; month: string; row: BillRow; onClose: () => void; onDone: () => void }> = ({ token, month, row, onClose, onDone }) => {
  const [amount, setAmount] = useState(row.amount == null ? '' : String(row.amount));
  const [error, setError] = useState('');
  const save = async (clear = false) => {
    try {
      await mbApi(token, '/api/mobile-bill/bills', 'PUT', { month, sim_id: row.sim_id, amount: clear ? null : amount });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Modal title={`${row.phone_number} — ${monthLabel(month)}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          {row.employee?.name || 'Not given to anyone'} · limit {tk(row.limit_amount)}
        </p>
        <div>
          <label className={labelCls}>Bill amount (৳)</label>
          <input type="number" min={0} className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </div>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-between gap-2">
          {row.amount != null ? (
            <button type="button" onClick={() => save(true)} className="text-xs font-semibold text-rose-600 hover:underline">
              Remove this bill
            </button>
          ) : (
            <span />
          )}
          <button type="button" className={btnMain} disabled={amount === ''} onClick={() => save()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};

// Reads the first sheet of an Excel/CSV file into rows (array of arrays).
async function readSheet(file: File): Promise<{ sheets: string[]; read: (name: string) => any[][] }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return {
    sheets: wb.SheetNames,
    read: (name: string) => XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false })
  };
}

const PHONE_HEAD = /mobile|msisdn|number|phone|cell|sim/i;

interface CheckResult {
  total: number;
  ok: number;
  failed: number;
  amount?: number;
  rows: { row: number; phone_number: string; amount?: number | null; employee_name?: string | null; operator?: string | null; limit_amount?: number | null; errors: string[]; warnings?: string[] }[];
}

const ImportBillModal: React.FC<{ token: string; month: string; onClose: () => void; onDone: (month: string) => void }> = ({ token, month: startMonth, onClose, onDone }) => {
  const [book, setBook] = useState<Awaited<ReturnType<typeof readSheet>> | null>(null);
  const [sheet, setSheet] = useState('');
  const [month, setMonth] = useState(startMonth);
  const [operator, setOperator] = useState('');
  const [replace, setReplace] = useState(false);
  const [phoneCol, setPhoneCol] = useState(-1);
  const [amountCol, setAmountCol] = useState(-1);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const grid = useMemo(() => (book && sheet ? book.read(sheet) : []), [book, sheet]);
  const headerIdx = useMemo(() => findHeaderRow(grid, PHONE_HEAD), [grid]);
  const headers = useMemo(() => (grid[headerIdx] || []).map((h: any, i: number) => String(h || '').trim() || `Column ${i + 1}`), [grid, headerIdx]);
  useEffect(() => {
    setPhoneCol(guessColumn(headers, /msisdn|mobile|phone|number|cell/i));
    setAmountCol(guessColumn(headers, /total|amount|bill|payable|usage|charge|taka|tk/i));
    setCheck(null);
  }, [headers]);

  const rows = useMemo(
    () =>
      phoneCol < 0 || amountCol < 0
        ? []
        : grid
            .slice(headerIdx + 1)
            .filter((r) => String(r[phoneCol] ?? '').trim())
            .map((r) => ({ phone_number: r[phoneCol], amount: r[amountCol] })),
    [grid, headerIdx, phoneCol, amountCol]
  );

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError('');
    try {
      const b = await readSheet(f);
      setBook(b);
      setSheet(b.sheets[0]);
    } catch {
      setError('Could not read that file — use an Excel (.xlsx / .xls) or CSV file.');
    }
  };
  const run = async (dry: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await mbApi<CheckResult>(token, '/api/mobile-bill/bills/import', 'POST', { month, operator: operator || null, replace, rows, dry_run: dry });
      if (dry) setCheck(r);
      else onDone(month);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import the operator's bill" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          The file the operator sends — one row per number with its bill amount. Numbers must already be in the SIM list.
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Bill month</label>
            <input type="month" className={inputCls} value={month} onChange={(e) => (setMonth(e.target.value), setCheck(null))} />
          </div>
          <div>
            <label className={labelCls}>Operator (checks every number)</label>
            <select className={inputCls} value={operator} onChange={(e) => (setOperator(e.target.value), setCheck(null))}>
              <option value="">Any</option>
              {OPERATORS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>File</label>
            <input type="file" accept=".xlsx,.xls,.csv" className="text-xs" onChange={(e) => pick(e.target.files?.[0])} />
          </div>
        </div>
        {book && (
          <div className="grid sm:grid-cols-3 gap-3">
            {book.sheets.length > 1 && (
              <div>
                <label className={labelCls}>Sheet</label>
                <select className={inputCls} value={sheet} onChange={(e) => setSheet(e.target.value)}>
                  {book.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelCls}>Mobile number column</label>
              <select className={inputCls} value={phoneCol} onChange={(e) => (setPhoneCol(Number(e.target.value)), setCheck(null))}>
                <option value={-1}>Pick…</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Amount column</label>
              <select className={inputCls} value={amountCol} onChange={(e) => (setAmountCol(Number(e.target.value)), setCheck(null))}>
                <option value={-1}>Pick…</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={replace} onChange={(e) => (setReplace(e.target.checked), setCheck(null))} /> Replace bills already imported for this month
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        {check && <CheckTable check={check} showAmount />}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnLight} disabled={busy || !rows.length} onClick={() => run(true)}>
            Check {rows.length ? `${rows.length} rows` : ''}
          </button>
          <button type="button" className={btnMain} disabled={busy || !check || !check.ok} onClick={() => run(false)}>
            {busy ? 'Working…' : check ? `Import ${check.ok} bills (${tk(check.amount || 0)})` : 'Import'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

const CheckTable: React.FC<{ check: CheckResult; showAmount?: boolean }> = ({ check, showAmount }) => (
  <div>
    <p className="text-xs font-semibold mb-1">
      <span className="text-emerald-700">{check.ok} ready</span>
      {check.failed > 0 && <span className="text-rose-600"> · {check.failed} with problems (left out)</span>}
    </p>
    <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200">
      <table className="w-full text-[11px]">
        <thead className="bg-slate-50 text-slate-500 sticky top-0">
          <tr>
            <th className="px-2 py-1 text-left">Row</th>
            <th className="px-2 py-1 text-left">Number</th>
            <th className="px-2 py-1 text-left">Employee</th>
            {showAmount && <th className="px-2 py-1 text-right">Amount</th>}
            <th className="px-2 py-1 text-right">Limit</th>
            <th className="px-2 py-1 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {[...check.rows].sort((a, b) => b.errors.length - a.errors.length).map((r) => (
            <tr key={r.row} className={`border-t border-slate-100 ${r.errors.length ? 'bg-rose-50/50' : ''}`}>
              <td className="px-2 py-1">{r.row}</td>
              <td className="px-2 py-1 font-mono">{r.phone_number}</td>
              <td className="px-2 py-1">{r.employee_name || ''}</td>
              {showAmount && <td className="px-2 py-1 text-right">{r.amount == null ? '' : num(r.amount)}</td>}
              <td className="px-2 py-1 text-right">{r.limit_amount == null ? '' : num(r.limit_amount)}</td>
              <td className="px-2 py-1">
                {r.errors.length ? <span className="text-rose-600">{r.errors.join('; ')}</span> : <span className="text-emerald-700">OK{r.warnings?.length ? ` — ${r.warnings.join('; ')}` : ''}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

// ============================================================================
// SIMs
// ============================================================================
interface Meta {
  operators: string[];
  employees: MbEmployee[];
  employee_types: string[];
  policies: MbPolicy[];
}

const SimsTab: React.FC<{ token: string }> = ({ token }) => {
  const [sims, setSims] = useState<MbSim[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [q, setQ] = useState('');
  const [operator, setOperator] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'unassigned' | ''>('active');
  const [editing, setEditing] = useState<MbSim | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    mbApi<MbSim[]>(token, '/api/mobile-bill/sims')
      .then(setSims)
      .catch((e) => setError(e.message));
    mbApi<Meta>(token, '/api/mobile-bill/meta')
      .then(setMeta)
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (sims || []).filter(
      (x) =>
        (!operator || x.operator === operator) &&
        (!status || (status === 'unassigned' ? !x.employee_id && x.status === 'active' : x.status === status)) &&
        (!s || [x.phone_number, x.employee?.name, x.employee?.employee_code, x.employee?.department, x.duty_location].some((v) => String(v || '').toLowerCase().includes(s)))
    );
  }, [sims, q, operator, status]);
  const active = (sims || []).filter((s) => s.status === 'active');
  const holders = new Set(active.filter((s) => s.employee_id).map((s) => s.employee_id));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card label="Active SIMs" value={sims ? String(active.length) : '–'} />
        <Card label="Employees holding SIMs" value={sims ? String(holders.size) : '–'} />
        <Card label="Not given to anyone" value={sims ? String(active.filter((s) => !s.employee_id).length) : '–'} cls="text-amber-600" />
        <Card label="Total monthly limit" value={sims ? tk(active.reduce((a, s) => a + s.limit_amount, 0)) : '–'} cls="text-teal-700" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[180px] relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input className={`${inputCls} pl-9`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number, Emp. ID…" />
        </div>
        <select className={filterCls} value={operator} onChange={(e) => setOperator(e.target.value)}>
          <option value="">All operators</option>
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <select className={filterCls} value={status} onChange={(e) => setStatus(e.target.value as any)}>
          <option value="active">Active</option>
          <option value="unassigned">Not given to anyone</option>
          <option value="inactive">Turned off</option>
          <option value="">All</option>
        </select>
        <button type="button" className={btnLight} onClick={() => setImporting(true)}>
          <Upload className="w-3.5 h-3.5" /> Import list
        </button>
        <button type="button" className={btnMain} onClick={() => setEditing('new')}>
          <Plus className="w-3.5 h-3.5" /> Give a SIM
        </button>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!sims ? (
        <div className="py-10 flex justify-center">
          <Spinner size={24} />
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {['Mobile', 'Employee', 'Department / Work station', 'Duty location', 'Limit', 'Last bill', ''].map((h, i) => (
                  <th key={i} className={`px-3 py-2 font-semibold whitespace-nowrap ${i === 4 || i === 5 ? 'text-right' : 'text-left'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    No SIMs here.
                  </td>
                </tr>
              )}
              {shown.map((s) => (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50/60 cursor-pointer" onClick={() => setEditing(s)}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="font-mono font-semibold">{s.phone_number}</div>
                    <OperatorBadge op={s.operator} />
                    {s.status !== 'active' && <span className="ml-1 text-[10px] text-slate-400">off</span>}
                  </td>
                  <td className="px-3 py-2">
                    {s.employee ? (
                      <>
                        <div className="font-semibold text-slate-800">{s.employee.name}</div>
                        <div className="text-[10px] text-slate-400">{[s.employee.employee_code, s.employee.designation].filter(Boolean).join(' · ')}</div>
                      </>
                    ) : (
                      <span className="text-amber-600">Not given</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{[s.employee?.department, s.employee?.work_station].filter(Boolean).join(' / ')}</td>
                  <td className="px-3 py-2 text-slate-600">{s.duty_location || ''}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <div className="font-semibold">{tk(s.limit_amount)}</div>
                    <div className="text-[10px] text-slate-400">{s.limit_source === 'type' ? `type${s.employee?.employee_type ? `: ${s.employee.employee_type}` : ' (default)'}` : 'custom'}</div>
                  </td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap ${s.last_bill && s.last_bill.amount > s.last_bill.limit_amount ? 'text-rose-600' : ''}`}>
                    {s.last_bill ? (
                      <>
                        <div className="font-semibold">{tk(s.last_bill.amount)}</div>
                        <div className="text-[10px] text-slate-400">{monthLabel(s.last_bill.month, true)}</div>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s.pending_requests > 0 && <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">request</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && meta && (
        <SimModal
          token={token}
          meta={meta}
          sim={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {importing && (
        <ImportSimsModal
          token={token}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
    </div>
  );
};

interface SimDetail extends MbSim {
  events: { id: number; action: string; message: string; actor_name: string | null; created_at: string }[];
  bills: { id: number; month: string; amount: number; limit_amount: number; paid_at: string | null }[];
  requests: MbRequest[];
}

const SimModal: React.FC<{ token: string; meta: Meta; sim: MbSim | null; onClose: () => void; onDone: () => void }> = ({ token, meta, sim, onClose, onDone }) => {
  const [f, setF] = useState({
    phone_number: sim?.phone_number || '',
    operator: sim?.operator || '',
    employee_id: sim?.employee_id ? String(sim.employee_id) : '',
    duty_location: sim?.duty_location || '',
    limit_source: sim?.limit_source || 'type',
    limit_amount: sim ? String(sim.limit_amount) : '',
    package_name: sim?.package_name || '',
    issued_on: sim?.issued_on || '',
    status: sim?.status || 'active',
    note: sim?.note || ''
  });
  const [empQ, setEmpQ] = useState('');
  const [detail, setDetail] = useState<SimDetail | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  useEffect(() => {
    if (sim) mbApi<SimDetail>(token, `/api/mobile-bill/sims/${sim.id}`).then(setDetail).catch(() => {});
  }, [token, sim]);

  const emp = meta.employees.find((e) => String(e.id) === f.employee_id) || null;
  const typeLimit = emp ? emp.type_limit : meta.policies.find((p) => !p.employee_type)?.limit_amount ?? null;
  const empOptions = useMemo(() => {
    const s = empQ.trim().toLowerCase();
    return meta.employees.filter((e) => !s || String(e.id) === f.employee_id || [e.name, e.employee_code, e.department, e.designation].some((v) => String(v || '').toLowerCase().includes(s))).slice(0, 300);
  }, [meta.employees, empQ, f.employee_id]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { ...f, employee_id: f.employee_id ? Number(f.employee_id) : null, limit_amount: Number(f.limit_amount), operator: f.operator || null };
      if (sim) await mbApi(token, `/api/mobile-bill/sims/${sim.id}`, 'PUT', body);
      else await mbApi(token, '/api/mobile-bill/sims', 'POST', body);
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!sim || !window.confirm(`Delete ${sim.phone_number}? This can't be undone.`)) return;
    try {
      await mbApi(token, `/api/mobile-bill/sims/${sim.id}`, 'DELETE');
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Modal title={sim ? `SIM ${sim.phone_number}` : 'Give a SIM'} onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Mobile number</label>
              <input className={inputCls} value={f.phone_number} onChange={(e) => set('phone_number', e.target.value)} placeholder="01XXXXXXXXX" />
            </div>
            <div>
              <label className={labelCls}>Operator</label>
              <select className={inputCls} value={f.operator} onChange={(e) => set('operator', e.target.value)}>
                <option value="">From the number</option>
                {OPERATORS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Given to</label>
            <input className={`${inputCls} mb-1.5`} value={empQ} onChange={(e) => setEmpQ(e.target.value)} placeholder="Search employee name / ID / department…" />
            <select className={inputCls} value={f.employee_id} onChange={(e) => set('employee_id', e.target.value)}>
              <option value="">— Nobody (spare SIM) —</option>
              {empOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.employee_code ? ` (${e.employee_code})` : ''}
                  {e.department ? ` — ${e.department}` : ''}
                </option>
              ))}
            </select>
            {emp && (
              <p className="text-[11px] text-slate-500 mt-1">
                {[emp.designation, emp.department, emp.work_station].filter(Boolean).join(' · ')} · Type: {emp.employee_type || 'not set'}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Duty location</label>
              <input className={inputCls} value={f.duty_location} onChange={(e) => set('duty_location', e.target.value)} placeholder="e.g. Oleander" />
            </div>
            <div>
              <label className={labelCls}>Given on</label>
              <input type="date" className={inputCls} value={f.issued_on} onChange={(e) => set('issued_on', e.target.value)} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Monthly limit</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              {(
                [
                  ['type', `Employee type's limit${typeLimit != null ? ` (${tk(typeLimit)})` : ''}`],
                  ['custom', 'Custom amount']
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set('limit_source', k)}
                  className={`px-2 py-2 rounded-xl border text-[11px] font-semibold ${f.limit_source === k ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-slate-200 text-slate-600'}`}
                >
                  {l}
                </button>
              ))}
            </div>
            {f.limit_source === 'custom' ? (
              <input type="number" min={0} className={inputCls} value={f.limit_amount} onChange={(e) => set('limit_amount', e.target.value)} placeholder="৳" />
            ) : (
              typeLimit == null && <p className="text-[11px] text-amber-600">No limit is set for this type and no default — set one under Limits, or use a custom amount.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Package (optional)</label>
              <input className={inputCls} value={f.package_name} onChange={(e) => set('package_name', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <select className={inputCls} value={f.status} onChange={(e) => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="inactive">Turned off</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Note</label>
            <input className={inputCls} value={f.note} onChange={(e) => set('note', e.target.value)} />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-between gap-2">
            {sim ? (
              <button type="button" onClick={remove} className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:underline">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            ) : (
              <span />
            )}
            <button type="button" className={btnMain} disabled={saving || !f.phone_number} onClick={save}>
              {saving ? 'Saving…' : sim ? 'Save' : 'Give SIM'}
            </button>
          </div>
        </div>
        {sim && (
          <div className="space-y-4 md:border-l md:border-slate-100 md:pl-5">
            {!detail ? (
              <Spinner size={20} />
            ) : (
              <>
                <div>
                  <h4 className="text-xs font-bold text-slate-700 mb-1.5">Bills</h4>
                  {detail.bills.length === 0 ? (
                    <p className="text-[11px] text-slate-400">No bill yet.</p>
                  ) : (
                    <table className="w-full text-[11px]">
                      <tbody>
                        {detail.bills.slice(0, 12).map((b) => (
                          <tr key={b.id} className="border-t border-slate-50">
                            <td className="py-1">{monthLabel(b.month, true)}</td>
                            <td className="text-right text-slate-400">limit {num(b.limit_amount)}</td>
                            <td className={`text-right font-semibold ${b.amount > b.limit_amount ? 'text-rose-600' : ''}`}>{tk(b.amount)}</td>
                            <td className="text-right text-[10px] text-emerald-700">{b.paid_at ? 'paid' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {detail.requests.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-700 mb-1.5">Limit requests</h4>
                    {detail.requests.map((r) => (
                      <div key={r.id} className="text-[11px] py-1 border-t border-slate-50">
                        <StatusPill status={r.status} /> {tk(r.current_limit)} → {tk(r.requested_limit)} · {r.scope === 'permanent' ? `from ${monthLabel(r.for_month, true)}` : monthLabel(r.for_month, true)}
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <h4 className="text-xs font-bold text-slate-700 mb-1.5">History</h4>
                  {detail.events.map((e) => (
                    <div key={e.id} className="text-[11px] py-1 border-t border-slate-50">
                      <div className="text-slate-700">{e.message}</div>
                      <div className="text-[10px] text-slate-400">
                        {fmtDate(e.created_at)}
                        {e.actor_name ? ` · ${e.actor_name}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

// HR's own SIM list (like the "All Numbers" sheet): Mobile Number, Emp. ID,
// Duty location, Official Ceiling, optional Operator — and the usage-history
// month columns (Sep-26, Aug-26…) come in as past bills.
const ImportSimsModal: React.FC<{ token: string; onClose: () => void; onDone: () => void }> = ({ token, onClose, onDone }) => {
  const [book, setBook] = useState<Awaited<ReturnType<typeof readSheet>> | null>(null);
  const [sheet, setSheet] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [withHistory, setWithHistory] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const grid = useMemo(() => (book && sheet ? book.read(sheet) : []), [book, sheet]);
  const headerIdx = useMemo(() => findHeaderRow(grid, PHONE_HEAD), [grid]);
  const headers = useMemo(() => (grid[headerIdx] || []).map((h: any) => String(h || '').trim()), [grid, headerIdx]);
  const cols = useMemo(
    () => ({
      phone: guessColumn(headers, /mobile|msisdn|phone|number/i),
      emp: guessColumn(headers, /emp.*id|employee.*id|^id$|emp.*code/i),
      operator: guessColumn(headers, /operator/i),
      limit: guessColumn(headers, /ceiling|limit/i),
      duty: guessColumn(headers, /duty|location/i)
    }),
    [headers]
  );
  const monthCols = useMemo(() => headers.map((h, i) => ({ i, month: parseMonthHeader(h) })).filter((x) => x.month) as { i: number; month: string }[], [headers]);
  const body = useMemo(() => grid.slice(headerIdx + 1).filter((r) => cols.phone >= 0 && String(r[cols.phone] ?? '').trim()), [grid, headerIdx, cols.phone]);
  const at = (r: any[], i: number) => (i >= 0 ? r[i] : '');
  const rows = body.map((r) => ({ phone_number: at(r, cols.phone), employee_code: at(r, cols.emp), operator: at(r, cols.operator), limit_amount: at(r, cols.limit), duty_location: at(r, cols.duty) }));

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError('');
    setCheck(null);
    try {
      const b = await readSheet(f);
      setBook(b);
      setSheet(b.sheets[0]);
    } catch {
      setError('Could not read that file — use an Excel (.xlsx / .xls) or CSV file.');
    }
  };
  const run = async (dry: boolean) => {
    setError('');
    setBusy(dry ? 'Checking…' : 'Adding SIMs…');
    try {
      const r = await mbApi<CheckResult>(token, '/api/mobile-bill/sims/import', 'POST', { rows, dry_run: dry });
      if (dry) {
        setCheck(r);
        return;
      }
      if (withHistory) {
        for (const mc of monthCols) {
          setBusy(`Past bills: ${monthLabel(mc.month)}…`);
          const billRows = body
            .map((row) => ({ phone_number: row[cols.phone], amount: String(row[mc.i] ?? '').replace(/[,৳\s]/g, '') }))
            .filter((x) => Number(x.amount) > 0);
          if (billRows.length) await mbApi(token, '/api/mobile-bill/bills/import', 'POST', { month: mc.month, rows: billRows, replace: true, dry_run: false });
        }
      }
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title="Import SIM list" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Your SIM sheet — columns <b>Mobile Number</b>, <b>Emp. ID</b>, <b>Official Ceiling</b> (limit), <b>Duty location</b> and, if you have it, <b>Operator</b>. A row
          with no ceiling takes the employee type's limit. Month columns like <b>Sep-26</b> are read as that month's bill.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <input type="file" accept=".xlsx,.xls,.csv" className="text-xs" onChange={(e) => pick(e.target.files?.[0])} />
          {book && book.sheets.length > 1 && (
            <select className={filterCls} value={sheet} onChange={(e) => (setSheet(e.target.value), setCheck(null))}>
              {book.sheets.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
        </div>
        {book && (
          <div className="text-[11px] text-slate-600 bg-slate-50 rounded-xl p-3">
            Found: number = <b>{headers[cols.phone] || '—'}</b>, Emp. ID = <b>{headers[cols.emp] || '—'}</b>, limit = <b>{headers[cols.limit] || '—'}</b>, duty location ={' '}
            <b>{headers[cols.duty] || '—'}</b>, operator = <b>{headers[cols.operator] || 'from the number'}</b> · {rows.length} rows
            {monthCols.length > 0 && (
              <label className="flex items-center gap-2 mt-1.5">
                <input type="checkbox" checked={withHistory} onChange={(e) => setWithHistory(e.target.checked)} /> Also import past bills from{' '}
                {monthCols.map((m) => monthLabel(m.month, true)).join(', ')}
              </label>
            )}
          </div>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        {check && <CheckTable check={check} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnLight} disabled={!!busy || !rows.length} onClick={() => run(true)}>
            Check
          </button>
          <button type="button" className={btnMain} disabled={!!busy || !check || !check.ok} onClick={() => run(false)}>
            {busy || (check ? `Add ${check.ok} SIMs` : 'Add')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// ============================================================================
// Limits by employee type
// ============================================================================
const LimitsTab: React.FC<{ token: string }> = ({ token }) => {
  const [rows, setRows] = useState<MbPolicy[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [form, setForm] = useState<{ id?: number; employee_type: string; limit_amount: string; note: string } | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    mbApi<MbPolicy[]>(token, '/api/mobile-bill/policies')
      .then(setRows)
      .catch((e) => setError(e.message));
    mbApi<Meta>(token, '/api/mobile-bill/meta')
      .then((m) => setTypes(m.employee_types))
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setError('');
    try {
      const r = await mbApi(token, '/api/mobile-bill/policies', 'POST', { ...form, limit_amount: Number(form.limit_amount) });
      setMsg(r.sims_updated ? `Saved — ${r.sims_updated} SIM limit(s) updated.` : 'Saved.');
      setForm(null);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const remove = async (p: MbPolicy) => {
    if (!window.confirm(`Remove the limit for ${p.employee_type || 'Default'}?`)) return;
    try {
      await mbApi(token, `/api/mobile-bill/policies/${p.id}`, 'DELETE');
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const missing = types.filter((t) => !(rows || []).some((p) => p.employee_type.toLowerCase() === t.toLowerCase()));

  return (
    <div className="space-y-3 max-w-3xl">
      <p className="text-xs text-slate-500">
        The monthly limit for each employee type (Employees → Employment Category). A SIM set to "employee type's limit" follows it — change a limit here and those SIMs
        change too. <b>Default</b> is for anyone whose type has no row.
      </p>
      <div className="flex gap-2">
        <button type="button" className={btnMain} onClick={() => setForm({ employee_type: '', limit_amount: '', note: '' })}>
          <Plus className="w-3.5 h-3.5" /> Add limit
        </button>
      </div>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!rows ? (
        <Spinner size={22} />
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">Employee type</th>
                <th className="px-3 py-2 text-right">Monthly limit</th>
                <th className="px-3 py-2 text-right">SIMs following it</th>
                <th className="px-3 py-2 text-left">Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400 text-xs">
                    No limits yet.
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">{p.employee_type || 'Default'}</td>
                  <td className="px-3 py-2 text-right">{tk(p.limit_amount)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{p.sims ?? 0}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{p.note || ''}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button type="button" className="p-1 rounded-lg hover:bg-slate-100" onClick={() => setForm({ id: p.id, employee_type: p.employee_type, limit_amount: String(p.limit_amount), note: p.note || '' })}>
                      <Pencil className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                    <button type="button" className="p-1 rounded-lg hover:bg-slate-100" onClick={() => remove(p)}>
                      <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {missing.length > 0 && <p className="text-[11px] text-amber-600">Types with no limit of their own (they use Default): {missing.join(', ')}</p>}
      {form && (
        <Modal title={form.id ? 'Edit limit' : 'Add limit'} onClose={() => setForm(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Employee type (leave empty for Default)</label>
              <input className={inputCls} list="mb-types" value={form.employee_type} onChange={(e) => setForm({ ...form, employee_type: e.target.value })} placeholder="e.g. Management, Officer, Staff" />
              <datalist id="mb-types">
                {types.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div>
              <label className={labelCls}>Monthly limit (৳)</label>
              <input type="number" min={0} className={inputCls} value={form.limit_amount} onChange={(e) => setForm({ ...form, limit_amount: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Note</label>
              <input className={inputCls} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <div className="flex justify-end">
              <button type="button" className={btnMain} disabled={form.limit_amount === ''} onClick={save}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ============================================================================
// Limit requests
// ============================================================================
const RequestsTab: React.FC<{ token: string; onChange: () => void }> = ({ token, onChange }) => {
  const [rows, setRows] = useState<MbRequest[] | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    mbApi<MbRequest[]>(token, '/api/mobile-bill/requests')
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const decide = async (r: MbRequest, decision: 'approve' | 'reject') => {
    const note = window.prompt(decision === 'approve' ? 'Note (optional)' : 'Why is it rejected? (optional)', '');
    if (note === null) return;
    try {
      await mbApi(token, `/api/mobile-bill/requests/${r.id}/decide`, 'POST', { decision, note });
      load();
      onChange();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const shown = (rows || []).filter((r) => filter === 'all' || r.status === 'pending');

  return (
    <div className="space-y-3 max-w-4xl">
      <div className="flex gap-1.5">
        {(['pending', 'all'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${filter === k ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
          >
            {k === 'pending' ? 'Waiting' : 'All'}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        Requests go through the approval chain (Approval Chain → Templates → "Mobile Limit Request"). A request with no chain waits here for HR.
      </p>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!rows ? (
        <Spinner size={22} />
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">Nothing waiting.</p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => {
            const hrDecides = r.status === 'pending' && !(r.chain && r.chain.status === 'pending');
            return (
              <div key={r.id} className="rounded-2xl bg-white border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">
                      {r.employee?.name || r.user_name} · <span className="font-mono">{r.phone_number}</span> <OperatorBadge op={r.operator} />
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {tk(r.current_limit)} → <b>{tk(r.requested_limit)}</b> · {r.scope === 'permanent' ? `from ${monthLabel(r.for_month)} on` : `${monthLabel(r.for_month)} only`}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">“{r.reason}”</div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      #{r.id} · {fmtDate(r.created_at)} · {requestStage(r)}
                      {r.decision_note ? ` — ${r.decision_note}` : ''}
                    </div>
                  </div>
                  <StatusPill status={r.status} />
                </div>
                {hrDecides && (
                  <div className="flex justify-end gap-2 mt-2">
                    <button type="button" className={btnLight} onClick={() => decide(r, 'reject')}>
                      Reject
                    </button>
                    <button type="button" className={btnMain} onClick={() => decide(r, 'approve')}>
                      Approve
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
