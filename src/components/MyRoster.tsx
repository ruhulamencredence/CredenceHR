/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Duty Roster (RosterRoutes.ts, users.can_view_roster):
// this account's own shifts and Off days, a month at a time. HR sets them in
// Admin Panel -> Duty Roster; a change brings an alert.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, CalendarRange, ChevronLeft, ChevronRight, Moon } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { shiftTime, type Shift } from '../lib/roster';

interface MyDay {
  date: string;
  weekday: number;
  is_off: boolean;
  shift: Shift | null;
  note: string | null;
  holiday: { title: string; type: string } | null;
}
interface MyRosterData {
  linked: boolean;
  from: string;
  to: string;
  today: string;
  days: MyDay[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${pad(new Date(y, m, 0).getDate())}` };
};
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

export const MyRoster: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [data, setData] = useState<MyRosterData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const { from, to } = monthRange(month);
    setError('');
    fetch(apiUrl(`/api/my-roster?from=${from}&to=${to}`), { headers: { Authorization: `Bearer ${token}` } })
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

  const todayRow = useMemo(() => data?.days.find((d) => d.date === data.today) || null, [data]);
  const counts = useMemo(() => {
    const c = { duty: 0, off: 0 };
    for (const d of data?.days || []) {
      if (d.is_off) c.off++;
      else if (d.shift) c.duty++;
    }
    return c;
  }, [data]);
  // Calendar cells, the week starting on Saturday.
  const cells = useMemo(() => {
    if (!data) return [];
    const lead = (data.days[0].weekday + 1) % 7;
    return [...Array.from({ length: lead }, () => null), ...data.days];
  }, [data]);

  const describe = (d: MyDay) =>
    d.is_off ? 'Off day' : d.shift ? `${d.shift.name} · ${shiftTime(d.shift)}` : d.holiday ? d.holiday.title : 'Regular office hours';

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Duty Roster']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2 flex-wrap">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <CalendarRange className="w-5 h-5 text-violet-600 shrink-0" /> My Duty Roster
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
          <div className="py-16 flex justify-center">
            <Spinner />
          </div>
        ) : data && !data.linked ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Your login isn't linked to an employee record yet, so there's no roster to show.</div>
        ) : (
          data && (
            <div className="space-y-4">
              {todayRow && (
                <div className="rounded-2xl bg-white border border-slate-200 p-4 flex items-center gap-3">
                  <span
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-bold shrink-0 ${todayRow.shift ? 'text-white' : 'bg-slate-100 text-slate-600'}`}
                    style={todayRow.shift ? { background: todayRow.shift.color } : undefined}
                  >
                    {todayRow.shift ? todayRow.shift.code : todayRow.is_off ? 'OFF' : todayRow.holiday ? (todayRow.holiday.type === 'weekend' ? 'W' : 'H') : '—'}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Today</div>
                    <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                      {describe(todayRow)}
                      {todayRow.shift?.crosses_midnight && <Moon className="w-3.5 h-3.5 text-indigo-500" aria-label="Night shift" />}
                    </div>
                  </div>
                </div>
              )}
              <p className="text-xs text-slate-600">
                {counts.duty} duty day{counts.duty === 1 ? '' : 's'} and {counts.off} Off day{counts.off === 1 ? '' : 's'} set this month. Days with nothing set follow the regular office hours and holiday calendar.
              </p>

              <div className="rounded-2xl bg-white border border-slate-200 p-2 sm:p-3">
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-slate-500 mb-1">
                  {[6, 0, 1, 2, 3, 4, 5].map((w) => (
                    <div key={w}>{WD[w]}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((d, i) =>
                    !d ? (
                      <div key={`b${i}`} />
                    ) : (
                      <div
                        key={d.date}
                        title={`${dayLabel(d.date)}: ${describe(d)}`}
                        className={`rounded-xl min-h-[3.75rem] p-1.5 flex flex-col items-center gap-1 ${d.date === data.today ? 'ring-2 ring-violet-500' : ''} ${d.shift ? '' : d.is_off || d.holiday ? 'bg-slate-50' : 'bg-white'}`}
                      >
                        <span className={`text-[11px] font-semibold ${d.date === data.today ? 'text-violet-700' : 'text-slate-600'}`}>{Number(d.date.slice(8))}</span>
                        {d.shift ? (
                          <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-white" style={{ background: d.shift.color }}>
                            {d.shift.code}
                          </span>
                        ) : d.is_off ? (
                          <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-slate-200 text-slate-600">OFF</span>
                        ) : d.holiday ? (
                          <span className="text-[10px] font-bold text-slate-400">{d.holiday.type === 'weekend' ? 'W' : 'H'}</span>
                        ) : null}
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
                {data.days
                  .filter((d) => d.shift || d.is_off)
                  .map((d) => (
                    <div key={d.date} className="px-4 py-2.5 flex items-center gap-3">
                      <span className="w-28 shrink-0 text-xs text-slate-500">
                        {WD[d.weekday]}, {Number(d.date.slice(8))} {new Date(`${d.date}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' })}
                      </span>
                      {d.shift ? (
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.shift.color }} />
                            <span className="text-sm font-semibold text-slate-800 truncate">{d.shift.name}</span>
                            {d.shift.crosses_midnight && <Moon className="w-3.5 h-3.5 text-indigo-500 shrink-0" aria-label="Night shift" />}
                          </span>
                          <span className="flex items-center gap-2 flex-wrap pl-[18px]">
                            <span className="text-xs text-slate-500 whitespace-nowrap">{shiftTime(d.shift)}</span>
                            {d.holiday && <span className="text-[10px] text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 whitespace-nowrap">on {d.holiday.title}</span>}
                          </span>
                        </span>
                      ) : (
                        <span className="text-sm font-semibold text-slate-500">Off day</span>
                      )}
                    </div>
                  ))}
                {!data.days.some((d) => d.shift || d.is_off) && <div className="px-4 py-6 text-center text-sm text-slate-500">Nothing set for this month — regular office hours apply.</div>}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
};
