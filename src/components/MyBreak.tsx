/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> Break Time (BreakRoutes.ts, users.can_take_break): start
// and end a break, with today's breaks and how much of the day's allowance
// is left. HR sees everyone's in Admin Panel -> Break Time.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Coffee, Play, Square } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { LoadingBlock } from './LoadingBlock';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';

interface MyBreakRow {
  id: number;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  open: boolean;
  minutes: number;
  seconds: number;
}
interface MyBreakDay {
  today: string;
  rules: { allowed_minutes: number; max_breaks: number };
  breaks: MyBreakRow[];
  open: MyBreakRow | null;
  used_minutes: number;
  remaining_minutes: number;
  over_minutes: number;
}

// "2026-10-20 13:05:00" (or an ISO string) -> "1:05 PM".
export const clockTime = (v: string | null) => {
  if (!v) return '';
  const m = String(v).match(/[T ](\d{2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};
export const minutesLabel = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`);
const pad = (n: number) => String(n).padStart(2, '0');
const stopwatch = (sec: number) => `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;

export const MyBreak: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [data, setData] = useState<MyBreakDay | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = useCallback(
    async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(apiUrl(path), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
      setData(j);
      setLoadedAt(Date.now());
    },
    [token]
  );
  const load = useCallback(() => {
    setError('');
    call('/api/breaks/me').catch((e) => setError(e.message));
  }, [call]);
  useEffect(load, [load]);
  useLiveRefresh(load);

  // The running clock of a break in progress.
  useEffect(() => {
    if (!data?.open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [data?.open]);

  const act = async (what: 'start' | 'end') => {
    setBusy(true);
    setError('');
    try {
      await call(`/api/breaks/${what}`, 'POST', what === 'start' && note.trim() ? { note: note.trim() } : undefined);
      if (what === 'start') setNote('');
    } catch (e: any) {
      setError(e.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const openSeconds = data?.open ? data.open.seconds + Math.max(0, Math.floor((now - loadedAt) / 1000)) : 0;
  const usedNow = data ? data.used_minutes - (data.open?.minutes || 0) + (data.open ? Math.ceil(openSeconds / 60) : 0) : 0;
  const allowed = data?.rules.allowed_minutes || 0;
  const over = Math.max(0, usedNow - allowed);
  const pct = allowed ? Math.min(100, Math.round((usedNow / allowed) * 100)) : 0;
  const breaksLeft = data ? Math.max(0, data.rules.max_breaks - data.breaks.length) : 0;

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-2xl">
        {!isNativeApp && <ModulePath path={['Self Service', 'Break Time']} />}
        <div className="flex items-center gap-2 mb-4 mt-2">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <Coffee className="w-5 h-5 text-violet-600 shrink-0" /> Break Time
          </h1>
        </div>

        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</div>}
        {!data && !error ? (
          <LoadingBlock />
        ) : (
          data && (
            <div className="space-y-4">
              <div className={`rounded-3xl border p-5 text-center ${data.open ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
                {data.open ? (
                  <>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-700">On a break since {clockTime(data.open.started_at)}</div>
                    <div className="text-4xl font-bold tabular-nums text-slate-900 mt-2">{stopwatch(openSeconds)}</div>
                    {data.open.note && <div className="text-xs text-slate-500 mt-1">{data.open.note}</div>}
                    <button
                      type="button"
                      onClick={() => act('end')}
                      disabled={busy}
                      className="mt-4 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50"
                    >
                      <Square className="w-4 h-4" /> End break
                    </button>
                  </>
                ) : (
                  <>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Not on a break</div>
                    {breaksLeft > 0 ? (
                      <>
                        <input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          maxLength={255}
                          placeholder="Note (optional), e.g. Lunch, Prayer"
                          className="mt-3 w-full max-w-sm mx-auto block rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => act('start')}
                          disabled={busy}
                          className="mt-3 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-violet-600 hover:bg-violet-700 text-white font-semibold disabled:opacity-50"
                        >
                          <Play className="w-4 h-4" /> Start break
                        </button>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-slate-600">You have taken all {data.rules.max_breaks} breaks allowed today.</p>
                    )}
                  </>
                )}
              </div>

              <div className="rounded-2xl bg-white border border-slate-200 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-800">Today</span>
                  <span className={`text-sm font-semibold tabular-nums ${over ? 'text-rose-600' : 'text-slate-700'}`}>
                    {minutesLabel(usedNow)} of {minutesLabel(allowed)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 mt-2 overflow-hidden">
                  <div className={`h-full rounded-full ${over ? 'bg-rose-500' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-2">
                  <span>{over ? <span className="text-rose-600 font-semibold">Over by {minutesLabel(over)}</span> : `${minutesLabel(Math.max(0, allowed - usedNow))} left`}</span>
                  <span>
                    {data.breaks.length} of {data.rules.max_breaks} breaks
                  </span>
                </div>
              </div>

              {data.breaks.length > 0 && (
                <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
                  {data.breaks.map((b) => (
                    <div key={b.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                      <span className="tabular-nums text-slate-700 whitespace-nowrap">
                        {clockTime(b.started_at)} – {b.open ? <span className="text-amber-700 font-semibold">now</span> : clockTime(b.ended_at)}
                      </span>
                      <span className="flex-1 min-w-0 truncate text-xs text-slate-500">{b.note || ''}</span>
                      <span className="tabular-nums font-semibold text-slate-800">{b.open ? minutesLabel(Math.ceil(openSeconds / 60)) : minutesLabel(b.minutes)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
};
