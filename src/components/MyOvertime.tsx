/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My OT (OvertimeRoutes.ts, users.can_view_my_ot): this
// account's own overtime, a month at a time — worked out from their check-in /
// out (or the site muster), what is approved and what still waits. Hours only;
// the money is on the payslip.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ChevronLeft, ChevronRight, Timer } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { usePhoneHeaderTitle } from '../lib/headerPageTitle';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { LoadingBlock } from './LoadingBlock';
import { hoursText, otStatusLabel, otStatusTone, timeOnly } from '../lib/overtime';

interface MyOtEntry {
  date: string;
  day_kind: 'normal' | 'off';
  in_at: string | null;
  out_at: string | null;
  calc_minutes: number;
  approved_minutes: number;
  status: string;
}
interface MyOtData {
  linked: boolean;
  gets_ot?: boolean;
  month: string;
  approved_minutes?: number;
  waiting_minutes?: number;
  entries: MyOtEntry[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export const MyOvertime: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  usePhoneHeaderTitle('My OT');
  const isNativeApp = Capacitor.isNativePlatform();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [data, setData] = useState<MyOtData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    fetch(apiUrl(`/api/my-ot?month=${month}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
        setData(j);
      })
      .catch((e) => setError(e.message));
  }, [token, month]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLiveRefresh(load);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl">
        {!isNativeApp && <div className="hidden md:block"><ModulePath path={['Self Service', 'My OT']} /></div>}
        <div className="flex items-center justify-end md:justify-between gap-3 mb-3 flex-wrap">
          <div className="hidden md:flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <Timer className="w-5 h-5 text-orange-600 shrink-0" /> My OT
            </h1>
          </div>
          <div className="inline-flex items-center rounded-xl bg-white border border-slate-200">
            <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="p-2 hover:bg-slate-50 rounded-l-xl" aria-label="Previous month">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2 text-sm font-semibold text-slate-800 min-w-[8.5rem] text-center">{monthLabel(month)}</span>
            <button type="button" onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-2 hover:bg-slate-50 rounded-r-xl" aria-label="Next month">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</div>}
        {!data && !error ? (
          <LoadingBlock />
        ) : data && !data.linked ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Your login isn't linked to an employee record yet, so there's no overtime to show.</div>
        ) : (
          data && (
            <div className="space-y-3">
              {!data.gets_ot && (
                <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
                  Overtime isn't paid for your position. Extra time still shows here for your own record.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-white border border-slate-200 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Approved</div>
                  <div className="text-2xl font-bold text-emerald-700">{hoursText(data.approved_minutes || 0)}</div>
                </div>
                <div className="rounded-2xl bg-white border border-slate-200 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Waiting for approval</div>
                  <div className="text-2xl font-bold text-amber-600">{hoursText(data.waiting_minutes || 0)}</div>
                </div>
              </div>
              <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
                {data.entries.map((e) => (
                  <div key={e.date} className="px-4 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-800">
                        {dayLabel(e.date)}
                        {e.day_kind === 'off' && <span className="ml-2 text-[10px] font-bold text-amber-700 bg-amber-50 rounded px-1.5 py-0.5">Off day</span>}
                      </div>
                      <div className="text-xs text-slate-500">
                        {timeOnly(e.in_at)} → {timeOnly(e.out_at)} · worked out {hoursText(e.calc_minutes)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-slate-800">{hoursText(e.status === 'not_eligible' ? 0 : e.approved_minutes)}</div>
                      <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${otStatusTone(e.status)}`}>{otStatusLabel(e.status)}</span>
                    </div>
                  </div>
                ))}
                {!data.entries.length && <div className="px-4 py-8 text-center text-sm text-slate-500">No overtime this month.</div>}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
};
