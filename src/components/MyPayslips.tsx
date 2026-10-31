/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Payslip (PayslipRoutes.ts, users.can_view_payslip):
// this account's own payslips for months Payroll has approved or paid, a
// year at a time. Tap a month for its breakdown; View / PDF give the same
// payslip PDF HR's Payroll -> Payslips makes (lib/payslipPdf.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ChevronDown, Eye, FileDown, ReceiptText } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { LoadingBlock } from './LoadingBlock';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { payslipRows } from '../lib/payslipRows';
import { buildSinglePayslip, money, monthLabel, type PayrollRecord } from '../lib/payslipPdf';
import { savePdfCrossPlatform } from '../lib/saveFile';

interface PayslipSummary {
  id: number;
  month_year: string;
  gross_earned: number;
  total_deduction: number;
  net_salary: number;
  payment_status: 'processed' | 'paid';
  payment_date: string | null;
  paid_at: string | null;
}
interface ListData {
  linked: boolean;
  employee?: { name: string; employee_code: string | null; designation: string | null; department: string | null };
  payslips: PayslipSummary[];
}

const dateText = (d: string | null) => (d ? new Date(String(d).length <= 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' }) : '');

export const MyPayslips: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [data, setData] = useState<ListData | null>(null);
  const [error, setError] = useState('');
  const [year, setYear] = useState<string>('');
  const [openId, setOpenId] = useState<number | null>(() => {
    try {
      const v = Number(sessionStorage.getItem('open_payslip_id') || 0);
      sessionStorage.removeItem('open_payslip_id');
      return v || null;
    } catch {
      return null;
    }
  });
  const [details, setDetails] = useState<Record<number, PayrollRecord>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const load = useCallback(() => {
    fetch(apiUrl('/api/my-payslips'), { headers })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
        setError('');
        setData(j);
      })
      .catch((e) => setError(e.message));
  }, [headers]);
  useEffect(load, [load]);
  useLiveRefresh(load);

  const years = useMemo(() => Array.from(new Set((data?.payslips || []).map((p) => p.month_year.slice(0, 4)))), [data]);
  // Start on the year of the payslip an alert opened, else the latest year.
  useEffect(() => {
    if (year || !data?.payslips.length) return;
    const fromAlert = openId ? data.payslips.find((p) => p.id === openId) : null;
    setYear((fromAlert || data.payslips[0]).month_year.slice(0, 4));
  }, [data, year, openId]);
  const shown = (data?.payslips || []).filter((p) => p.month_year.startsWith(year));
  const yearNet = shown.reduce((s, p) => s + p.net_salary, 0);

  const detail = useCallback(
    async (id: number): Promise<PayrollRecord> => {
      if (details[id]) return details[id];
      const r = await fetch(apiUrl(`/api/my-payslips/${id}`), { headers });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || 'Could not load this payslip.');
      setDetails((d) => ({ ...d, [id]: j }));
      return j;
    },
    [details, headers]
  );
  useEffect(() => {
    if (openId) detail(openId).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const pdf = async (id: number, mode: 'view' | 'download') => {
    setBusy(id);
    try {
      const rec = await detail(id);
      const doc = await buildSinglePayslip(rec);
      if (mode === 'view') window.open(doc.output('bloburl') as unknown as string, '_blank');
      else await savePdfCrossPlatform(doc, `Payslip_${rec.month_year}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-3xl">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Payslip']} />}
        <div className="flex items-center gap-2 mb-3">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <ReceiptText className="w-5 h-5 text-sky-600 shrink-0" /> My Payslip
          </h1>
        </div>

        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</div>}
        {!data && !error ? (
          <LoadingBlock />
        ) : data && !data.linked ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Your login isn't linked to an employee record yet, so there are no payslips to show.</div>
        ) : data && data.payslips.length === 0 ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">No payslips yet. A month shows here once Payroll has approved it.</div>
        ) : (
          data && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {years.map((y) => (
                  <button
                    key={y}
                    type="button"
                    onClick={() => setYear(y)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${y === year ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                  >
                    {y}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-600">
                {shown.length} payslip{shown.length === 1 ? '' : 's'} in {year} · net {money(yearNet)}
              </p>
              <ul className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                {shown.map((p) => {
                  const open = openId === p.id;
                  const d = details[p.id];
                  return (
                    <li key={p.id}>
                      <button type="button" onClick={() => setOpenId(open ? null : p.id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50" aria-expanded={open}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-slate-800">{monthLabel(p.month_year)}</span>
                          <span className="block text-[11px] text-slate-500">
                            {p.payment_status === 'paid' ? `Paid${p.payment_date || p.paid_at ? ` on ${dateText(p.payment_date || p.paid_at)}` : ''}` : 'Approved, payment pending'}
                          </span>
                        </span>
                        <span className="text-sm font-bold text-slate-900 whitespace-nowrap">{money(p.net_salary)}</span>
                        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="px-4 pb-4">
                          {!d ? (
                            <LoadingBlock rows={3} />
                          ) : (
                            <>
                              {/* Earnings | Deductions: side by side, stacked on a phone. */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {(
                                  [
                                    ['Earnings', 0, 'Gross Earned', d.gross_earned],
                                    ['Deductions', 2, 'Total Deduction', d.total_deduction]
                                  ] as const
                                ).map(([title, col, totalLabel, total]) => (
                                  <div key={title} className="rounded-xl border border-slate-200 overflow-hidden text-xs">
                                    <div className="px-3 py-2 bg-slate-50 text-slate-500 font-semibold">{title}</div>
                                    <ul className="divide-y divide-slate-100">
                                      {payslipRows(d, money)
                                        .filter((row) => row[col])
                                        .map((row, i) => (
                                          <li key={i} className="px-3 py-1.5 flex items-center justify-between gap-3">
                                            <span className="text-slate-700 min-w-0">{row[col]}</span>
                                            <span className="tabular-nums whitespace-nowrap">{row[col + 1]}</span>
                                          </li>
                                        ))}
                                    </ul>
                                    <div className="px-3 py-2 bg-slate-50 font-semibold flex items-center justify-between gap-3">
                                      <span>{totalLabel}</span>
                                      <span className="tabular-nums whitespace-nowrap">{money(total)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <p className="text-sm font-bold text-slate-900 mt-2">Net salary {money(d.net_salary)}</p>
                              <p className="text-[11px] text-slate-500 mt-2">
                                {d.present_days} present · {d.leave_days} leave · {d.absent_days} absent{Number(d.lwp_days) ? ` · ${d.lwp_days} LWP` : ''} of {d.total_working_days} working days
                                {d.remarks ? ` · ${d.remarks}` : ''}
                              </p>
                              <div className="flex items-center gap-2 mt-3">
                                <button type="button" onClick={() => pdf(p.id, 'view')} disabled={busy === p.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg disabled:opacity-50">
                                  {busy === p.id ? <Spinner size={14} /> : <Eye className="w-3.5 h-3.5" />} View
                                </button>
                                <button type="button" onClick={() => pdf(p.id, 'download')} disabled={busy === p.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50">
                                  {busy === p.id ? <Spinner size={14} /> : <FileDown className="w-3.5 h-3.5" />} PDF
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        )}
      </div>
    </div>
  );
};
