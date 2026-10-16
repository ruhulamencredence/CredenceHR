/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HR -> Attendance -> Duty Roster (module "duty_roster",
// RosterRoutes.ts).
//   read           the month grid (who works which shift, Off days) and the shifts
//   roster_manage  add / edit shifts, paint the grid, apply a weekly pattern
//                  (explicit-only layer)
// A day with nothing set follows the Holiday Calendar and the Late Attendance
// Policy as before; a shift or an Off day overrides both for that person.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, Plus, RefreshCw, Search, Save, Undo2, Pencil, Trash2, Wand2, Clock, Moon, Eraser, Loader2 } from 'lucide-react';
import type { User } from '../types';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { shiftTime, type Shift } from '../lib/roster';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn, Toggle } from './mail/MailPopup';

interface Cell {
  shift_id: number | null;
  is_off: boolean;
  note?: string | null;
}
interface RosterEmployee {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  branch: string | null;
  group: 'head_office' | 'project_site';
  days: Record<string, Cell>;
}
interface RosterData {
  from: string;
  to: string;
  holidays: Record<'head_office' | 'project_site', Record<string, { title: string; type: string }>>;
  employees: RosterEmployee[];
}
type Brush = { kind: 'shift'; id: number } | { kind: 'off' } | { kind: 'clear' };

async function api<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthDays = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`);
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
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The office week starts on Saturday.
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];
const SWATCHES = ['#7F00FF', '#2563EB', '#0891B2', '#059669', '#D97706', '#DC2626', '#DB2777', '#475569'];
const sameCell = (a: Cell | undefined, b: Cell | undefined) => (a?.is_off || false) === (b?.is_off || false) && (a?.shift_id ?? null) === (b?.shift_id ?? null);
const isEmpty = (c: Cell | undefined) => !c || (!c.is_off && c.shift_id == null);

// ---------------------------------------------------------------------------
// Shift form
// ---------------------------------------------------------------------------
const ShiftForm: React.FC<{ token: string; shift: Shift | null; active: boolean; onClose: () => void; onSaved: () => void }> = ({ token, shift, active, onClose, onSaved }) => {
  const [f, setF] = useState({
    name: shift?.name || '',
    code: shift?.code || '',
    start_time: shift?.start_time.slice(0, 5) || '09:00',
    end_time: shift?.end_time.slice(0, 5) || '18:00',
    grace_minutes: shift?.grace_minutes == null ? '' : String(shift.grace_minutes),
    extreme_grace_minutes: shift?.extreme_grace_minutes == null ? '' : String(shift.extreme_grace_minutes),
    color: shift?.color || SWATCHES[0],
    is_active: active
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }));
  const night = f.end_time <= f.start_time;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { ...f, grace_minutes: f.grace_minutes === '' ? null : Number(f.grace_minutes), extreme_grace_minutes: f.extreme_grace_minutes === '' ? null : Number(f.extreme_grace_minutes) };
      if (shift) await api(token, `/api/roster/shifts/${shift.id}`, { method: 'PUT', body });
      else await api(token, '/api/roster/shifts', { method: 'POST', body });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title={shift ? 'Edit shift' : 'New shift'}
      icon={<Clock className="w-4 h-4 text-violet-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn.replace('bg-sky-600', 'bg-violet-600')} disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Morning" autoFocus />
          </div>
          <div>
            <label className={labelCls}>Code</label>
            <input className={`${inputCls} uppercase`} value={f.code} maxLength={8} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="M" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Starts</label>
            <input type="time" className={inputCls} value={f.start_time} onChange={(e) => set('start_time', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Ends</label>
            <input type="time" className={inputCls} value={f.end_time} onChange={(e) => set('end_time', e.target.value)} />
          </div>
        </div>
        {night && (
          <p className="liquid-glass-inset rounded-xl px-3 py-2 text-[11px] text-slate-600 flex items-start gap-2">
            <Moon className="w-3.5 h-3.5 mt-0.5 text-indigo-500 shrink-0" />
            Night shift — it ends the next morning. The arrival is the first punch from 4 hours before the start; the early-morning punch is the previous night's check-out.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Grace minutes (Delay after)</label>
            <input type="number" min={0} max={600} className={inputCls} value={f.grace_minutes} onChange={(e) => set('grace_minutes', e.target.value)} placeholder="Late policy's" />
          </div>
          <div>
            <label className={labelCls}>Extreme Delay after (minutes)</label>
            <input type="number" min={0} max={600} className={inputCls} value={f.extreme_grace_minutes} onChange={(e) => set('extreme_grace_minutes', e.target.value)} placeholder="Late policy's" />
          </div>
        </div>
        <p className="text-[11px] text-slate-500">Leave a minutes box empty to use the Late Attendance Policy's (Payroll).</p>
        <div>
          <label className={labelCls}>Colour</label>
          <div className="flex gap-2 flex-wrap">
            {SWATCHES.map((c) => (
              <button key={c} type="button" onClick={() => set('color', c)} className={`w-8 h-8 rounded-full ring-offset-2 ${f.color === c ? 'ring-2 ring-slate-800' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} />
            ))}
          </div>
        </div>
        {shift && <Toggle checked={f.is_active} onChange={(v) => set('is_active', v)} label="In use" hint="A switched-off shift stays on the days already rostered, but can't be given to new days." />}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
// Weekly pattern
// ---------------------------------------------------------------------------
const PatternForm: React.FC<{
  shifts: Shift[];
  month: string;
  count: number;
  onClose: () => void;
  onApply: (p: { from: string; to: string; byWeekday: Record<number, string>; skipHolidays: boolean; overwrite: boolean }) => void;
}> = ({ shifts, month, count, onClose, onApply }) => {
  const days = monthDays(month);
  const [from, setFrom] = useState(days[0]);
  const [to, setTo] = useState(days[days.length - 1]);
  const [byWeekday, setByWeekday] = useState<Record<number, string>>(() => {
    const first = shifts[0] ? String(shifts[0].id) : '';
    return { 6: first, 0: first, 1: first, 2: first, 3: first, 4: first, 5: 'off' };
  });
  const [skipHolidays, setSkipHolidays] = useState(true);
  const [overwrite, setOverwrite] = useState(true);
  return (
    <Popup
      title="Weekly pattern"
      icon={<Wand2 className="w-4 h-4 text-violet-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn.replace('bg-sky-600', 'bg-violet-600')} disabled={!from || !to || from > to} onClick={() => onApply({ from, to, byWeekday, skipHolidays, overwrite })}>
            <Wand2 className="w-4 h-4" /> Fill the grid
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-600">
          For {count} {count === 1 ? 'person' : 'people'}. The grid is filled first — check it, then press <b>Save changes</b>.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>From</label>
            <input type="date" className={inputCls} value={from} min={days[0]} max={days[days.length - 1]} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>To</label>
            <input type="date" className={inputCls} value={to} min={days[0]} max={days[days.length - 1]} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
          {WEEK_ORDER.map((wd) => (
            <li key={wd} className="flex items-center gap-3 px-3 py-2">
              <span className="w-12 text-sm font-semibold text-slate-700">{WD[wd]}</span>
              <select className={`${inputCls} py-1.5`} value={byWeekday[wd] ?? ''} onChange={(e) => setByWeekday((x) => ({ ...x, [wd]: e.target.value }))}>
                <option value="">Leave as it is</option>
                {shifts.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.code} · {s.name} ({shiftTime(s)})
                  </option>
                ))}
                <option value="off">Off day</option>
                <option value="clear">Clear (follow the calendar)</option>
              </select>
            </li>
          ))}
        </ul>
        <Toggle checked={skipHolidays} onChange={setSkipHolidays} label="Keep calendar Weekends and Holidays free" hint="Don't put a shift on a date the Holiday Calendar already marks as Weekend or Holiday." />
        <Toggle checked={overwrite} onChange={setOverwrite} label="Replace what's already set" hint="Off: only fills days that have nothing set yet." />
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export const DutyRoster: React.FC<{ token: string; user: User }> = ({ token }) => {
  const [tab, setTab] = useState<'roster' | 'shifts'>('roster');
  const [month, setMonth] = useState(() => ymdOf(new Date()).slice(0, 7));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [inactive, setInactive] = useState<Set<number>>(new Set());
  const [canManage, setCanManage] = useState(false);
  const [data, setData] = useState<RosterData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [pending, setPending] = useState<Map<string, Cell>>(new Map());
  const [brush, setBrush] = useState<Brush | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const [pattern, setPattern] = useState(false);
  const painting = useRef(false);

  const loadShifts = useCallback(async () => {
    const r = await api<{ can_manage: boolean; shifts: Shift[]; inactive: number[] }>(token, '/api/roster/shifts');
    setShifts(r.shifts);
    setInactive(new Set(r.inactive));
    setCanManage(r.can_manage);
    return r;
  }, [token]);
  const loadRoster = useCallback(async () => {
    const days = monthDays(month);
    setData(null);
    setData(await api<RosterData>(token, `/api/roster?from=${days[0]}&to=${days[days.length - 1]}`));
  }, [token, month]);
  const loadAll = useCallback(async () => {
    try {
      setError('');
      await Promise.all([loadShifts(), loadRoster()]);
    } catch (e: any) {
      setError(e.message);
    }
  }, [loadShifts, loadRoster]);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);
  useEffect(() => {
    const up = () => (painting.current = false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const activeShifts = useMemo(() => shifts.filter((s) => !inactive.has(s.id)), [shifts, inactive]);
  const shiftById = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);
  useEffect(() => {
    if (canManage && !brush && activeShifts[0]) setBrush({ kind: 'shift', id: activeShifts[0].id });
  }, [canManage, brush, activeShifts]);

  const days = useMemo(() => monthDays(month), [month]);
  const today = ymdOf(new Date());
  const departments = useMemo(() => [...new Set((data?.employees || []).map((e) => e.department).filter(Boolean) as string[])].sort(), [data]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.employees || []).filter((e) => (!dept || e.department === dept) && (!t || `${e.name} ${e.employee_code || ''} ${e.designation || ''}`.toLowerCase().includes(t)));
  }, [data, q, dept]);

  const cellOf = (e: RosterEmployee, d: string): Cell | undefined => {
    const k = `${e.id}|${d}`;
    return pending.has(k) ? pending.get(k) : e.days[d];
  };
  const stage = (changes: [RosterEmployee, string, Cell][]) => {
    setPending((prev) => {
      const next = new Map(prev);
      for (const [e, d, c] of changes) {
        const k = `${e.id}|${d}`;
        if (sameCell(c, e.days[d]) || (isEmpty(c) && isEmpty(e.days[d]))) next.delete(k);
        else next.set(k, c);
      }
      return next;
    });
  };
  const brushCell = (): Cell | null => (!brush ? null : brush.kind === 'shift' ? { shift_id: brush.id, is_off: false } : brush.kind === 'off' ? { shift_id: null, is_off: true } : { shift_id: null, is_off: false });
  const paint = (e: RosterEmployee, d: string) => {
    const c = brushCell();
    if (!canManage || !c) return;
    stage([[e, d, c]]);
  };

  const guardPending = async () => !pending.size || (await confirmDialog(`Discard ${pending.size} unsaved change${pending.size === 1 ? '' : 's'}?`, { confirmLabel: 'Discard', tone: 'danger' }));
  const goMonth = async (by: number) => {
    if (!(await guardPending())) return;
    setPending(new Map());
    setSelected(new Set());
    setMonth((m) => shiftMonth(m, by));
  };
  const save = async () => {
    if (!pending.size) return;
    setSaving(true);
    setError('');
    try {
      const cells = [...pending.entries()].map(([k, c]) => {
        const [id, date] = k.split('|');
        return { employee_id: Number(id), date, shift_id: c.shift_id, is_off: c.is_off };
      });
      const r = await api<{ changed: number }>(token, '/api/roster/cells', { method: 'PUT', body: { cells } });
      setPending(new Map());
      setNotice(`Saved — ${r.changed} day${r.changed === 1 ? '' : 's'} changed.`);
      await loadRoster();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  const applyPattern = (p: { from: string; to: string; byWeekday: Record<number, string>; skipHolidays: boolean; overwrite: boolean }) => {
    const targets = selected.size ? rows.filter((e) => selected.has(e.id)) : rows;
    const changes: [RosterEmployee, string, Cell][] = [];
    for (const e of targets) {
      for (const d of days) {
        if (d < p.from || d > p.to) continue;
        const choice = p.byWeekday[new Date(`${d}T00:00:00`).getDay()] || '';
        if (!choice) continue;
        const cell: Cell = choice === 'off' ? { shift_id: null, is_off: true } : choice === 'clear' ? { shift_id: null, is_off: false } : { shift_id: Number(choice), is_off: false };
        if (cell.shift_id != null && p.skipHolidays && data?.holidays[e.group]?.[d]) continue;
        if (!p.overwrite && !isEmpty(cellOf(e, d))) continue;
        changes.push([e, d, cell]);
      }
    }
    stage(changes);
    setPattern(false);
    setNotice(`${changes.length} day${changes.length === 1 ? '' : 's'} filled — press Save changes to keep them.`);
  };
  const removeShift = async (s: Shift) => {
    if (!(await confirmDialog(`Remove the shift "${s.name}"? If it is already on the roster it is switched off instead, and the days it was worked keep it.`, { confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      const r = await api<{ archived: boolean }>(token, `/api/roster/shifts/${s.id}`, { method: 'DELETE' });
      setNotice(r.archived ? `"${s.name}" is on the roster, so it was switched off.` : `"${s.name}" removed.`);
      await loadShifts();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const totals = (e: RosterEmployee) => {
    let duty = 0;
    let off = 0;
    for (const d of days) {
      const c = cellOf(e, d);
      if (c?.is_off) off++;
      else if (c?.shift_id != null) duty++;
    }
    return { duty, off };
  };
  const allChecked = rows.length > 0 && rows.every((e) => selected.has(e.id));

  const BrushChip: React.FC<{ b: Brush; label: React.ReactNode; color?: string; title?: string }> = ({ b, label, color, title }) => {
    const on = brush && brush.kind === b.kind && (b.kind !== 'shift' || (brush as any).id === b.id);
    return (
      <button
        type="button"
        title={title}
        onClick={() => setBrush(b)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold border transition ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
      >
        {color && <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />}
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <CalendarRange className="w-5 h-5 text-violet-600" /> Duty Roster
        </h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {(
              [
                ['roster', 'Roster'],
                ['shifts', 'Shifts']
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void loadAll()} className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50" aria-label="Refresh" title="Refresh">
            <RefreshCw className="w-4 h-4 text-slate-600" />
          </button>
        </div>
      </div>

      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}

      {tab === 'shifts' ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-slate-600 max-w-2xl">
              A rostered shift decides when that person is late (its start + grace) and makes the day a working day even on a calendar Weekend. Days with no shift follow the Late Attendance Policy as before.
            </p>
            {canManage && (
              <button type="button" onClick={() => setEditing('new')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700">
                <Plus className="w-4 h-4" /> New shift
              </button>
            )}
          </div>
          {!shifts.length ? (
            <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{canManage ? 'No shifts yet — add Morning, Evening, Night…' : 'No shifts yet.'}</div>
          ) : (
            <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Shift</th>
                      <th className="px-4 py-2.5 font-semibold">Time</th>
                      <th className="px-4 py-2.5 font-semibold">Delay after</th>
                      <th className="px-4 py-2.5 font-semibold">Extreme Delay after</th>
                      {canManage && <th className="px-4 py-2.5 font-semibold text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shifts.map((s) => (
                      <tr key={s.id} className={inactive.has(s.id) ? 'opacity-55' : ''}>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-2">
                            <span className="min-w-[2rem] h-7 px-1.5 rounded-lg text-white text-xs font-bold flex items-center justify-center" style={{ background: s.color }}>
                              {s.code}
                            </span>
                            <span className="font-semibold text-slate-900">{s.name}</span>
                            {s.crosses_midnight && <Moon className="w-3.5 h-3.5 text-indigo-500" aria-label="Night shift" />}
                            {inactive.has(s.id) && <span className="text-[10px] font-semibold uppercase text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">Off</span>}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">{shiftTime(s)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{s.grace_minutes == null ? 'Policy' : `${s.grace_minutes} min`}</td>
                        <td className="px-4 py-2.5 text-slate-600">{s.extreme_grace_minutes == null ? 'Policy' : `${s.extreme_grace_minutes} min`}</td>
                        {canManage && (
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <button type="button" onClick={() => setEditing(s)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-600" aria-label={`Edit ${s.name}`} title="Edit">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => void removeShift(s)} className="p-1.5 rounded-lg hover:bg-rose-50 text-rose-600" aria-label={`Remove ${s.name}`} title="Remove">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center rounded-xl bg-white border border-slate-200">
              <button type="button" onClick={() => void goMonth(-1)} className="p-2 hover:bg-slate-50 rounded-l-xl" aria-label="Previous month">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-2 text-sm font-semibold text-slate-800 min-w-[8.5rem] text-center">{monthLabel(month)}</span>
              <button type="button" onClick={() => void goMonth(1)} className="p-2 hover:bg-slate-50 rounded-r-xl" aria-label="Next month">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="relative flex-1 min-w-[12rem] max-w-xs">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee" className="w-full text-sm pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-200" />
            </div>
            <select value={dept} onChange={(e) => setDept(e.target.value)} className="text-sm px-3 py-2 rounded-xl bg-white border border-slate-200">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            {canManage && (
              <button type="button" onClick={() => setPattern(true)} disabled={!activeShifts.length || !rows.length} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                <Wand2 className="w-4 h-4 text-violet-600" /> Weekly pattern{selected.size ? ` (${selected.size})` : ''}
              </button>
            )}
          </div>

          {canManage ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Brush:</span>
              {activeShifts.map((s) => (
                <BrushChip key={s.id} b={{ kind: 'shift', id: s.id }} color={s.color} label={`${s.code} · ${s.name}`} title={shiftTime(s)} />
              ))}
              <BrushChip b={{ kind: 'off' }} label="Off day" color="#94a3b8" />
              <BrushChip b={{ kind: 'clear' }} label={<><Eraser className="w-3.5 h-3.5" /> Clear</>} />
              {!activeShifts.length && (
                <button type="button" onClick={() => setTab('shifts')} className="text-xs font-semibold text-violet-700 hover:underline">
                  Add a shift first
                </button>
              )}
              <span className="text-[11px] text-slate-500">Click or drag over the days to paint them.</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap text-xs text-slate-600">
              {activeShifts.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} /> {s.code} · {s.name} ({shiftTime(s)})
                </span>
              ))}
            </div>
          )}

          {!data && !error ? (
            <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100" style={{ animation: 'skeleton-in .25s ease .15s both' }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-4">
                  <div className="h-3 w-40 rounded bg-slate-200/80" />
                  <div className="h-3 flex-1 rounded bg-slate-100" />
                </div>
              ))}
            </div>
          ) : data && !rows.length ? (
            <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{q || dept ? 'No employee matches.' : 'No active employees.'}</div>
          ) : (
            data && (
              <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
                <div className="overflow-auto max-h-[70vh]">
                  <table className="text-xs border-separate border-spacing-0 select-none">
                    <thead>
                      <tr>
                        <th className="sticky left-0 top-0 z-30 bg-slate-50 border-b border-r border-slate-200 px-3 py-2 text-left min-w-[13rem]">
                          <span className="flex items-center gap-2">
                            {canManage && (
                              <input
                                type="checkbox"
                                checked={allChecked}
                                onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((e) => e.id)))}
                                aria-label="Select everyone shown"
                                className="accent-violet-600"
                              />
                            )}
                            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Employee</span>
                          </span>
                        </th>
                        {days.map((d) => {
                          const wd = new Date(`${d}T00:00:00`).getDay();
                          const hol = data.holidays.head_office[d];
                          return (
                            <th
                              key={d}
                              title={hol ? `${hol.title} (Head Office)` : undefined}
                              className={`sticky top-0 z-20 border-b border-slate-200 px-0 py-1.5 w-9 min-w-[2.25rem] text-center font-semibold ${d === today ? 'bg-violet-100 text-violet-800' : hol ? 'bg-slate-100 text-slate-500' : 'bg-slate-50 text-slate-600'}`}
                            >
                              <div className="text-[10px] font-medium">{WD[wd].slice(0, 2)}</div>
                              <div>{Number(d.slice(8))}</div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e) => {
                        const t = totals(e);
                        return (
                          <tr key={e.id}>
                            <td className="sticky left-0 z-10 bg-white border-b border-r border-slate-100 px-3 py-1.5">
                              <span className="flex items-center gap-2">
                                {canManage && (
                                  <input
                                    type="checkbox"
                                    checked={selected.has(e.id)}
                                    onChange={() =>
                                      setSelected((s) => {
                                        const n = new Set(s);
                                        if (n.has(e.id)) n.delete(e.id);
                                        else n.add(e.id);
                                        return n;
                                      })
                                    }
                                    aria-label={`Select ${e.name}`}
                                    className="accent-violet-600"
                                  />
                                )}
                                <span className="min-w-0">
                                  <span className="block font-semibold text-slate-900 truncate max-w-[11rem]" title={e.name}>
                                    {e.name}
                                  </span>
                                  <span className="block text-[10px] text-slate-500 truncate max-w-[11rem]">
                                    {[e.employee_code, e.department].filter(Boolean).join(' · ')}
                                    {t.duty || t.off ? ` · ${t.duty} duty, ${t.off} off` : ''}
                                  </span>
                                </span>
                              </span>
                            </td>
                            {days.map((d) => {
                              const c = cellOf(e, d);
                              const hol = data.holidays[e.group]?.[d];
                              const s = c?.shift_id != null ? shiftById.get(c.shift_id) : undefined;
                              const changed = pending.has(`${e.id}|${d}`);
                              const label = c?.is_off ? 'Off day' : s ? `${s.name} ${shiftTime(s)}` : hol ? hol.title : 'Not set — calendar and late policy';
                              return (
                                <td
                                  key={d}
                                  title={`${e.name} · ${d}: ${label}${s && hol ? ` (on duty on ${hol.title})` : ''}`}
                                  onPointerDown={(ev) => {
                                    if (!canManage || !brush) return;
                                    ev.preventDefault();
                                    painting.current = true;
                                    paint(e, d);
                                  }}
                                  onPointerEnter={() => painting.current && paint(e, d)}
                                  className={`border-b border-slate-100 p-0.5 text-center ${canManage && brush ? 'cursor-pointer' : ''} ${hol && !s ? 'bg-slate-50' : ''} ${d === today ? 'bg-violet-50/60' : ''}`}
                                >
                                  <div
                                    className={`h-7 rounded-md flex items-center justify-center font-bold text-[11px] ${changed ? 'ring-2 ring-amber-400' : ''} ${
                                      s ? 'text-white' : c?.is_off ? 'bg-slate-200 text-slate-600' : hol ? 'text-slate-400' : 'text-slate-300'
                                    }`}
                                    style={s ? { background: s.color } : undefined}
                                  >
                                    {s ? s.code : c?.is_off ? 'OFF' : hol ? (hol.type === 'weekend' ? 'W' : 'H') : '·'}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
          <p className="text-[11px] text-slate-500">
            <b>W</b> / <b>H</b> — calendar Weekend / Holiday (nothing set). <b>OFF</b> — rostered Off day. A shift on a W/H day means that person is on duty that day. "·" — nothing set: the calendar and the Late Attendance Policy apply.
          </p>
        </div>
      )}

      {canManage && pending.size > 0 && tab === 'roster' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60]" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="liquid-glass liquid-glass-in rounded-full flex items-center gap-2 pl-4 pr-1.5 py-1.5">
            <span className="text-sm font-semibold text-slate-800 whitespace-nowrap">
              {pending.size} unsaved change{pending.size === 1 ? '' : 's'}
            </span>
            <button type="button" className={ghostBtn} onClick={() => setPending(new Map())} disabled={saving}>
              <span className="inline-flex items-center gap-1">
                <Undo2 className="w-4 h-4" /> Discard
              </span>
            </button>
            <button type="button" className={primaryBtn.replace('bg-sky-600', 'bg-violet-600')} onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save changes
            </button>
          </div>
        </div>
      )}

      {editing && (
        <ShiftForm
          token={token}
          shift={editing === 'new' ? null : editing}
          active={editing === 'new' ? true : !inactive.has(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice('Shift saved.');
            void loadShifts();
          }}
        />
      )}
      {pattern && <PatternForm shifts={activeShifts} month={month} count={selected.size || rows.length} onClose={() => setPattern(false)} onApply={applyPattern} />}
    </div>
  );
};
