/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval (PayrollApprovalRoutes.ts): a salary month goes
// HR prepares -> HR Director (in the app, layer "hrd_review", or on paper
// with the signed copy attached) -> MD (on paper: HR prints it, attaches his
// marked copy) -> HR enters his corrections -> Accounts pays (layer
// "accounts_pay") -> Audit may check it afterwards (layer "audit_approve",
// optional, never holds pay up). Shows where the month is, its totals, the
// signed copies, the corrections, the history, the print / payment sheets
// and — once with Accounts — Bank / MFS wise payment vouchers.

import { maskMoney } from '../lib/payrollAmounts';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { CheckCircle2, ClipboardCheck, FileCheck2, FileSpreadsheet, FileText, Landmark, Paperclip, Plus, Printer, Send, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import { SearchSelect } from './Combobox';
import { printPayrollReview, PRINT_FOR_LABEL, type PrintFor } from '../lib/payrollReviewPdf';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';
import { PayrollPaymentVouchers } from './PayrollPaymentVouchers';
import { LoadingBlock } from './LoadingBlock';
import { PayrollSalarySheet } from './PayrollSalarySheet';
import { PayrollMonthCompare } from './PayrollMonthCompare';
import { PayrollTopSheet } from './PayrollTopSheet';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';

type Status = 'draft' | 'submitted' | 'hrd_review' | 'md_review' | 'corrections' | 'approved' | 'returned' | 'paid';
interface ReviewFile {
  id: number;
  stage: 'hrd' | 'md';
  name: string;
  mimetype: string;
  size: number;
  by: string | null;
  at: string;
}
interface Correction {
  id: number;
  payroll_id: number;
  employee_name: string;
  employee_code: string;
  department: string;
  source: 'md' | 'hrd';
  kind: 'waive_late' | 'waive_fine' | 'add' | 'cut' | 'other';
  amount: number;
  note: string;
  page: string | null;
  status: 'open' | 'applied' | 'not_done';
  result_note: string | null;
  net_before: number | null;
  net_after: number | null;
  by: string | null;
  at: string;
  done_by: string | null;
  done_at: string | null;
}
interface Person {
  payroll_id: number;
  name: string;
  code: string;
  designation: string;
  department: string;
  net: number;
  fine: number;
}
interface ApprovalState {
  month_year: string;
  status: Status;
  batch: null | {
    submitted_by: string | null;
    submitted_at: string | null;
    audited_by: string | null;
    audited_at: string | null;
    audit_note: string | null;
    paid_by: string | null;
    paid_at: string | null;
    payment_date: string | null;
    payment_method: string | null;
    payment_reference: string | null;
    hrd_by: string | null;
    hrd_at: string | null;
    hrd_note: string | null;
    hrd_mode: 'app' | 'paper' | null;
    md_sent_at: string | null;
    md_back_at: string | null;
    md_received_date: string | null;
    md_signed: boolean | null;
    print_version: number;
    sent_accounts_by: string | null;
    sent_accounts_at: string | null;
    post_audit_status: 'ok' | 'note' | null;
    post_audit_by: string | null;
    post_audit_at: string | null;
    post_audit_note: string | null;
  };
  files: ReviewFile[];
  corrections: Correction[];
  people: Person[];
  summary: { runs: number; total_net: number; payable_net: number; unpaid: number; processed: number; paid: number; held: number };
  held: { name: string; code: string | null; reason: string | null }[];
  events: { action: string; by: string | null; note: string | null; at: string }[];
  open_corrections: number;
  can: {
    submit: boolean;
    hrd_review: boolean;
    hrd_paper: boolean;
    md_back: boolean;
    corrections: boolean;
    to_accounts: boolean;
    attach: boolean;
    print: boolean;
    recall: boolean;
    return_: boolean;
    pay: boolean;
    audit: boolean;
  };
  md_files: number;
  hrd_files: number;
  is_submitter: boolean;
  // Why this account can't review / pay / audit (it ran, sent or paid it).
  conflict?: string | null;
}

const tk = maskMoney((n: number) => `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (v: string | null) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
};
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const ACTION_LABEL: Record<string, string> = {
  submitted: 'Sent to HR Director',
  hrd_reviewed: 'Reviewed by HR Director — sent to MD',
  hrd_paper: "HR Director's signed copy recorded — sent to MD",
  md_ok: "MD's copy back — no changes, sent to Accounts",
  md_corrections: "MD's copy back — with corrections",
  to_accounts: 'Corrections done — sent to Accounts',
  file: 'Copy attached',
  printed: 'Printed',
  approved: 'Approved (old flow)',
  returned: 'Returned to HR',
  paid: 'Disbursed by Accounts',
  audited_ok: 'Audited — OK',
  audit_note: 'Audit note'
};
const STEPS = [
  { key: 'draft', label: 'HR prepares' },
  { key: 'hrd_review', label: 'HR Director' },
  { key: 'md_review', label: 'MD (on paper)' },
  { key: 'corrections', label: 'HR corrections' },
  { key: 'approved', label: 'Accounts' },
  { key: 'paid', label: 'Disburse' }
];
const stepOf = (st: Status) => (st === 'returned' || st === 'draft' ? 0 : st === 'submitted' ? 1 : Math.max(0, STEPS.findIndex((x) => x.key === st)));
const KIND_LABEL: Record<Correction['kind'], string> = {
  waive_late: 'Waive late cut',
  waive_fine: 'Waive fine',
  add: 'Add to salary',
  cut: 'Deduct from salary',
  other: 'Other (done by hand)'
};
// What the person looking at the month should do next.
const NEXT: Record<Status, string> = {
  draft: 'HR checks the sheet and sends it to the HR Director.',
  returned: 'Correct what was asked and send it again.',
  submitted: 'With the HR Director.',
  hrd_review: 'The HR Director checks it here — or HR prints it, gets it signed and attaches the signed copy.',
  md_review: "Print the sheet for the MD. When it comes back, attach the scan / photo and record whether he changed anything.",
  corrections: "Enter each change the MD wrote on the paper, apply it, then send the sheet to Accounts.",
  approved: 'With Accounts to pay.',
  paid: 'Disbursed. Audit may check it afterwards (optional).'
};

async function call<T>(token: string, path: string, body?: any, method?: string): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Something went wrong.');
  return d as T;
}

type DialogKind = null | 'submit' | 'hrd' | 'hrd_paper' | 'md_back' | 'return' | 'recall' | 'pay' | 'audit' | 'print' | 'correction';

export const PayrollApprovalPanel: React.FC<{ token: string; monthYear?: string }> = ({ token, monthYear }) => {
  // Follows the Payroll page's own month picker when given.
  const [ownMonth, setMonth] = useState(thisMonth());
  const month = monthYear || ownMonth;
  const [data, setData] = useState<ApprovalState | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  // Salary sheet on screen (Payroll layer "approval_sheet").
  const [canSheet, setCanSheet] = useState(false);
  // Month comparison (Payroll layer "month_compare").
  const [canCompare, setCanCompare] = useState(false);
  // Top Sheet by Branch / site (Payroll layer "top_sheet").
  const [canTop, setCanTop] = useState(false);
  useEffect(() => {
    fetch(apiUrl('/api/payroll/approval-access'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setCanSheet(!!d?.approval_sheet);
        setCanCompare(!!d?.month_compare);
        setCanTop(!!d?.top_sheet);
      })
      .catch(() => setCanSheet(false));
  }, [token]);

  const load = useCallback(() => {
    setError('');
    call<ApprovalState>(token, `/api/payroll/approval/${month}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token, month]);
  useEffect(() => {
    setData(null);
    setMsg('');
    load();
  }, [load]);

  const act = async (path: string, body: any, done: string, method?: string) => {
    setBusy(true);
    setError('');
    try {
      await call(token, `/api/payroll/approval/${month}/${path}`, body, method);
      setMsg(done);
      setDialog(null);
      load();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const exportSheet = async () => {
    try {
      const d = await call<{ rows: any[] }>(token, `/api/payroll/approval/${month}/payment-sheet`);
      const head = ['SL', 'Employee ID', 'Name', 'Department', 'Designation', 'Net Salary', 'Account Type', 'Bank / Provider', 'Branch', 'Account No', 'Amount', 'Status'];
      const body = d.rows.map((r, i) => [i + 1, r.employee_code || '', r.employee_name, r.department || '', r.designation || '', r.net_salary, r.account_type, r.bank, r.branch, r.account_number, r.amount, r.status]);
      const ws = XLSX.utils.aoa_to_sheet([[`Salary Payment Sheet — ${month}`], [], head, ...body]);
      ws['!cols'] = [5, 12, 24, 18, 18, 12, 10, 20, 16, 20, 12, 10].map((wch) => ({ wch }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payment Sheet');
      void saveWorkbookCrossPlatform(wb, `Salary-Payment-Sheet-${month}.xlsx`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const stepIndex = data ? stepOf(data.status) : 0;
  const s = data?.summary;
  const b = data?.batch;
  const btn = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {monthYear ? (
          <div className="text-sm font-semibold text-slate-700">Salary month: {month}</div>
        ) : (
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Salary month</label>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="text-sm px-3 py-2 bg-white border border-slate-200 rounded-xl" />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {data?.can.print && s!.runs > 0 && (
            <button type="button" onClick={() => setDialog('print')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
              <Printer className="w-3.5 h-3.5" /> Print sheet (PDF)
            </button>
          )}
          <button type="button" onClick={exportSheet} disabled={!s?.runs} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Payment sheet (Excel)
          </button>
        </div>
      </div>

      {msg && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{msg}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      {!data ? (
        !error && <LoadingBlock />
      ) : (
        <>
          {/* Where the month is */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto pb-1">
              {STEPS.map((st, i) => {
                const done = i < stepIndex || data.status === 'paid';
                const current = i === stepIndex && data.status !== 'paid';
                return (
                  <React.Fragment key={st.key}>
                    {i > 0 && <div className={`h-0.5 flex-1 min-w-4 ${i <= stepIndex ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center ${done ? 'bg-emerald-500 text-white' : current ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                        {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                      </span>
                      <span className={`text-xs font-semibold ${current ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{st.label}</span>
                    </div>
                  </React.Fragment>
                );
              })}
              <div className="h-0.5 flex-1 min-w-4 border-t-2 border-dashed border-slate-200" />
              <span
                title="Optional — after payment, never holds it up"
                className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${
                  b?.post_audit_status === 'ok' ? 'bg-emerald-100 text-emerald-800' : b?.post_audit_status === 'note' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                }`}
              >
                Audit (optional){b?.post_audit_status === 'ok' ? ' ✓' : b?.post_audit_status === 'note' ? ' — note' : ''}
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-3">{NEXT[data.status]}</p>
            {data.status === 'returned' && b?.audit_note && (
              <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">
                <b>Returned:</b> {b.audit_note}
              </div>
            )}
            {b?.hrd_at && data.status !== 'returned' && data.status !== 'hrd_review' && (
              <div className="mt-2 text-[11px] text-slate-500">
                HR Director: {b.hrd_mode === 'paper' ? 'signed copy recorded' : 'reviewed in the app'} by {b.hrd_by} · {when(b.hrd_at)}
                {b.hrd_note ? ` — ${b.hrd_note}` : ''}
              </div>
            )}
            {b?.md_back_at && (
              <div className="mt-1 text-[11px] text-slate-500">
                MD's copy back{b.md_received_date ? ` on ${b.md_received_date}` : ''}
                {b.md_signed === false ? ' (not signed)' : ' (signed)'} · recorded {when(b.md_back_at)}
              </div>
            )}
            {data.status === 'paid' && b && (
              <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800">
                Disbursed on {b.payment_date} · {b.payment_method}
                {b.payment_reference ? ` · Ref ${b.payment_reference}` : ''} · by {b.paid_by}
              </div>
            )}
            {b?.post_audit_status && (
              <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${b.post_audit_status === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                <b>Audit {b.post_audit_status === 'ok' ? 'OK' : 'note'}</b> — {b.post_audit_by} · {when(b.post_audit_at)}
                {b.post_audit_note ? `: ${b.post_audit_note}` : ''}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
              {[
                ['Employees', s!.runs],
                ['Net total', tk(s!.total_net)],
                ['To pay', tk(s!.payable_net)],
                ['Fines', tk(data.people.reduce((a, p) => a + (p.fine || 0), 0))],
                ['Disbursed', s!.paid]
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl border border-slate-200 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="text-sm font-bold text-slate-800">{v}</div>
                </div>
              ))}
            </div>
            {s!.runs === 0 && <p className="text-xs text-slate-500 mt-3">No salary for this month yet — Run Payroll first.</p>}
            {data.held.length > 0 && (
              <div className="mt-3 text-[11px] text-slate-600">
                <b>On hold (left out, {data.held.length}):</b> {data.held.map((h) => `${h.name}${h.code ? ` (${h.code})` : ''}`).join(', ')}
              </div>
            )}

            <div className="flex flex-wrap gap-2 mt-4">
              {data.can.submit && (
                <button type="button" onClick={() => setDialog('submit')} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>
                  <Send className="w-3.5 h-3.5" /> Send to HR Director
                </button>
              )}
              {data.can.hrd_review && (
                <button type="button" onClick={() => setDialog('hrd')} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
                  <ClipboardCheck className="w-3.5 h-3.5" /> Reviewed — send to MD
                </button>
              )}
              {data.can.hrd_paper && (
                <button type="button" onClick={() => setDialog('hrd_paper')} className={`${btn} bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>
                  <FileCheck2 className="w-3.5 h-3.5" /> HR Director signed on paper
                </button>
              )}
              {data.can.md_back && (
                <button type="button" onClick={() => setDialog('md_back')} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
                  <FileCheck2 className="w-3.5 h-3.5" /> MD's copy came back
                </button>
              )}
              {data.can.corrections && (
                <button type="button" onClick={() => setDialog('correction')} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>
                  <Plus className="w-3.5 h-3.5" /> Add a correction
                </button>
              )}
              {data.status === 'corrections' && data.can.corrections && (
                <button
                  type="button"
                  disabled={!data.can.to_accounts || busy}
                  title={data.can.to_accounts ? '' : 'Apply or mark every correction first'}
                  onClick={async () => {
                    if (await confirmDialog(`Send the ${month} salary (${tk(s!.payable_net)}) to Accounts?`)) void act('to-accounts', {}, 'Sent to Accounts. Accounts has been notified.');
                  }}
                  className={`${btn} bg-violet-600 text-white hover:bg-violet-700`}
                >
                  <Landmark className="w-3.5 h-3.5" /> Send to Accounts{data.open_corrections ? ` (${data.open_corrections} open)` : ''}
                </button>
              )}
              {data.can.return_ && (
                <button type="button" onClick={() => setDialog('return')} className={`${btn} bg-white border border-amber-300 text-amber-700 hover:bg-amber-50`}>
                  <Undo2 className="w-3.5 h-3.5" /> Return to HR
                </button>
              )}
              {data.can.recall && !data.can.return_ && (
                <button type="button" onClick={() => setDialog('recall')} className={`${btn} bg-white border border-slate-200 text-slate-600 hover:bg-slate-50`}>
                  <Undo2 className="w-3.5 h-3.5" /> Take back to edit
                </button>
              )}
              {data.can.pay && (
                <button type="button" onClick={() => setDialog('pay')} className={`${btn} bg-violet-600 text-white hover:bg-violet-700`}>
                  <Landmark className="w-3.5 h-3.5" /> Disburse (Accounts)
                </button>
              )}
              {data.can.audit && (
                <button type="button" onClick={() => setDialog('audit')} className={`${btn} bg-white border border-slate-300 text-slate-700 hover:bg-slate-50`}>
                  <ShieldCheck className="w-3.5 h-3.5" /> Audit this month
                </button>
              )}
              {data.conflict && <span className="text-[11px] text-slate-500 self-center">{data.conflict}</span>}
            </div>
            {['hrd_review', 'md_review', 'corrections', 'approved', 'submitted'].includes(data.status) && (
              <p className="text-[11px] text-slate-400 mt-2">While it is under review, this month's salaries can't be generated, edited or deleted — corrections are made here.</p>
            )}
          </div>

          {/* The signed paper copies (scan / photo) */}
          {(data.files.length > 0 || data.can.attach) && (
            <ReviewFiles token={token} month={month} data={data} onChange={load} onError={setError} />
          )}

          {/* The MD's corrections, entered by HR from his copy */}
          {(data.corrections.length > 0 || data.status === 'corrections') && (
            <CorrectionsPanel token={token} month={month} data={data} busy={busy} act={act} />
          )}

          {/* Every employee's salary on screen, to check before reviewing / paying. */}
          {canSheet && s!.runs > 0 && <PayrollSalarySheet key={`${month}-${data.corrections.filter((c) => c.status === 'applied').length}`} token={token} month={month} />}

          {/* This month against last month: who is new, who left, and why each salary changed. */}
          {canCompare && s!.runs > 0 && <PayrollMonthCompare token={token} month={month} />}

          {/* Accounts' top sheet: the month by Branch / site, each site's own sheet, Excel / PDF. */}
          {canTop && s!.runs > 0 && <PayrollTopSheet token={token} month={month} />}

          {/* Bank / MFS wise payment vouchers for Accounts (the software doesn't send money). */}
          {(data.status === 'approved' || data.status === 'paid') && s!.runs > 0 && <PayrollPaymentVouchers token={token} month={month} paid={data.status === 'paid'} />}

          {/* History */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="text-xs font-bold text-slate-700 mb-2">History</div>
            {data.events.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing yet for this month.</p>
            ) : (
              <ol className="space-y-2">
                {data.events.map((e, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span
                      className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                        e.action === 'returned' || e.action === 'audit_note' ? 'bg-amber-500' : e.action === 'paid' ? 'bg-violet-500' : e.action === 'file' || e.action === 'printed' ? 'bg-slate-300' : 'bg-emerald-500'
                      }`}
                    />
                    <span>
                      <b>{ACTION_LABEL[e.action] || e.action}</b> — {e.by || 'Someone'} · <span className="text-slate-400">{when(e.at)}</span>
                      {e.note && <div className="text-slate-600">{e.note}</div>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      {dialog === 'print' && data && (
        <PrintDialog
          token={token}
          month={month}
          data={data}
          onClose={() => setDialog(null)}
          onDone={(v) => {
            setDialog(null);
            setMsg(`Printed — version ${v}. Write nothing on an older copy.`);
            load();
          }}
        />
      )}
      {dialog === 'correction' && data && (
        <CorrectionDialog
          people={data.people}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={(body) => void act('corrections', body, 'Correction added — apply it when ready.')}
        />
      )}
      {dialog && !['print', 'correction'].includes(dialog) && data && (
        <ApprovalDialog
          kind={dialog as any}
          month={month}
          data={data}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            if (dialog === 'submit') return void act('submit', { note: v.note }, 'Sent to the HR Director, who has been notified.');
            if (dialog === 'hrd') return void act('hrd-done', { note: v.note }, 'Reviewed. HR prints it for the MD next.');
            if (dialog === 'hrd_paper') return void act('hrd-done', { mode: 'paper', note: v.note }, "HR Director's signed copy recorded. Print it for the MD next.");
            if (dialog === 'md_back')
              return void act('md-back', { changes: v.changes, signed: v.signed, received_date: v.date, note: v.note }, v.changes ? 'Recorded. Enter each correction the MD made.' : 'Recorded. Sent to Accounts, who have been notified.');
            if (dialog === 'return' || dialog === 'recall') return void act('return', { note: v.note }, 'Returned to HR.');
            if (dialog === 'audit') return void act('audit', { result: v.auditResult, note: v.note }, 'Audit recorded. HR and Accounts have been told.');
            if (!(await confirmDialog(`Pay ${data.summary.processed} salaries (${tk(data.summary.payable_net)}) for ${month}? This can't be undone.`))) return;
            return void act('pay', { payment_date: v.date, payment_method: v.method, payment_reference: v.reference }, 'Disbursed. Employees have been notified.');
          }}
        />
      )}
    </div>
  );
};

// ---- the signed copies -----------------------------------------------------
const ReviewFiles: React.FC<{ token: string; month: string; data: ApprovalState; onChange: () => void; onError: (m: string) => void }> = ({ token, month, data, onChange, onError }) => {
  const [uploading, setUploading] = useState<'' | 'hrd' | 'md'>('');
  const hrdInput = useRef<HTMLInputElement>(null);
  const mdInput = useRef<HTMLInputElement>(null);
  const canHrd = data.can.attach && data.status === 'hrd_review';
  const canMd = data.can.attach && (data.status === 'md_review' || data.status === 'corrections');
  const upload = async (stage: 'hrd' | 'md', files: FileList | null) => {
    if (!files?.length) return;
    setUploading(stage);
    onError('');
    try {
      for (const f of Array.from(files)) {
        if (f.size > 20 * 1024 * 1024) throw new Error(`${f.name} is over 20 MB.`);
        const r = await fetch(apiUrl(`/api/payroll/approval/${month}/files?stage=${stage}&name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type)}`), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
          body: f
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Could not attach ${f.name}.`);
      }
      onChange();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setUploading('');
    }
  };
  const open = async (f: ReviewFile) => {
    try {
      const r = await fetch(apiUrl(`/api/payroll/approval/files/${f.id}`), { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not open the copy.');
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      onError(e.message);
    }
  };
  const remove = async (f: ReviewFile) => {
    if (!(await confirmDialog(`Remove "${f.name}"?`, { tone: 'danger' }))) return;
    try {
      await call(token, `/api/payroll/approval/files/${f.id}`, undefined, 'DELETE');
      onChange();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const list = (stage: 'hrd' | 'md') => {
    const fs = data.files.filter((f) => f.stage === stage);
    return fs.length === 0 ? (
      <p className="text-[11px] text-slate-400">Nothing attached.</p>
    ) : (
      <ul className="space-y-1.5">
        {fs.map((f) => (
          <li key={f.id} className="flex items-center gap-2 text-xs">
            <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <button type="button" onClick={() => void open(f)} className="font-semibold text-blue-700 hover:underline truncate text-left">
              {f.name}
            </button>
            <span className="text-[10px] text-slate-400 shrink-0">
              {Math.max(1, Math.round(f.size / 1024))} KB · {f.by} · {when(f.at)}
            </span>
            {(stage === 'hrd' ? canHrd : canMd) && (
              <button type="button" onClick={() => void remove(f)} className="ml-auto text-slate-400 hover:text-rose-600 shrink-0" aria-label={`Remove ${f.name}`}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  };
  const box = (stage: 'hrd' | 'md', title: string, can: boolean, ref: React.RefObject<HTMLInputElement | null>) => (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-bold text-slate-700">{title}</span>
        {can && (
          <>
            <input ref={ref} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => {
              void upload(stage, e.target.files);
              e.target.value = '';
            }} />
            <button type="button" disabled={!!uploading} onClick={() => ref.current?.click()} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50">
              {uploading === stage ? <Spinner size={12} /> : <Paperclip className="w-3 h-3" />} Attach scan / photo
            </button>
          </>
        )}
      </div>
      {list(stage)}
    </div>
  );
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-bold text-slate-700 mb-1">Signed copies</div>
      <p className="text-[11px] text-slate-500 mb-3">The printed sheet as it came back — PDF, JPG, PNG or WebP, up to 20 MB each.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {box('hrd', "HR Director's copy", canHrd, hrdInput)}
        {box('md', "MD's copy", canMd, mdInput)}
      </div>
    </div>
  );
};

// ---- corrections -------------------------------------------------------------
const CorrectionsPanel: React.FC<{
  token: string;
  month: string;
  data: ApprovalState;
  busy: boolean;
  act: (path: string, body: any, done: string, method?: string) => Promise<boolean>;
}> = ({ data, busy, act }) => {
  const [skipping, setSkipping] = useState<Correction | null>(null);
  const editable = data.can.corrections;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="text-xs font-bold text-slate-700">Corrections from the MD's copy</div>
          <p className="text-[11px] text-slate-500">Each change written on the paper — applied to the salary as a one-month line on the payslip.</p>
        </div>
        {data.open_corrections > 0 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 shrink-0">{data.open_corrections} open</span>}
      </div>
      {data.corrections.length === 0 ? (
        <p className="text-xs text-slate-400">None yet — use "Add a correction" for each change the MD made.</p>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wide">
              <tr>
                <th className="px-2.5 py-2 text-left font-semibold">Employee</th>
                <th className="px-2.5 py-2 text-left font-semibold">Change</th>
                <th className="px-2.5 py-2 text-right font-semibold">Amount</th>
                <th className="px-2.5 py-2 text-left font-semibold">MD wrote</th>
                <th className="px-2.5 py-2 text-right font-semibold">Net before → after</th>
                <th className="px-2.5 py-2 text-left font-semibold">Status</th>
                {editable && <th className="px-2.5 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.corrections.map((c) => (
                <tr key={c.id}>
                  <td className="px-2.5 py-2">
                    <div className="font-semibold text-slate-800 whitespace-nowrap">{c.employee_name}</div>
                    <div className="text-[10px] text-slate-500 whitespace-nowrap">{[c.employee_code, c.department].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">{KIND_LABEL[c.kind]}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums whitespace-nowrap">{c.kind === 'other' && !c.amount ? '—' : tk(c.amount)}</td>
                  <td className="px-2.5 py-2 text-slate-600 max-w-[260px]">
                    {c.note}
                    {c.page && <span className="text-slate-400"> · page {c.page}</span>}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums whitespace-nowrap">{c.net_before != null && c.net_after != null && c.net_before !== c.net_after ? `${tk(c.net_before)} → ${tk(c.net_after)}` : '—'}</td>
                  <td className="px-2.5 py-2 whitespace-nowrap">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${c.status === 'applied' ? 'bg-emerald-100 text-emerald-800' : c.status === 'not_done' ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>
                      {c.status === 'applied' ? 'Applied' : c.status === 'not_done' ? 'Not done' : 'Open'}
                    </span>
                    {c.result_note && <div className="text-[10px] text-slate-500 mt-0.5 max-w-[180px] whitespace-normal">{c.result_note}</div>}
                  </td>
                  {editable && (
                    <td className="px-2.5 py-2 whitespace-nowrap text-right">
                      {c.status === 'open' && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              const what = c.kind === 'other' ? 'Mark this as done by hand?' : `${KIND_LABEL[c.kind]} ${tk(c.amount)} for ${c.employee_name}? The salary is recalculated.`;
                              if (await confirmDialog(what)) void act(`corrections/${c.id}/apply`, {}, 'Applied.');
                            }}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            Apply
                          </button>
                          <button type="button" disabled={busy} onClick={() => setSkipping(c)} className="ml-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                            Not done
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          const q = c.status === 'applied' ? `Remove this correction and undo it on ${c.employee_name}'s salary?` : 'Remove this correction?';
                          if (await confirmDialog(q, { tone: 'danger' })) void act(`corrections/${c.id}`, undefined, 'Removed.', 'DELETE');
                        }}
                        className="ml-1 p-1 text-slate-400 hover:text-rose-600 align-middle"
                        aria-label="Remove correction"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {skipping && (
        <NoteDialog
          title="Not done"
          subtitle={`${KIND_LABEL[skipping.kind]} — ${skipping.employee_name}`}
          label="Why isn't it done? *"
          busy={busy}
          onClose={() => setSkipping(null)}
          onSave={async (note) => {
            if (await act(`corrections/${skipping.id}/skip`, { note }, 'Marked as not done.')) setSkipping(null);
          }}
        />
      )}
    </div>
  );
};

const inputCls = 'w-full text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-200 focus:outline-none';
const Glass: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }> = ({ title, subtitle, onClose, children, footer }) =>
  createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div role="dialog" aria-label={title} className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">{title}</h3>
              {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {children}
          <div className="mt-4 flex justify-end gap-2">{footer}</div>
        </div>
      </div>
    </div>,
    document.body
  );
const Cancel: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button type="button" onClick={onClick} className="px-4 py-2 text-sm font-semibold text-slate-600 rounded-full hover:bg-black/5">
    Cancel
  </button>
);
const Main: React.FC<{ onClick: () => void; disabled?: boolean; busy?: boolean; children: React.ReactNode }> = ({ onClick, disabled, busy, children }) => (
  <button type="button" disabled={disabled || busy} onClick={onClick} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
    {busy && <Spinner size={14} />} {children}
  </button>
);

const NoteDialog: React.FC<{ title: string; subtitle?: string; label: string; busy: boolean; onClose: () => void; onSave: (note: string) => void }> = ({ title, subtitle, label, busy, onClose, onSave }) => {
  const [note, setNote] = useState('');
  return (
    <Glass title={title} subtitle={subtitle} onClose={onClose} footer={<><Cancel onClick={onClose} /><Main busy={busy} disabled={!note.trim()} onClick={() => onSave(note.trim())}>Save</Main></>}>
      <div className="mt-4">
        <label className="block text-[11px] font-semibold text-slate-500 mb-1">{label}</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} resize-none`} />
      </div>
    </Glass>
  );
};

const CorrectionDialog: React.FC<{ people: Person[]; busy: boolean; onClose: () => void; onSave: (body: any) => void }> = ({ people, busy, onClose, onSave }) => {
  const [pid, setPid] = useState('');
  const [kind, setKind] = useState<Correction['kind']>('waive_late');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [page, setPage] = useState('');
  const p = people.find((x) => String(x.payroll_id) === pid);
  const ok = !!p && !!note.trim() && (kind === 'other' || Number(amount) > 0);
  return (
    <Glass
      title="Add a correction"
      subtitle="One change the MD wrote on the paper"
      onClose={onClose}
      footer={
        <>
          <Cancel onClick={onClose} />
          <Main busy={busy} disabled={!ok} onClick={() => onSave({ payroll_id: Number(pid), kind, amount: Number(amount) || 0, note: note.trim(), page: page.trim() })}>
            Add
          </Main>
        </>
      }
    >
      <div className="mt-4 space-y-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Employee *</label>
          <SearchSelect className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">— Select employee —</option>
            {people.map((x) => (
              <option key={x.payroll_id} value={x.payroll_id}>
                {[x.name, x.code, x.designation, x.department].filter(Boolean).join(' · ')}
              </option>
            ))}
          </SearchSelect>
          {p && (
            <p className="text-[10px] text-slate-500 mt-1">
              Net now {tk(p.net)}
              {p.fine ? ` · fines ${tk(p.fine)}` : ''}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Change *</label>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as any)}>
              {(Object.keys(KIND_LABEL) as Correction['kind'][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Amount (৳){kind === 'other' ? '' : ' *'}</label>
            <input type="number" min={0} className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">What the MD wrote *</label>
          <textarea rows={2} className={`${inputCls} resize-none`} value={note} onChange={(e) => setNote(e.target.value)} placeholder='e.g. "Late waived — was on site visit"' />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Page on the paper (optional)</label>
          <input className={inputCls} value={page} onChange={(e) => setPage(e.target.value)} placeholder="e.g. 3" />
        </div>
      </div>
    </Glass>
  );
};

const PrintDialog: React.FC<{ token: string; month: string; data: ApprovalState; onClose: () => void; onDone: (version: number) => void }> = ({ token, month, data, onClose, onDone }) => {
  const suggested: PrintFor = data.status === 'hrd_review' || data.status === 'draft' || data.status === 'returned' ? 'hrd' : data.status === 'md_review' ? 'md' : 'final';
  const [forWho, setFor] = useState<PrintFor>(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Glass
      title="Print salary sheet"
      subtitle={`${month} · next copy is version ${(data.batch?.print_version || 0) + 1}`}
      onClose={onClose}
      footer={
        <>
          <Cancel onClick={onClose} />
          <Main
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                onDone(await printPayrollReview(token, month, forWho, { prepared: data.batch?.submitted_by, hrd: data.batch?.hrd_by }));
              } catch (e: any) {
                setError(e.message || 'Could not make the PDF.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Printer className="w-4 h-4" /> Make PDF
          </Main>
        </>
      }
    >
      <div className="liquid-glass-inset rounded-2xl p-3 mt-4 space-y-2">
        {(Object.keys(PRINT_FOR_LABEL) as PrintFor[]).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="radio" name="print-for" checked={forWho === k} onChange={() => setFor(k)} /> {PRINT_FOR_LABEL[k]}
          </label>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mt-3">A summary by department, then one page per department with a Fine column, a blank Remarks column for the MD, the version stamp and the four signature boxes.</p>
      {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
    </Glass>
  );
};

const ApprovalDialog: React.FC<{
  kind: 'submit' | 'hrd' | 'hrd_paper' | 'md_back' | 'return' | 'recall' | 'pay' | 'audit';
  month: string;
  data: ApprovalState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: { note: string; date: string; method: string; reference: string; changes: boolean; signed: boolean; auditResult: 'ok' | 'note' }) => void;
}> = ({ kind, month, data, busy, onClose, onSubmit }) => {
  const summary = data.summary;
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('Bank Transfer');
  const [reference, setReference] = useState('');
  const [changes, setChanges] = useState(false);
  const [signed, setSigned] = useState(true);
  const [auditResult, setAuditResult] = useState<'ok' | 'note'>('ok');
  const title = {
    submit: 'Send to HR Director',
    hrd: 'Reviewed — send to MD',
    hrd_paper: 'HR Director signed on paper',
    md_back: "MD's copy came back",
    return: 'Return to HR',
    recall: 'Take back to edit',
    pay: 'Disburse salary',
    audit: 'Audit this month'
  }[kind];
  const noteRequired = kind === 'return' || kind === 'recall' || (kind === 'audit' && auditResult === 'note');
  const missingFile = (kind === 'hrd_paper' && data.hrd_files === 0) || (kind === 'md_back' && data.md_files === 0);
  const blocked = busy || missingFile || (noteRequired && !note.trim()) || (kind === 'pay' && !date);
  return (
    <Glass
      title={title}
      subtitle={`${month} · ${summary.runs} employees · ${tk(summary.payable_net)} to pay${summary.held ? ` · ${summary.held} on hold left out` : ''}`}
      onClose={onClose}
      footer={
        <>
          <Cancel onClick={onClose} />
          <Main busy={busy} disabled={blocked} onClick={() => onSubmit({ note: note.trim(), date, method, reference: reference.trim(), changes, signed, auditResult })}>
            {title}
          </Main>
        </>
      }
    >
      {missingFile && (
        <div className="mt-4 text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">
          Attach the scan / photo of the {kind === 'hrd_paper' ? "HR Director's signed copy" : "MD's copy"} first (Signed copies, below).
        </div>
      )}
      {kind === 'pay' ? (
        <div className="liquid-glass-inset rounded-2xl p-3 mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Payment date *</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Disbursed by *</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
                {['Bank Transfer', 'Cheque', 'bKash / MFS', 'Cash', 'Mixed (as per sheet)'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Reference (bank advice / cheque no.)</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
        </div>
      ) : (
        <>
          {kind === 'md_back' && (
            <div className="liquid-glass-inset rounded-2xl p-3 mt-4 space-y-2.5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="md-changes" checked={!changes} onChange={() => setChanges(false)} /> No changes — send to Accounts
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="md-changes" checked={changes} onChange={() => setChanges(true)} /> He made changes — I'll enter the corrections
              </label>
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">Received back on</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-700 self-end pb-3">
                  <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> Signed by the MD
                </label>
              </div>
            </div>
          )}
          {kind === 'audit' && (
            <div className="liquid-glass-inset rounded-2xl p-3 mt-4 space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="audit-result" checked={auditResult === 'ok'} onChange={() => setAuditResult('ok')} /> Checked — OK
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="audit-result" checked={auditResult === 'note'} onChange={() => setAuditResult('note')} /> Found something — leave a note
              </label>
            </div>
          )}
          <div className="mt-4">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">{noteRequired ? (kind === 'audit' ? 'Audit note *' : 'What needs correcting? *') : 'Note (optional)'}</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} resize-none`} />
          </div>
        </>
      )}
    </Glass>
  );
};
