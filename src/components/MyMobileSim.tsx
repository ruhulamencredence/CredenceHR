/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Mobile SIM (MobileBillRoutes.ts): the company SIMs given
// to me, each one's monthly limit and bills, and my requests for a higher
// limit (through the approval chain to HR). Shown only to accounts with
// users.can_view_mobile_bill (Module Access) or the mobile_bill module.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Plus, Smartphone, TrendingUp } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { LimitRequestForm, MbRequest, MbSim, mbApi, monthLabel, OperatorBadge, requestStage, StatusPill, tk } from './MobileBillParts';
import { confirmDialog } from '../lib/confirmDialog';

type MySim = MbSim & { bills: { month: string; amount: number; limit_amount: number }[] };

export const MyMobileSim: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [data, setData] = useState<{ sims: MySim[]; requests: MbRequest[] } | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<number | null>(null);

  const load = useCallback(() => {
    mbApi(token, '/api/mobile-bill/my')
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (id: number) => {
    if (!(await confirmDialog('Cancel this request?'))) return;
    try {
      await mbApi(token, `/api/mobile-bill/my/requests/${id}/cancel`, 'POST');
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl mx-auto">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Mobile SIM']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2 flex-wrap">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <Smartphone className="w-5 h-5 text-teal-600 shrink-0" /> My Mobile SIM
            </h1>
          </div>
          {!!data?.sims.some((s) => s.status === 'active') && (
            <button type="button" onClick={() => setAsking(0)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700">
              <TrendingUp className="w-3.5 h-3.5" /> Higher limit
            </button>
          )}
        </div>

        {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
        {!data ? (
          <div className="py-10 flex justify-center">
            <Spinner size={24} />
          </div>
        ) : (
          <>
            {data.sims.length === 0 && <p className="text-sm text-slate-500 py-8 text-center">No company SIM is given to you yet.</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {data.sims.map((s) => {
                const last = s.bills[0];
                const pct = last ? Math.round((last.amount / Math.max(1, last.limit_amount)) * 100) : 0;
                return (
                  <div key={s.id} className={`rounded-2xl bg-white border border-slate-200 p-4 ${s.status !== 'active' ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-lg font-bold tracking-wide">{s.phone_number}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <OperatorBadge op={s.operator} />
                          <span className="text-[11px] text-slate-500">Postpaid{s.status !== 'active' ? ' · turned off' : ''}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-semibold text-slate-500">Monthly limit</div>
                        <div className="text-xl font-bold text-teal-700">{tk(s.limit_amount)}</div>
                      </div>
                    </div>
                    {last && (
                      <div className="mt-3">
                        <div className="flex justify-between text-[11px] text-slate-500">
                          <span>{monthLabel(last.month)} bill</span>
                          <span className={last.amount > last.limit_amount ? 'text-rose-600 font-semibold' : ''}>
                            {tk(last.amount)} of {tk(last.limit_amount)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100 mt-1 overflow-hidden">
                          <div className={`h-full rounded-full ${pct > 100 ? 'bg-rose-500' : pct > 80 ? 'bg-amber-500' : 'bg-teal-500'}`} style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                        {last.amount > last.limit_amount && (
                          <p className="text-[11px] text-rose-600 mt-1">{tk(last.amount - last.limit_amount)} over the limit.</p>
                        )}
                      </div>
                    )}
                    {s.bills.length > 0 ? (
                      <div className="mt-3 border-t border-slate-100 pt-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-400">
                              <th className="text-left font-semibold py-1">Month</th>
                              <th className="text-right font-semibold">Limit</th>
                              <th className="text-right font-semibold">Bill</th>
                              <th className="text-right font-semibold">Over</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.bills.slice(0, 6).map((b) => (
                              <tr key={b.month} className="border-t border-slate-50">
                                <td className="py-1">{monthLabel(b.month, true)}</td>
                                <td className="text-right">{tk(b.limit_amount)}</td>
                                <td className="text-right font-semibold">{tk(b.amount)}</td>
                                <td className={`text-right ${b.amount > b.limit_amount ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                                  {b.amount > b.limit_amount ? tk(b.amount - b.limit_amount) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-400 mt-3">No bill yet.</p>
                    )}
                    {s.status === 'active' && (
                      <button type="button" onClick={() => setAsking(s.id)} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:underline">
                        <Plus className="w-3.5 h-3.5" /> Ask for a higher limit
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {data.requests.length > 0 && (
              <div className="mt-6">
                <h2 className="text-sm font-bold text-slate-700 mb-2">My limit requests</h2>
                <div className="space-y-2">
                  {data.requests.map((r) => (
                    <div key={r.id} className="rounded-2xl bg-white border border-slate-200 p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold">
                            {r.phone_number}: {tk(r.current_limit)} → {tk(r.requested_limit)}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {r.scope === 'permanent' ? `From ${monthLabel(r.for_month)} on` : `${monthLabel(r.for_month)} only`} · {r.reason}
                          </div>
                        </div>
                        <StatusPill status={r.status} />
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[11px] text-slate-500">
                          {requestStage(r)}
                          {r.decision_note ? ` — ${r.decision_note}` : ''}
                        </span>
                        {r.status === 'pending' && (
                          <button type="button" onClick={() => cancel(r.id)} className="text-[11px] font-semibold text-rose-600 hover:underline">
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {asking !== null && data && (
        <LimitRequestForm
          token={token}
          sims={data.sims}
          defaultSimId={asking || undefined}
          onClose={() => setAsking(null)}
          onDone={() => {
            setAsking(null);
            load();
          }}
        />
      )}
    </div>
  );
};
