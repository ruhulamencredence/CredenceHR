/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> Schedule: WHEN each person is tracked (the tracking
// module's "Tracking Schedule" layer). Everyone this account may track, with
// their rule (Always / Fixed hours / Duty Roster) and whether they are being
// tracked right now; tick people and set one rule for all of them. Outside
// their time the phone stops tracking and shows no notification
// (TrackingSchedule.ts, src/lib/backgroundTracking.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Search, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';
import { useIsPhone } from '../lib/useScrolling';

type Mode = 'always' | 'fixed' | 'roster';
interface Person {
  user_id: number;
  employee_id: string;
  name: string;
  designation: string;
  department: string;
  branch: string;
  tracking_enabled: boolean;
  mode: Mode;
  days: number[];
  start_time: string | null;
  end_time: string | null;
  now: { on: boolean; until: string | null; next_start: string | null } | null;
}

// Week starts on Saturday here (Bangladesh office week).
const WEEK: [number, string][] = [
  [6, 'Sat'],
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri']
];
const MODE_LABEL: Record<Mode, string> = { always: 'Always', fixed: 'Fixed hours', roster: 'Duty Roster' };

const ampm = (t: string | null) => {
  if (!t) return '';
  const h = Number(t.slice(0, 2));
  return `${String(h % 12 || 12).padStart(2, '0')}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
};
// Always Bangladesh time (the schedule's own clock), whatever the device is set to.
const BD = 'Asia/Dhaka';
const bdDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: BD }).format(d);
const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day =
    bdDay(d) === bdDay(new Date())
      ? 'today'
      : bdDay(d) === bdDay(new Date(Date.now() + 864e5))
        ? 'tomorrow'
        : new Intl.DateTimeFormat('en-GB', { timeZone: BD, weekday: 'short', day: '2-digit', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: BD, hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
  return `${day} ${time}`;
};
const daysText = (days: number[]) => {
  const order = WEEK.filter(([d]) => days.includes(d)).map(([, l]) => l);
  if (order.length === 7) return 'Every day';
  // Sat–Thu style when the picked days run together in the week.
  const idx = WEEK.map(([d]) => d).filter((d) => days.includes(d)).map((d) => WEEK.findIndex(([x]) => x === d));
  const contiguous = idx.length > 2 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return contiguous ? `${order[0]}–${order[order.length - 1]}` : order.join(', ');
};
const ruleText = (p: Person) =>
  p.mode === 'fixed' ? `${daysText(p.days)} · ${ampm(p.start_time)} – ${ampm(p.end_time)}` : p.mode === 'roster' ? 'Duty Roster shift' : 'Always';

export const TrackingScheduleSheet: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const phone = useIsPhone();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [buffer, setBuffer] = useState(30);
  const [bufferDraft, setBufferDraft] = useState('30');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [modeFilter, setModeFilter] = useState<'' | Mode>('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // The rule being set for the ticked people.
  const [mode, setMode] = useState<Mode>('fixed');
  const [days, setDays] = useState<number[]>([6, 0, 1, 2, 3, 4]);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  useBackButtonClose(true, () => !busy && onClose());

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/tracking/schedules'), { headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load');
      setPeople(d.people || []);
      setBuffer(Number(d.buffer_minutes ?? 30));
      setBufferDraft(String(d.buffer_minutes ?? 30));
    } catch (e: any) {
      setError(e.message);
      setPeople([]);
    }
  }, [headers]);
  useEffect(() => {
    void load();
  }, [load]);

  const departments = useMemo(() => Array.from(new Set((people || []).map((p) => p.department).filter(Boolean))).sort(), [people]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (people || []).filter(
      (p) =>
        (!dept || p.department === dept) &&
        (!modeFilter || p.mode === modeFilter) &&
        (!t || [p.name, p.employee_id, p.designation, p.department, p.branch].some((v) => String(v || '').toLowerCase().includes(t)))
    );
  }, [people, q, dept, modeFilter]);
  const allShownPicked = shown.length > 0 && shown.every((p) => picked.has(p.user_id));
  const toggle = (id: number) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const apply = async () => {
    if (!picked.size) return;
    if (mode === 'fixed' && (!days.length || !start || !end || start === end)) return setError('Pick the days and a start and end time.');
    const rule = mode === 'fixed' ? `${daysText(days)} ${ampm(start)} – ${ampm(end)}` : MODE_LABEL[mode];
    if (!(await confirmDialog(`Set "${rule}" for ${picked.size} ${picked.size === 1 ? 'person' : 'people'}?`, { confirmLabel: 'Set schedule', tone: 'default' }))) return;
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const r = await fetch(apiUrl('/api/tracking/schedules'), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ user_ids: [...picked], mode, days, start_time: start, end_time: end })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      setMsg(`Saved for ${d.changed}${d.skipped ? ` · ${d.skipped} skipped (outside who you can track)` : ''}.`);
      setPicked(new Set());
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveBuffer = async () => {
    const n = Number(bufferDraft);
    if (!Number.isInteger(n) || n < 0 || n > 180) return setError('Minutes must be 0 to 180.');
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/tracking/schedule-settings'), { method: 'PUT', headers, body: JSON.stringify({ buffer_minutes: n }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      setMsg(`Before / after each window: ${n} minutes.`);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const nowCell = (p: Person) =>
    !p.tracking_enabled ? (
      <span className="text-slate-400">Tracking off</span>
    ) : !p.now || p.now.on ? (
      <span className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        Tracked{p.now?.until ? ` until ${when(p.now.until)}` : ''}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-slate-500 font-semibold">
        <span className="w-2 h-2 rounded-full bg-slate-300" />
        Off{p.now.next_start ? ` · starts ${when(p.now.next_start)}` : ' · no time in the next week'}
      </span>
    );

  const tick = (p: Person) => (
    <input type="checkbox" checked={picked.has(p.user_id)} onChange={() => toggle(p.user_id)} aria-label={`Select ${p.name}`} className="w-4 h-4 accent-[var(--g-accent)]" />
  );

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Tracking Schedule">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => !busy && onClose()} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-start gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center shrink-0">
              <CalendarClock className="w-5 h-5 text-slate-700" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900">Tracking Schedule</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                When each person is tracked. Outside their time the phone stops tracking and shows no notification; nothing is saved.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 sm:px-6 pb-3 flex flex-wrap items-center gap-2 shrink-0">
            <label className="flex items-center gap-2 liquid-glass-inset rounded-full px-3 py-1.5 flex-1 min-w-[180px] max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, department, branch…" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
            </label>
            <div className="w-48">
              <SearchSelect value={dept} onChange={(e) => setDept(e.target.value)} className="w-full text-xs px-3 py-1.5 rounded-full bg-white/80 border border-white">
                <option value="">— All departments —</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </SearchSelect>
            </div>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as any)} className="text-xs px-3 py-1.5 rounded-full bg-white/80 border border-white">
              <option value="">Any rule</option>
              <option value="always">Always</option>
              <option value="fixed">Fixed hours</option>
              <option value="roster">Duty Roster</option>
            </select>
            <span className="flex items-center gap-1.5 text-xs text-slate-600 ml-auto">
              Before / after each window
              <input
                type="number"
                min={0}
                max={180}
                value={bufferDraft}
                onChange={(e) => setBufferDraft(e.target.value)}
                className="w-16 text-xs px-2 py-1 rounded-lg bg-white/80 border border-white text-center"
                aria-label="Minutes before and after"
              />
              min
              {bufferDraft !== String(buffer) && (
                <button type="button" onClick={() => void saveBuffer()} disabled={busy} className="liquid-glass-button rounded-full px-3 py-1 text-xs font-semibold">
                  Save
                </button>
              )}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 pb-4">
            {!people ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
              </div>
            ) : shown.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-16">{q || dept || modeFilter ? 'No match.' : 'Nobody to show.'}</p>
            ) : phone ? (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 px-1">
                  <input
                    type="checkbox"
                    checked={allShownPicked}
                    onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((p) => p.user_id)))}
                    className="w-4 h-4 accent-[var(--g-accent)]"
                  />
                  Select all shown ({shown.length})
                </label>
                {shown.map((p) => (
                  <div key={p.user_id} className="liquid-glass-inset rounded-2xl px-3 py-2.5 flex items-start gap-2.5 text-xs">
                    <span className="pt-0.5">{tick(p)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-slate-800 truncate">{p.name}</span>
                      <span className="block text-[11px] text-slate-500 truncate">{[p.employee_id, p.designation, p.department].filter(Boolean).join(' · ')}</span>
                      <span className="block mt-1 text-slate-700">{ruleText(p)}</span>
                      <span className="block mt-0.5 text-[11px]">{nowCell(p)}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="liquid-glass-inset rounded-2xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-[1] bg-white/85 backdrop-blur">
                    <tr className="text-left text-slate-500">
                      <th className="w-10 px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={allShownPicked}
                          onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((p) => p.user_id)))}
                          aria-label="Select all shown"
                          className="w-4 h-4 accent-[var(--g-accent)]"
                        />
                      </th>
                      <th className="px-3 py-2.5 font-semibold">Employee</th>
                      <th className="px-3 py-2.5 font-semibold">Department</th>
                      <th className="px-3 py-2.5 font-semibold">Branch</th>
                      <th className="px-3 py-2.5 font-semibold">Schedule</th>
                      <th className="px-3 py-2.5 font-semibold">Right now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.user_id} className="border-t border-slate-200/60 cursor-pointer hover:bg-white/40" onClick={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && toggle(p.user_id)}>
                        <td className="px-3 py-2.5">{tick(p)}</td>
                        <td className="px-3 py-2.5">
                          <span className="block font-semibold text-slate-800">{p.name}</span>
                          <span className="block text-[11px] text-slate-500">{[p.employee_id, p.designation].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{p.department || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-600">{p.branch || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-800 font-medium">{ruleText(p)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{nowCell(p)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {(error || msg) && (
            <p className={`mx-4 sm:mx-6 mb-2 text-xs font-semibold ${error ? 'text-rose-700' : 'text-emerald-700'}`} role="status">
              {error || msg}
            </p>
          )}

          <div className="px-4 sm:px-6 py-3 border-t border-white/60 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {picked.size === 0 ? (
              <p className="text-xs text-slate-500">Tick people to set when they are tracked.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-800 mr-1">{picked.size} selected</span>
                <div className="flex rounded-full bg-white/60 p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Rule">
                  {(['always', 'fixed', 'roster'] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      onClick={() => setMode(m)}
                      className={`px-3 py-1.5 rounded-full ${mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                    >
                      {MODE_LABEL[m]}
                    </button>
                  ))}
                </div>
                {mode === 'fixed' && (
                  <>
                    <div className="flex gap-1">
                      {WEEK.map(([d, l]) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={days.includes(d)}
                          onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
                          className={`w-10 py-1.5 rounded-full text-[11px] font-semibold ${days.includes(d) ? 'bg-slate-900 text-white' : 'bg-white/70 text-slate-500'}`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                    <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg bg-white/80 border border-white" aria-label="Start" />
                    <span className="text-xs text-slate-500">to</span>
                    <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg bg-white/80 border border-white" aria-label="End" />
                    {end && start && end < start && <span className="text-[11px] text-slate-500">ends next day</span>}
                  </>
                )}
                {mode === 'roster' && <span className="text-[11px] text-slate-500">Only during their Duty Roster shift that day; off days and days with no shift are not tracked.</span>}
                {mode === 'always' && <span className="text-[11px] text-slate-500">All the time, as before.</span>}
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy}
                  className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold ml-auto disabled:opacity-50 flex items-center gap-1.5"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Set schedule
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TrackingScheduleSheet;
