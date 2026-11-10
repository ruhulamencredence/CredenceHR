/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Loan / Advance" (LoanRequestRoutes.ts,
// users.can_view_loan_request): apply for a loan or a salary advance, follow
// it through its approvers, and see each loan's installments and what's
// left. One request at a time, and not while a loan is still being repaid.

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, HandCoins, Plus, X } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { usePhoneHeaderTitle } from '../lib/headerPageTitle';
import { useIsPhone } from '../lib/useScrolling';
import { SelfCard, toneOfStatus } from './SelfCard';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { useKeyboardInset, scrollFocusedFieldIntoView } from '../lib/useKeyboardInset';
import { LoadingBlock } from './LoadingBlock';
import { LoanHistory, PlanPreview, methodLabel, monthName, shiftMonth, type LoanDetail } from './LoanPayoutPlan';

interface MyLoanRequest {
  id: number;
  kind: 'loan' | 'advance';
  total_amount: number;
  monthly_installment: number;
  installments: number | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  chain_status: string | null;
  step: { current: number; total: number } | null;
  waiting_on: string[];
  decision_remarks: string | null;
  created_at: string;
  decided_at: string | null;
}
interface MyLoan {
  id: number;
  total_amount: number;
  monthly_installment: number;
  paid_amount: number;
  remaining: number;
  reason: string | null;
  status: 'active' | 'completed';
  created_at: string;
  kind?: 'loan' | 'advance';
  // Paid out yet, how it's paid back, the months to come, history (LoanPlan.ts).
  disbursement_status?: LoanDetail['disbursement_status'];
  disbursed_at?: string | null;
  disbursement_method?: string | null;
  repay_start_month?: string | null;
  repay_mode?: LoanDetail['repay_mode'];
  skip_months?: string[];
  settle_month?: string | null;
  plan?: LoanDetail['plan'];
  events?: LoanDetail['events'];
}
interface MyLoansData {
  linked: boolean;
  gross_salary?: number | null;
  max_installments?: number;
  requests: MyLoanRequest[];
  loans: MyLoan[];
  can_request: boolean;
  blocked_reason: string | null;
}

const tk = (n: number | null | undefined) => `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const day = (v: string | null) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-50 text-amber-700' },
  approved: { label: 'Approved', cls: 'bg-emerald-50 text-emerald-700' },
  rejected: { label: 'Not approved', cls: 'bg-rose-50 text-rose-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500' }
};

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Something went wrong.');
  return d as T;
}

export const MyLoans: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  usePhoneHeaderTitle('My Loan / Advance');
  const isPhone = useIsPhone();
  const isNativeApp = Capacitor.isNativePlatform();
  const [data, setData] = useState<MyLoansData | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    setError('');
    call<MyLoansData>(token, '/api/my-loans')
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  // Live refresh: approvals show up without a page reload.
  useLiveRefresh(load);

  const cancel = async (r: MyLoanRequest) => {
    if (!(await confirmDialog(`Cancel your ${r.kind === 'advance' ? 'salary advance' : 'loan'} request of ${tk(r.total_amount)}?`))) return;
    try {
      await call(token, `/api/my-loans/requests/${r.id}/cancel`, { method: 'POST' });
      setMsg('Request cancelled.');
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
        {/* Phone: the title is in the header (usePhoneHeaderTitle) — no path or title row here. */}
        {!isNativeApp && <div className="hidden md:block"><ModulePath path={['Self Service', 'My Loan / Advance']} /></div>}
        <div className="flex items-center justify-end md:justify-between gap-3 mb-3 flex-wrap">
          <div className="hidden md:flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <HandCoins className="w-5 h-5 text-emerald-600 shrink-0" /> My Loan / Advance
            </h1>
          </div>
          {data?.linked && (
            <button
              type="button"
              disabled={!data.can_request}
              title={data.blocked_reason || undefined}
              onClick={() => setAsking(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" /> Apply
            </button>
          )}
        </div>

        {msg && <div className="mb-3 text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{msg}</div>}
        {error && <div className="mb-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

        {!data ? (
          !error && (
            <LoadingBlock />
          )
        ) : !data.linked ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{data.blocked_reason}</div>
        ) : (
          <div className="space-y-4">
            {!data.can_request && data.blocked_reason && (
              <div className="text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">{data.blocked_reason}</div>
            )}

            <section>
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">My loans</h2>
              {data.loans.length === 0 ? (
                <div className="rounded-2xl bg-white border border-slate-200 p-6 text-center text-sm text-slate-400">No loan or advance yet.</div>
              ) : (
                <div className={isPhone ? 'space-y-2.5' : 'grid sm:grid-cols-2 gap-3'}>
                  {data.loans.map((l) => {
                    const pct = l.total_amount > 0 ? Math.min(100, Math.round((l.paid_amount / l.total_amount) * 100)) : 0;
                    const left = l.monthly_installment > 0 ? Math.ceil(l.remaining / l.monthly_installment) : 0;
                    const repaid = l.status === 'completed' || l.remaining <= 0;
                    // Phone: the shared Directory-style card — green once
                    // repaid, amber while it is being paid back.
                    if (isPhone)
                      return (
                        <SelfCard
                          key={l.id}
                          tone={repaid ? 'green' : 'amber'}
                          lead="৳"
                          title={tk(l.total_amount)}
                          sub={`${day(l.created_at)}${l.reason ? ` · ${l.reason}` : ''}`}
                          chips={[
                            { label: repaid ? 'Repaid' : l.disbursement_status === 'pending' ? 'Waiting for payment' : 'Repaying', tone: repaid ? 'green' : 'amber' },
                            { label: `${tk(l.monthly_installment)}/month`, mono: true },
                            ...(l.remaining > 0 ? [{ label: `${left} left` }] : [])
                          ]}
                        >
                          <div className="h-1.5 rounded-full bg-white/70 overflow-hidden">
                            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between text-[11px] text-slate-600">
                            <span>Repaid {tk(l.paid_amount)}</span>
                            <span>Left {tk(l.remaining)}</span>
                          </div>
                          <LoanExtra l={l} />
                        </SelfCard>
                      );
                    return (
                      <div key={l.id} className="rounded-2xl bg-white border border-slate-200 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-lg font-bold">{tk(l.total_amount)}</div>
                            <div className="text-[11px] text-slate-500">
                              {day(l.created_at)}
                              {l.reason ? ` · ${l.reason}` : ''}
                            </div>
                          </div>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${l.status === 'completed' || l.remaining <= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
                            {l.status === 'completed' || l.remaining <= 0 ? 'Repaid' : l.disbursement_status === 'pending' ? 'Waiting for payment' : 'Repaying'}
                          </span>
                        </div>
                        <div className="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                          <div>
                            <div className="text-slate-400">Repaid</div>
                            <div className="font-semibold text-slate-800">{tk(l.paid_amount)}</div>
                          </div>
                          <div>
                            <div className="text-slate-400">Left</div>
                            <div className="font-semibold text-slate-800">{tk(l.remaining)}</div>
                          </div>
                          <div>
                            <div className="text-slate-400">Per month</div>
                            <div className="font-semibold text-slate-800">
                              {tk(l.monthly_installment)}
                              {l.remaining > 0 ? <span className="font-normal text-slate-400"> · {left} left</span> : null}
                            </div>
                          </div>
                        </div>
                        <LoanExtra l={l} />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">My requests</h2>
              {data.requests.length === 0 ? (
                <div className="rounded-2xl bg-white border border-slate-200 p-6 text-center text-sm text-slate-400">You haven't applied yet.</div>
              ) : (
                <div className={isPhone ? 'space-y-2.5' : 'rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100'}>
                  {data.requests.map((r) => {
                    const st = STATUS[r.status] || STATUS.pending;
                    if (isPhone) {
                      const tone = toneOfStatus(r.status);
                      return (
                        <SelfCard
                          key={r.id}
                          tone={tone}
                          lead="৳"
                          dot={r.status === 'pending' ? 'amber' : undefined}
                          title={`${r.kind === 'advance' ? 'Salary Advance' : 'Loan'} · ${tk(r.total_amount)}`}
                          sub={`${r.installments ? `${r.installments} × ${tk(r.monthly_installment)}` : `${tk(r.monthly_installment)} a month`} · applied ${day(r.created_at)}`}
                          chips={[{ label: st.label, tone }]}
                        >
                          {r.reason && <p className="text-xs text-slate-700">{r.reason}</p>}
                          {r.status === 'pending' && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] text-slate-600 min-w-0">
                                {r.step ? `Step ${r.step.current} of ${r.step.total}` : 'Final decision'}
                                {r.waiting_on.length ? ` · waiting on ${r.waiting_on.join(', ')}` : ''}
                              </span>
                              <button type="button" onClick={() => cancel(r)} className="shrink-0 px-3 py-1.5 rounded-full bg-white/70 text-[11px] font-semibold text-rose-600">
                                Cancel request
                              </button>
                            </div>
                          )}
                          {r.decision_remarks && r.status !== 'pending' && <p className="text-[11px] text-slate-600">Remarks: {r.decision_remarks}</p>}
                        </SelfCard>
                      );
                    }
                    return (
                      <div key={r.id} className="p-4">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-800">
                              {r.kind === 'advance' ? 'Salary Advance' : 'Loan'} · {tk(r.total_amount)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {r.installments ? `${r.installments} × ${tk(r.monthly_installment)} a month` : `${tk(r.monthly_installment)} a month`} · applied {day(r.created_at)}
                            </div>
                            {r.reason && <div className="text-xs text-slate-600 mt-1">{r.reason}</div>}
                          </div>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                        </div>
                        {r.status === 'pending' && (
                          <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                            <div className="text-[11px] text-slate-500">
                              {r.step ? `Step ${r.step.current} of ${r.step.total}` : 'Final decision'}
                              {r.waiting_on.length ? ` · waiting on ${r.waiting_on.join(', ')}` : ''}
                            </div>
                            <button type="button" onClick={() => cancel(r)} className="text-[11px] font-semibold text-rose-600 hover:underline">
                              Cancel request
                            </button>
                          </div>
                        )}
                        {r.decision_remarks && r.status !== 'pending' && <div className="mt-1 text-[11px] text-slate-500">Remarks: {r.decision_remarks}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      {asking && data && (
        <ApplyLoanModal
          token={token}
          maxInstallments={data.max_installments || 24}
          grossSalary={data.gross_salary ?? null}
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false);
            setMsg('Request sent. You will be notified at each step.');
            load();
          }}
        />
      )}
    </div>
  );
};

// Under each loan: paid out or still waiting, how it's paid back, the
// months to come, and (tap) its history.
const LoanExtra: React.FC<{ l: MyLoan }> = ({ l }) => {
  const [showHistory, setShowHistory] = useState(false);
  if (l.status === 'completed' || l.remaining <= 0) return null;
  const pending = l.disbursement_status === 'pending';
  const how = l.repay_mode === 'lump' ? 'All at once' : l.repay_mode === 'custom' ? 'Month by month' : `${tk(l.monthly_installment)} a month`;
  return (
    <div className="mt-2 space-y-1.5 text-[11px] text-slate-600">
      {pending ? (
        <p className="px-2.5 py-1.5 rounded-xl bg-amber-50 text-amber-800">Approved — Accounts will pay it to you. Nothing is taken from your salary until then.</p>
      ) : (
        <p>
          Paid to you {l.disbursed_at ? String(l.disbursed_at).slice(0, 10) : ''}
          {l.disbursement_method ? ` · ${methodLabel(l.disbursement_method)}` : ''}
        </p>
      )}
      <p>
        Repayment: {how}
        {l.repay_start_month ? ` · from ${monthName(l.repay_start_month)}` : pending ? ' · from the month after you are paid' : ''}
        {l.skip_months && l.skip_months.length ? ` · skipping ${l.skip_months.map(monthName).join(', ')}` : ''}
        {l.settle_month ? ` · rest in ${monthName(l.settle_month)}` : ''}
      </p>
      {l.plan && !pending && <PlanPreview plan={l.plan} />}
      {l.events && l.events.length > 0 && (
        <>
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-[11px] font-semibold text-emerald-700">
            {showHistory ? 'Hide history' : 'History'}
          </button>
          {showHistory && <LoanHistory events={l.events} />}
        </>
      )}
    </div>
  );
};

const ApplyLoanModal: React.FC<{ token: string; maxInstallments: number; grossSalary: number | null; onClose: () => void; onSaved: () => void }> = ({
  token,
  maxInstallments,
  grossSalary,
  onClose,
  onSaved
}) => {
  const [kind, setKind] = useState<'loan' | 'advance'>('loan');
  const [amount, setAmount] = useState('');
  const [installments, setInstallments] = useState('6');
  const [reason, setReason] = useState('');
  // Optional: start the installments from a later salary month.
  const thisMonth = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
  const [startMonth, setStartMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keyboardInset = useKeyboardInset();
  const n = Math.max(1, Math.min(maxInstallments, Math.round(Number(installments) || 1)));
  const per = Number(amount) > 0 ? Math.ceil((Number(amount) / n) * 100) / 100 : 0;
  const inputCls = 'w-full text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-200 focus:outline-none';

  const submit = async () => {
    setError('');
    if (!(Number(amount) > 0)) return setError('Enter the amount you need.');
    if (!reason.trim()) return setError('Write what you need it for.');
    setBusy(true);
    try {
      await call(token, '/api/my-loans/requests', { method: 'POST', body: JSON.stringify({ kind, total_amount: Number(amount), installments: n, reason: reason.trim(), preferred_start_month: startMonth || null }) });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-kb-self="" className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" style={keyboardInset ? { paddingBottom: keyboardInset + 8 } : undefined} onClick={onClose}>
      <div className="w-full max-w-md max-h-full flex" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 w-full overflow-y-auto" onFocusCapture={scrollFocusedFieldIntoView}>
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <HandCoins className="w-4 h-4 text-emerald-600" /> Apply for a loan / advance
            </h3>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="liquid-glass-inset rounded-2xl p-1 mt-4 grid grid-cols-2 gap-1">
            {(['loan', 'advance'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  if (k === 'advance') setInstallments('1');
                }}
                className={`text-xs font-semibold py-2 rounded-xl ${kind === k ? 'bg-emerald-600 text-white' : 'text-slate-600'}`}
              >
                {k === 'loan' ? 'Loan' : 'Salary Advance'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Amount (৳) *</label>
              <input type="number" min="1" step="1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Repay in (months) *</label>
              <input type="number" min="1" max={maxInstallments} step="1" value={installments} onChange={(e) => setInstallments(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            {per > 0 ? (
              <>
                {tk(per)} a month for {n} month{n === 1 ? '' : 's'}, taken from your salary.
                {grossSalary ? ` (${Math.round((per / grossSalary) * 100)}% of your monthly gross ${tk(grossSalary)})` : ''}
              </>
            ) : (
              `Up to ${maxInstallments} monthly installments.`
            )}
          </div>
          <div className="mt-3">
            <label htmlFor="loan-start" className="block text-[11px] font-semibold text-slate-500 mb-1">Start the installments from (optional)</label>
            <input id="loan-start" type="month" min={thisMonth} max={shiftMonth(thisMonth, 12)} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className={inputCls} />
            <p className="text-[10px] text-slate-400 mt-1">Leave empty to start the month after you are paid. HR / Accounts set the final plan.</p>
          </div>
          <div className="mt-3">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">What is it for? *</label>
            <textarea rows={3} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Family medical treatment" className={`${inputCls} resize-none`} />
          </div>
          {error && <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-semibold text-slate-600 rounded-full hover:bg-black/5">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={submit} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
              {busy && <Spinner size={14} />} Send request
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
