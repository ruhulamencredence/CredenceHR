/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HR -> Attendance -> Break Time (module "break_time",
// BreakRoutes.ts):
//   read          who is on a break now; each person's breaks per day, their
//                 total and how far over the day's allowance
//   break_manage  the break rules (minutes a day, breaks a day) and ending a
//                 break someone forgot to end (explicit-only)
// Employees take their breaks in Self Service -> Break Time.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Coffee, RefreshCw, Search, Settings2, Square } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { LoadingBlock } from './LoadingBlock';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { clockTime, minutesLabel } from './MyBreak';

interface BreakRow {
  id: number;
  user_id: number;
  name: string;
  employee_code: string | null;
  department: string | null;
  date: string;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  open: boolean;
  ended_by_hr: boolean;
  minutes: number;
}
interface DayRow {
  user_id: number;
  name: string;
  employee_code: string | null;
  department: string | null;
  date: string;
  count: number;
  minutes: number;
  open: boolean;
  over_minutes: number;
}
interface Report {
  from: string;
  to: string;
  today: string;
  rules: { allowed_minutes: number; max_breaks: number };
  can_manage: boolean;
  breaks: BreakRow[];
  summary: DayRow[];
  on_break_now: BreakRow[];
}

const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export const BreakTimeAdmin: React.FC<{ token: string }> = ({ token }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [overOnly, setOverOnly] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ending, setEnding] = useState<BreakRow | null>(null);

  const load = useCallback(() => {
    setError('');
    const q = from ? `?from=${from}&to=${to || from}` : '';
    fetch(apiUrl(`/api/breaks/report${q}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
        setData(j);
        if (!from) {
          setFrom(j.from);
          setTo(j.to);
        }
      })
      .catch((e) => setError(e.message));
  }, [token, from, to]);
  useEffect(load, [load]);
  useLiveRefresh(load);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.summary || []).filter(
      (d) => (!overOnly || d.over_minutes > 0) && (!q || [d.name, d.employee_code, d.department].some((v) => String(v || '').toLowerCase().includes(q)))
    );
  }, [data, search, overOnly]);
  const overCount = (data?.summary || []).filter((d) => d.over_minutes > 0).length;

  return (
    <div className="w-full text-slate-900">
      <div className="flex items-center justify-between gap-3 flex-wrap mt-2 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Coffee className="w-5 h-5 text-violet-600" /> Break Time
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-sm px-3 py-2 rounded-xl border border-slate-200 bg-white" aria-label="From" />
          <span className="text-xs text-slate-500">to</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="text-sm px-3 py-2 rounded-xl border border-slate-200 bg-white" aria-label="To" />
          <button type="button" onClick={load} className="p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50" aria-label="Refresh">
            <RefreshCw className="w-4 h-4 text-slate-600" />
          </button>
          {data?.can_manage && (
            <button type="button" onClick={() => setRulesOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-sm">
              <Settings2 className="w-4 h-4" /> Rules
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</div>}
      {!data && !error ? (
        <LoadingBlock />
      ) : (
        data && (
          <div className="space-y-4">
            <p className="text-xs text-slate-600">
              Allowed: <b>{minutesLabel(data.rules.allowed_minutes)}</b> of break a day, at most <b>{data.rules.max_breaks}</b> break{data.rules.max_breaks === 1 ? '' : 's'}.
            </p>

            <div className="rounded-2xl bg-white border border-slate-200">
              <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${data.on_break_now.length ? 'bg-amber-500' : 'bg-slate-300'}`} /> On a break now ({data.on_break_now.length})
              </div>
              {data.on_break_now.length === 0 ? (
                <div className="px-4 py-4 text-sm text-slate-500">Nobody is on a break.</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {data.on_break_now.map((b) => (
                    <div key={b.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                      <span className="flex-1 min-w-0">
                        <span className="font-semibold text-slate-800">{b.name}</span>
                        <span className="text-xs text-slate-500 ml-2">
                          {b.employee_code || ''} {b.department ? `· ${b.department}` : ''}
                        </span>
                        {b.note && <span className="block text-xs text-slate-500 truncate">{b.note}</span>}
                      </span>
                      <span className="text-xs text-slate-600 whitespace-nowrap">
                        since {b.date !== data.today ? `${dayLabel(b.date)}, ` : ''}
                        {clockTime(b.started_at)}
                      </span>
                      <span className={`tabular-nums font-semibold ${b.minutes > data.rules.allowed_minutes ? 'text-rose-600' : 'text-slate-800'}`}>{minutesLabel(b.minutes)}</span>
                      {data.can_manage && (
                        <button type="button" onClick={() => setEnding(b)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100">
                          <Square className="w-3 h-3" /> End
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white border border-slate-200">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
                <span className="text-sm font-semibold">Breaks by day</span>
                <div className="relative flex-1 min-w-[10rem]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, ID or department" className="w-full text-sm pl-8 pr-3 py-1.5 rounded-xl border border-slate-200" />
                </div>
                <label className="text-xs text-slate-600 flex items-center gap-1.5">
                  <input type="checkbox" checked={overOnly} onChange={(e) => setOverOnly(e.target.checked)} /> Over the allowance only ({overCount})
                </label>
              </div>
              {rows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-slate-500 text-center">No breaks in these days.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50">
                        <th className="px-4 py-2 font-semibold">Employee</th>
                        <th className="px-3 py-2 font-semibold">Date</th>
                        <th className="px-3 py-2 font-semibold text-right">Breaks</th>
                        <th className="px-3 py-2 font-semibold text-right">Total</th>
                        <th className="px-3 py-2 font-semibold text-right">Over</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => {
                        const key = `${d.user_id}|${d.date}`;
                        const expanded = openRow === key;
                        const list = expanded ? data.breaks.filter((b) => b.user_id === d.user_id && b.date === d.date) : [];
                        return (
                          <React.Fragment key={key}>
                            <tr className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setOpenRow(expanded ? null : key)}>
                              <td className="px-4 py-2">
                                <span className="inline-flex items-center gap-1.5">
                                  {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                                  <span className="font-semibold text-slate-800">{d.name}</span>
                                </span>
                                <span className="block text-xs text-slate-500 pl-5">
                                  {d.employee_code || ''} {d.department ? `· ${d.department}` : ''}
                                </span>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-slate-700">{dayLabel(d.date)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {d.count}
                                {d.count > data.rules.max_breaks && <span className="text-rose-600"> / {data.rules.max_breaks}</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                {minutesLabel(d.minutes)}
                                {d.open && <span className="ml-1 text-[10px] font-semibold text-amber-700 bg-amber-50 rounded px-1">on break</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {d.over_minutes > 0 ? <span className="text-rose-700 bg-rose-50 rounded-md px-1.5 py-0.5 font-semibold">{minutesLabel(d.over_minutes)}</span> : <span className="text-slate-400">—</span>}
                              </td>
                            </tr>
                            {list.map((b) => (
                              <tr key={b.id} className="bg-slate-50/60 text-xs">
                                <td className="pl-10 pr-4 py-1.5 text-slate-500" colSpan={2}>
                                  {clockTime(b.started_at)} – {b.open ? <span className="text-amber-700 font-semibold">now</span> : clockTime(b.ended_at)}
                                  {b.ended_by_hr && <span className="ml-2 text-slate-400">(ended by HR)</span>}
                                  {b.note && <span className="ml-2">{b.note}</span>}
                                </td>
                                <td />
                                <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{minutesLabel(b.minutes)}</td>
                                <td />
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {rulesOpen && data && <RulesPopup token={token} rules={data.rules} onClose={() => setRulesOpen(false)} onSaved={load} />}
      {ending && <EndBreakPopup token={token} row={ending} onClose={() => setEnding(null)} onDone={load} />}
    </div>
  );
};

const RulesPopup: React.FC<{ token: string; rules: Report['rules']; onClose: () => void; onSaved: () => void }> = ({ token, rules, onClose, onSaved }) => {
  const [allowed, setAllowed] = useState(String(rules.allowed_minutes));
  const [max, setMax] = useState(String(rules.max_breaks));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/break-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ allowed_minutes: Number(allowed), max_breaks: Number(max) })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || 'Could not save');
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Break rules"
      icon={<Settings2 className="w-5 h-5" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={save} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Break minutes allowed a day</label>
          <input type="number" min={1} max={600} value={allowed} onChange={(e) => setAllowed(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Breaks a day (at most)</label>
          <input type="number" min={1} max={20} value={max} onChange={(e) => setMax(e.target.value)} className={inputCls} />
        </div>
        <p className="text-xs text-slate-500">For everyone in this company. Time over the allowance shows in red in the report.</p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

const EndBreakPopup: React.FC<{ token: string; row: BreakRow; onClose: () => void; onDone: () => void }> = ({ token, row, onClose, onDone }) => {
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl(`/api/breaks/${row.id}/end`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(at ? { ended_at: at } : {})
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || 'Could not end the break');
      onDone();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title={`End ${row.name}'s break`}
      icon={<Square className="w-5 h-5" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} style={{ '--g-accent': '#e11d48' } as React.CSSProperties} onClick={end} disabled={busy}>
            End break
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          Started {row.date !== new Date().toLocaleDateString('en-CA') ? `${dayLabel(row.date)}, ` : ''}
          {clockTime(row.started_at)}. For a break they forgot to end, give the time it really ended; leave it empty to end it now.
        </p>
        <div>
          <label className={labelCls}>Ended at (optional)</label>
          <input type="time" value={at} onChange={(e) => setAt(e.target.value)} className={inputCls} />
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
