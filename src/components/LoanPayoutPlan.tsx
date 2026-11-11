/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Loans & Advances: the three popups for one loan (LoanPlan.ts):
//   PayOutModal  — Accounts gives the money: date, how, reference, and the
//                  month installments start (Payroll "Accounts Pay" layer).
//   PlanModal    — how it's paid back: start month, equal / all at once /
//                  month by month, months to skip, take all that's left in a
//                  month; the months to come and the loan's history.
//   RepayModal   — paid back outside the salary (Accounts Pay layer).
// Liquid-glass popups (CLAUDE.md).

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

export interface LoanLite {
  id: number;
  employee_name: string;
  total_amount: number;
  monthly_installment: number;
  paid_amount: number;
  remaining_amount: number;
  kind?: 'loan' | 'advance';
  repay_start_month?: string | null;
}

export interface LoanDetail {
  disbursement_status: 'pending' | 'paid';
  disbursed_at: string | null;
  disbursement_method: string | null;
  disbursement_reference: string | null;
  repay_start_month: string | null;
  repay_mode: 'equal' | 'lump' | 'custom';
  repay_schedule: Record<string, number>;
  skip_months: string[];
  settle_month: string | null;
  plan: { months: { month: string; amount: number }[]; unscheduled: number };
  events: { id?: number; event: string; amount: number | null; event_date: string | null; method: string | null; reference: string | null; note: string | null; created_at: string; by_name?: string | null }[];
}

export const PAY_METHODS: { value: string; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'mfs', label: 'bKash / Nagad' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' }
];
export const methodLabel = (m: string | null | undefined) => PAY_METHODS.find((x) => x.value === m)?.label || m || '';
// A Payroll amount the server hid ("See salary amounts", payrollAmountMask.ts)
// stays hidden; an employee's own figures are never hidden.
export const money = (n: number | null | undefined) =>
  (n as unknown) === '*****' ? '*****' : `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
export const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const monthName = (ym: string | null | undefined) => {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return '—';
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
export const EVENT_LABEL: Record<string, string> = {
  created: 'Logged by HR',
  approved: 'Approved',
  disbursed: 'Paid out to the employee',
  plan: 'Repayment plan changed',
  salary: 'Taken from salary',
  repaid: 'Paid back (outside salary)'
};

const field = 'w-full text-sm px-3 py-2.5 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400';
const labelCls = 'block text-xs font-semibold text-slate-600 mt-3 mb-1';

const Shell: React.FC<{ title: string; sub: string; onClose: () => void; children: React.ReactNode; wide?: boolean }> = ({ title, sub, onClose, children, wide }) =>
  createPortal(
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-3 pointer-events-none">
        <div className={`pointer-events-auto w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
          <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-slate-900">{title}</h3>
                <p className="text-xs text-slate-500">{sub}</p>
              </div>
              <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );

const Footer: React.FC<{ onClose: () => void; onSave: () => void; saving: boolean; label: string; error: string }> = ({ onClose, onSave, saving, label, error }) => (
  <>
    {error && <p className="mt-3 text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</p>}
    <div className="flex justify-end gap-2 mt-4">
      <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold">
        Cancel
      </button>
      <button type="button" onClick={onSave} disabled={saving} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-bold disabled:opacity-60 flex items-center gap-1.5">
        {saving && <Spinner size={14} />} {label}
      </button>
    </div>
  </>
);

async function send(url: string, method: string, headers: Record<string, string>, body: any) {
  const res = await fetch(apiUrl(url), { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// Date, how, reference and note — shared by paying out and paying back.
const PaymentFields: React.FC<{
  date: string;
  setDate: (v: string) => void;
  method: string;
  setMethod: (v: string) => void;
  reference: string;
  setReference: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
}> = ({ date, setDate, method, setMethod, reference, setReference, note, setNote }) => (
  <>
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label htmlFor="lp-date" className={labelCls}>Date</label>
        <input id="lp-date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} className={field} />
      </div>
      <div>
        <label htmlFor="lp-method" className={labelCls}>How</label>
        <select id="lp-method" value={method} onChange={(e) => setMethod(e.target.value)} className={field}>
          <option value="">— Choose —</option>
          {PAY_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
    </div>
    <label htmlFor="lp-ref" className={labelCls}>
      Reference {method === 'bank' || method === 'mfs' || method === 'cheque' ? '(transaction / cheque no.)' : '(optional)'}
    </label>
    <input id="lp-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={field} />
    <label htmlFor="lp-note" className={labelCls}>Note (optional)</label>
    <input id="lp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} />
  </>
);

export const PayOutModal: React.FC<{ loan: LoanLite; authHeaders: Record<string, string>; onClose: () => void; onDone: () => void }> = ({ loan, authHeaders, onClose, onDone }) => {
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const defaultStart = useMemo(() => {
    const next = shiftMonth(date.slice(0, 7), 1);
    return loan.repay_start_month && loan.repay_start_month > next ? loan.repay_start_month : next;
  }, [date, loan.repay_start_month]);
  const [start, setStart] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    setSaving(true);
    try {
      await send(`/api/payroll/advances/${loan.id}/disburse`, 'POST', authHeaders, { date, method, reference, note, start_month: start || defaultStart });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };
  return (
    <Shell title="Mark as paid out" sub={`${loan.employee_name} · ${loan.kind === 'loan' ? 'Loan' : 'Salary Advance'} of ${money(loan.total_amount)}`} onClose={onClose}>
      <PaymentFields {...{ date, setDate, method, setMethod, reference, setReference, note, setNote }} />
      <label htmlFor="lp-start" className={labelCls}>Installments start from (salary month)</label>
      <input id="lp-start" type="month" min={date.slice(0, 7)} value={start || defaultStart} onChange={(e) => setStart(e.target.value)} className={field} />
      <p className="text-[11px] text-slate-500 mt-1">
        {money(loan.monthly_installment)} a month. The plan can be changed later (Plan button).
      </p>
      <Footer onClose={onClose} onSave={() => void save()} saving={saving} label="Mark as paid" error={error} />
    </Shell>
  );
};

export const RepayModal: React.FC<{ loan: LoanLite; authHeaders: Record<string, string>; onClose: () => void; onDone: () => void }> = ({ loan, authHeaders, onClose, onDone }) => {
  const remaining = Number(loan.remaining_amount) || 0;
  const [amount, setAmount] = useState(String(remaining));
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    setSaving(true);
    try {
      await send(`/api/payroll/advances/${loan.id}/repay`, 'POST', authHeaders, { amount: Number(amount), date, method, reference, note });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };
  return (
    <Shell title="Paid back outside salary" sub={`${loan.employee_name} · ${money(remaining)} left`} onClose={onClose}>
      <label htmlFor="lp-amt" className={labelCls}>Amount received</label>
      <input id="lp-amt" type="number" inputMode="decimal" min={0} max={remaining} value={amount} onChange={(e) => setAmount(e.target.value)} className={field} autoComplete="off" />
      <PaymentFields {...{ date, setDate, method, setMethod, reference, setReference, note, setNote }} />
      <Footer onClose={onClose} onSave={() => void save()} saving={saving} label="Record repayment" error={error} />
    </Shell>
  );
};

export const LoanHistory: React.FC<{ events: LoanDetail['events'] }> = ({ events }) =>
  events.length === 0 ? null : (
    <ul className="liquid-glass-inset rounded-2xl divide-y divide-slate-100 text-xs">
      {events.map((e, i) => (
        <li key={e.id ?? i} className="px-3 py-2">
          <div className="flex justify-between gap-2">
            <span className="font-semibold text-slate-700">{EVENT_LABEL[e.event] || e.event}</span>
            {e.amount != null && <span className="text-slate-700">{money(e.amount)}</span>}
          </div>
          <p className="text-[11px] text-slate-500">
            {(e.event_date || e.created_at || '').slice(0, 10)}
            {e.method ? ` · ${methodLabel(e.method)}` : ''}
            {e.reference ? ` · ref. ${e.reference}` : ''}
            {e.by_name ? ` · ${e.by_name}` : ''}
          </p>
          {e.note && <p className="text-[11px] text-slate-600">{e.note}</p>}
        </li>
      ))}
    </ul>
  );

export const PlanPreview: React.FC<{ plan: LoanDetail['plan']; pending?: boolean }> = ({ plan, pending }) =>
  pending ? (
    <p className="text-xs text-slate-500">Nothing is taken from the salary until it is paid out.</p>
  ) : plan.months.length === 0 && !plan.unscheduled ? (
    <p className="text-xs text-slate-500">Nothing left to take.</p>
  ) : (
    <div className="liquid-glass-inset rounded-2xl p-2">
      <div className="flex flex-wrap gap-1.5">
        {plan.months.map((m) => (
          <span key={m.month} className="text-[11px] px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-700">
            {monthName(m.month)} · <b>{money(m.amount)}</b>
          </span>
        ))}
      </div>
      {plan.unscheduled > 0 && <p className="text-[11px] text-rose-600 mt-1.5">{money(plan.unscheduled)} isn't in any month yet.</p>}
    </div>
  );

export const PlanModal: React.FC<{ loan: LoanLite; authHeaders: Record<string, string>; onClose: () => void; onDone: () => void }> = ({ loan, authHeaders, onClose, onDone }) => {
  const [detail, setDetail] = useState<LoanDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<'equal' | 'lump' | 'custom'>('equal');
  const [start, setStart] = useState('');
  const [installment, setInstallment] = useState(String(loan.monthly_installment));
  const [rows, setRows] = useState<{ month: string; amount: string }[]>([]);
  const [skips, setSkips] = useState<string[]>([]);
  const [skipPick, setSkipPick] = useState('');
  const [settle, setSettle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const remaining = Number(loan.remaining_amount) || 0;
  const thisMonth = today().slice(0, 7);

  useEffect(() => {
    fetch(apiUrl(`/api/payroll/advances/${loan.id}/detail`), { headers: authHeaders })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load this loan.');
        setDetail(d);
        setMode(d.repay_mode || 'equal');
        setStart(d.repay_start_month || '');
        setSkips(d.skip_months || []);
        setSettle(d.settle_month || '');
        const sched = Object.entries(d.repay_schedule || {}) as [string, number][];
        setRows(
          sched.length
            ? sched.sort().map(([month, amount]) => ({ month, amount: String(amount) }))
            : [{ month: d.repay_start_month && d.repay_start_month > thisMonth ? d.repay_start_month : thisMonth, amount: String(remaining) }]
        );
      })
      .catch((e) => setLoadError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.id]);

  const customSum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const save = async () => {
    setError('');
    setSaving(true);
    try {
      const schedule: Record<string, number> = {};
      for (const r of rows) if (r.month && Number(r.amount) > 0) schedule[r.month] = (schedule[r.month] || 0) + Number(r.amount);
      await send(`/api/payroll/advances/${loan.id}/plan`, 'PUT', authHeaders, {
        repay_mode: mode,
        repay_start_month: start || null,
        monthly_installment: Number(installment),
        repay_schedule: mode === 'custom' ? schedule : null,
        skip_months: skips,
        settle_month: settle || null
      });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  const modeBtn = (m: typeof mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={`flex-1 px-2 py-2 rounded-xl text-xs font-semibold border ${mode === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}
    >
      {label}
    </button>
  );

  return (
    <Shell title="Repayment plan" sub={`${loan.employee_name} · ${money(remaining)} left of ${money(loan.total_amount)}`} onClose={onClose} wide>
      {loadError ? (
        <p className="mt-3 text-xs text-rose-600">{loadError}</p>
      ) : !detail ? (
        <div className="py-10 flex justify-center">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          {detail.disbursement_status === 'pending' ? (
            <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">Not paid out yet — nothing is taken from the salary until Accounts marks it paid.</p>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              Paid out {detail.disbursed_at?.slice(0, 10)} · {methodLabel(detail.disbursement_method)}
              {detail.disbursement_reference ? ` · ref. ${detail.disbursement_reference}` : ''}
            </p>
          )}

          <label htmlFor="lp-pstart" className={labelCls}>Start taking from (salary month)</label>
          <input id="lp-pstart" type="month" value={start} onChange={(e) => setStart(e.target.value)} className={field} />

          <p className={labelCls}>How</p>
          <div className="flex gap-2">
            {modeBtn('equal', 'Equal installments')}
            {modeBtn('lump', 'All at once')}
            {modeBtn('custom', 'Month by month')}
          </div>

          {mode === 'equal' && (
            <>
              <label htmlFor="lp-inst" className={labelCls}>Each month</label>
              <input id="lp-inst" type="number" inputMode="decimal" min={0} value={installment} onChange={(e) => setInstallment(e.target.value)} className={field} autoComplete="off" />
              {Number(installment) > 0 && <p className="text-[11px] text-slate-500 mt-1">About {Math.ceil(remaining / Number(installment))} month(s) for {money(remaining)}.</p>}
            </>
          )}
          {mode === 'lump' && <p className="text-[11px] text-slate-500 mt-2">Everything left ({money(remaining)}) is taken from the start month's salary.</p>}
          {mode === 'custom' && (
            <div className="mt-2 space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="month" aria-label={`Month ${i + 1}`} value={r.month} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)))} className={field} />
                  <input type="number" inputMode="decimal" aria-label={`Amount for month ${i + 1}`} min={0} value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={field} autoComplete="off" />
                  <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="w-9 h-9 shrink-0 rounded-full text-rose-500 hover:bg-rose-50 flex items-center justify-center" aria-label={`Remove month ${i + 1}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setRows([...rows, { month: rows.length ? shiftMonth(rows[rows.length - 1].month || thisMonth, 1) : thisMonth, amount: '' }])}
                  className="text-xs font-semibold text-blue-600 flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Add month
                </button>
                <span className={`text-[11px] font-semibold ${Math.abs(customSum - remaining) < 0.01 ? 'text-emerald-700' : 'text-rose-600'}`}>
                  {money(customSum)} of {money(remaining)}
                </span>
              </div>
            </div>
          )}

          {mode !== 'lump' && (
            <>
              <label htmlFor="lp-skip" className={labelCls}>Skip months (nothing taken)</label>
              <div className="flex gap-2">
                <input id="lp-skip" type="month" value={skipPick} onChange={(e) => setSkipPick(e.target.value)} className={field} />
                <button
                  type="button"
                  disabled={!skipPick || skips.includes(skipPick)}
                  onClick={() => {
                    setSkips([...skips, skipPick].sort());
                    setSkipPick('');
                  }}
                  className="liquid-glass-chip rounded-full px-4 text-sm font-semibold disabled:opacity-50 shrink-0"
                >
                  Add
                </button>
              </div>
              {skips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {skips.map((m) => (
                    <span key={m} className="text-[11px] px-2 py-1 rounded-lg bg-amber-50 text-amber-800 flex items-center gap-1">
                      {monthName(m)}
                      <button type="button" onClick={() => setSkips(skips.filter((x) => x !== m))} aria-label={`Don't skip ${monthName(m)}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          <label htmlFor="lp-settle" className={labelCls}>Take everything left in (optional — paying it off early)</label>
          <div className="flex gap-2">
            <input id="lp-settle" type="month" value={settle} onChange={(e) => setSettle(e.target.value)} className={field} />
            {settle && (
              <button type="button" onClick={() => setSettle('')} className="liquid-glass-chip rounded-full px-4 text-sm font-semibold shrink-0">
                Clear
              </button>
            )}
          </div>

          <p className={labelCls}>Months to come (saved plan)</p>
          <PlanPreview plan={detail.plan} pending={detail.disbursement_status === 'pending'} />
          <p className="text-[11px] text-slate-500 mt-1">A salary already made for a month keeps its amount — edit or remake that salary to use the new plan.</p>

          {detail.events.length > 0 && (
            <>
              <p className={labelCls}>History</p>
              <LoanHistory events={detail.events} />
            </>
          )}
          <Footer onClose={onClose} onSave={() => void save()} saving={saving} label="Save plan" error={error} />
        </>
      )}
    </Shell>
  );
};
