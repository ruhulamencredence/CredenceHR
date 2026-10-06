/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval (PayrollApprovalRoutes.ts): a salary month goes
// HR (Submit for Audit) -> Audit (Approve / Return, Payroll layer
// "audit_approve") -> Accounts (Pay, layer "accounts_pay"). Shows where the
// month is, its totals, salaries on hold (left out), the history, and the
// payment sheet for the bank, and — once approved — Bank / MFS wise payment vouchers.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { CheckCircle2, ClipboardCheck, FileSpreadsheet, Landmark, Send, Undo2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';
import { PayrollPaymentVouchers } from './PayrollPaymentVouchers';

interface ApprovalState {
  month_year: string;
  status: 'draft' | 'submitted' | 'approved' | 'returned' | 'paid';
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
  };
  summary: { runs: number; total_net: number; payable_net: number; unpaid: number; processed: number; paid: number; held: number };
  held: { name: string; code: string | null; reason: string | null }[];
  events: { action: string; by: string | null; note: string | null; at: string }[];
  can: { submit: boolean; approve: boolean; return_: boolean; pay: boolean };
  is_submitter: boolean;
}

const tk = (n: number) => `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (v: string | null) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
};
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const ACTION_LABEL: Record<string, string> = {
  submitted: 'Submitted for Audit',
  approved: 'Approved by Audit',
  returned: 'Returned by Audit',
  paid: 'Paid by Accounts'
};
const STEPS = [
  { key: 'draft', label: 'HR prepares' },
  { key: 'submitted', label: 'With Audit' },
  { key: 'approved', label: 'With Accounts' },
  { key: 'paid', label: 'Paid' }
];

async function call<T>(token: string, path: string, body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Something went wrong.');
  return d as T;
}

export const PayrollApprovalPanel: React.FC<{ token: string; monthYear?: string }> = ({ token, monthYear }) => {
  // Follows the Payroll page's own month picker when given.
  const [ownMonth, setMonth] = useState(thisMonth());
  const month = monthYear || ownMonth;
  const [data, setData] = useState<ApprovalState | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'return' | 'pay' | 'submit' | 'approve'>(null);

  const load = useCallback(() => {
    setError('');
    call<ApprovalState>(token, `/api/payroll/approval/${month}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token, month]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const act = async (path: string, body: any, done: string) => {
    setBusy(true);
    setError('');
    try {
      await call(token, `/api/payroll/approval/${month}/${path}`, body);
      setMsg(done);
      setDialog(null);
      load();
    } catch (e: any) {
      setError(e.message);
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
      XLSX.writeFile(wb, `Salary-Payment-Sheet-${month}.xlsx`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const stepIndex = data ? (data.status === 'returned' ? 0 : STEPS.findIndex((s) => s.key === data.status)) : 0;
  const s = data?.summary;

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
        <button type="button" onClick={exportSheet} disabled={!s?.runs} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <FileSpreadsheet className="w-3.5 h-3.5" /> Payment sheet (Excel)
        </button>
      </div>

      {msg && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{msg}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      {!data ? (
        !error && (
          <div className="py-16 flex justify-center">
            <Spinner size={24} />
          </div>
        )
      ) : (
        <>
          {/* Where the month is */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto">
              {STEPS.map((st, i) => {
                const done = i < stepIndex || data.status === 'paid';
                const current = i === stepIndex && data.status !== 'paid';
                return (
                  <React.Fragment key={st.key}>
                    {i > 0 && <div className={`h-0.5 flex-1 min-w-4 ${i <= stepIndex ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center ${
                          done ? 'bg-emerald-500 text-white' : current ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                      </span>
                      <span className={`text-xs font-semibold ${current ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{st.label}</span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            {data.status === 'returned' && data.batch?.audit_note && (
              <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">
                <b>Returned by {data.batch.audited_by || 'Audit'}:</b> {data.batch.audit_note}
              </div>
            )}
            {data.status === 'paid' && data.batch && (
              <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800">
                Paid on {data.batch.payment_date} · {data.batch.payment_method}
                {data.batch.payment_reference ? ` · Ref ${data.batch.payment_reference}` : ''} · by {data.batch.paid_by}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
              {[
                ['Employees', s!.runs],
                ['Net total', tk(s!.total_net)],
                ['To pay', tk(s!.payable_net)],
                ['Approved', s!.processed],
                ['Paid', s!.paid]
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
                <button type="button" onClick={() => setDialog('submit')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700">
                  <Send className="w-3.5 h-3.5" /> Submit for Audit
                </button>
              )}
              {data.can.approve && (
                <button type="button" onClick={() => setDialog('approve')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
                  <ClipboardCheck className="w-3.5 h-3.5" /> Approve (Audit)
                </button>
              )}
              {data.can.return_ && (
                <button type="button" onClick={() => setDialog('return')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-white border border-amber-300 text-amber-700 hover:bg-amber-50">
                  <Undo2 className="w-3.5 h-3.5" /> Return to HR
                </button>
              )}
              {data.can.pay && (
                <button type="button" onClick={() => setDialog('pay')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700">
                  <Landmark className="w-3.5 h-3.5" /> Pay (Accounts)
                </button>
              )}
              {data.status === 'submitted' && data.is_submitter && !data.can.approve && (
                <span className="text-[11px] text-slate-500 self-center">You submitted this — someone else from Audit approves it.</span>
              )}
            </div>
            {(data.status === 'submitted' || data.status === 'approved') && (
              <p className="text-[11px] text-slate-400 mt-2">While Audit has it, this month's salaries can't be generated, edited or deleted.</p>
            )}
          </div>

          {/* Bank / MFS wise payment vouchers for Accounts (the software doesn't send money). */}
          {(data.status === 'approved' || data.status === 'paid') && s!.runs > 0 && (
            <PayrollPaymentVouchers token={token} month={month} paid={data.status === 'paid'} />
          )}

          {/* History */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="text-xs font-bold text-slate-700 mb-2">History</div>
            {data.events.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing yet for this month.</p>
            ) : (
              <ol className="space-y-2">
                {data.events.map((e, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${e.action === 'returned' ? 'bg-amber-500' : e.action === 'paid' ? 'bg-violet-500' : 'bg-emerald-500'}`} />
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

      {dialog && data && (
        <ApprovalDialog
          kind={dialog}
          month={month}
          summary={data.summary}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            if (dialog === 'submit') return act('submit', { note: v.note }, 'Submitted for audit. Audit has been notified.');
            if (dialog === 'approve') return act('approve', { note: v.note }, 'Approved. Accounts has been notified.');
            if (dialog === 'return') return act('return', { note: v.note }, 'Returned to HR.');
            if (!(await confirmDialog(`Pay ${data.summary.processed} salaries (${tk(data.summary.payable_net)}) for ${month}? This can't be undone.`))) return;
            return act('pay', { payment_date: v.date, payment_method: v.method, payment_reference: v.reference }, 'Paid. Employees have been notified.');
          }}
        />
      )}
    </div>
  );
};

const ApprovalDialog: React.FC<{
  kind: 'submit' | 'approve' | 'return' | 'pay';
  month: string;
  summary: ApprovalState['summary'];
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: { note: string; date: string; method: string; reference: string }) => void;
}> = ({ kind, month, summary, busy, onClose, onSubmit }) => {
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('Bank Transfer');
  const [reference, setReference] = useState('');
  const title = kind === 'submit' ? 'Submit for Audit' : kind === 'approve' ? 'Approve salary sheet' : kind === 'return' ? 'Return to HR' : 'Pay salary';
  const input = 'w-full text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-200 focus:outline-none';
  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">{title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {month} · {summary.runs} employees · {tk(summary.payable_net)} to pay{summary.held ? ` · ${summary.held} on hold left out` : ''}
              </p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {kind === 'pay' ? (
            <div className="liquid-glass-inset rounded-2xl p-3 mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">Payment date *</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">Paid by *</label>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className={input}>
                    {['Bank Transfer', 'Cheque', 'bKash / MFS', 'Cash', 'Mixed (as per sheet)'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Reference (bank advice / cheque no.)</label>
                <input value={reference} onChange={(e) => setReference(e.target.value)} className={input} />
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">{kind === 'return' ? 'What needs correcting? *' : 'Note (optional)'}</label>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${input} resize-none`} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-semibold text-slate-600 rounded-full hover:bg-black/5">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || (kind === 'return' && !note.trim()) || (kind === 'pay' && !date)}
              onClick={() => onSubmit({ note: note.trim(), date, method, reference: reference.trim() })}
              className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy && <Spinner size={14} />} {title}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
