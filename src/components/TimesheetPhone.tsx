/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Phone-width pieces of the Timesheet page (Timesheet.tsx): one button that
// opens a bottom sheet for Month / Day / Range, a half-gauge summary whose
// legend filters the day list, and a compact day card. Desktop keeps the
// original tabs, selects and cards.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock, X, XCircle } from 'lucide-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';

export type TimesheetMode = 'month' | 'day' | 'range';
export type DayStatus = 'ontime' | 'delay' | 'extreme' | 'absent' | 'leave' | 'weekend' | 'holiday';
export type StatusFilter = 'ontime' | 'delay' | 'extreme' | 'absent';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// [strong colour, soft background, text colour] per kind of day.
export const STATUS_STYLE: Record<DayStatus, { color: string; soft: string; fg: string; label: string }> = {
  ontime: { color: '#16a34a', soft: '#dcfce7', fg: '#166534', label: 'Present' },
  delay: { color: '#f59e0b', soft: '#fef3c7', fg: '#92400e', label: 'Delay' },
  extreme: { color: '#c2410c', soft: '#ffedd5', fg: '#9a3412', label: 'Extreme delay' },
  absent: { color: '#e11d48', soft: '#ffe4e6', fg: '#9f1239', label: 'Absent' },
  leave: { color: '#6366f1', soft: '#e0e7ff', fg: '#3730a3', label: 'On leave' },
  weekend: { color: '#a1a1aa', soft: '#f4f4f5', fg: '#52525b', label: 'Weekend' },
  holiday: { color: '#d97706', soft: '#fef3c7', fg: '#92400e', label: 'Holiday' }
};

// True below Tailwind's md breakpoint — the width the mobile layout uses.
export function useIsPhone(): boolean {
  const query = '(max-width: 767px)';
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

const parts = (ds: string) => ({ y: Number(ds.slice(0, 4)), m: Number(ds.slice(5, 7)), d: Number(ds.slice(8, 10)) });
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekdayOf = (ds: string) => new Date(`${ds}T00:00:00Z`).getUTCDay();
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shiftDays = (ds: string, n: number) => {
  const d = new Date(`${ds}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const weekdayShort = (ds: string) => WEEKDAY_SHORT[weekdayOf(ds)];

// "27 Oct 2026"
const shortDate = (ds: string) => {
  const p = parts(ds);
  return `${p.d} ${MONTH_SHORT[p.m - 1]} ${p.y}`;
};

export interface TimesheetPeriod {
  mode: TimesheetMode;
  year: number;
  month: number;
  day: string;
  from: string;
  to: string;
}

// What the period button and the sheet's apply button say.
export function periodLabel(p: TimesheetPeriod): string {
  if (p.mode === 'month') return `${MONTH_LONG[p.month - 1]} ${p.year}`;
  if (p.mode === 'day') return `${weekdayShort(p.day)}, ${shortDate(p.day)}`;
  if (!p.from || !p.to) return 'Pick dates';
  const a = parts(p.from);
  const b = parts(p.to);
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MONTH_SHORT[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTH_SHORT[a.m - 1]} – ${b.d} ${MONTH_SHORT[b.m - 1]} ${b.y}`;
  return `${shortDate(p.from)} – ${shortDate(p.to)}`;
}

const MODE_LABEL: Record<TimesheetMode, string> = { month: 'Month', day: 'Day', range: 'Date range' };

export const PeriodButton: React.FC<{ period: TimesheetPeriod; onClick: () => void }> = ({ period, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Change what the timesheet shows"
    className="liquid-glass w-full min-h-[52px] flex items-center gap-2.5 px-3.5 rounded-[20px] text-left text-slate-900"
  >
    <span className="liquid-glass-inset w-[34px] h-[34px] rounded-xl flex items-center justify-center shrink-0">
      <CalendarDays className="w-[18px] h-[18px] text-[color:var(--g-accent,#7f00ff)]" />
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-[11px] text-slate-500">{MODE_LABEL[period.mode]}</span>
      <span className="block text-[15px] font-bold truncate">{periodLabel(period)}</span>
    </span>
    <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
  </button>
);

const pillOn = 'liquid-glass-button';
const pillOff = 'liquid-glass-inset text-slate-900';

// The bottom sheet: Month / Day / Range, each with its own picker, and a
// "Show …" button that applies the choice.
export const PeriodSheet: React.FC<{
  open: boolean;
  value: TimesheetPeriod;
  today: string;
  minYear: number;
  onClose: () => void;
  onApply: (p: TimesheetPeriod) => void;
}> = ({ open, value, today, minYear, onClose, onApply }) => {
  const [draft, setDraft] = useState<TimesheetPeriod>(value);
  // The month the Day calendar is showing ("YYYY-MM").
  const [calMonth, setCalMonth] = useState(value.day.slice(0, 7));
  useEffect(() => {
    if (open) {
      setDraft(value);
      setCalMonth(value.day.slice(0, 7));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useBackButtonClose(open, onClose);
  if (!open) return null;

  const t = parts(today);
  const set = (patch: Partial<TimesheetPeriod>) => setDraft((d) => ({ ...d, ...patch }));
  const rangeValid = !!draft.from && !!draft.to && draft.from <= draft.to;

  const lastMonthEnd = shiftDays(`${today.slice(0, 7)}-01`, -1);
  const presets: { key: string; label: string; from: string; to: string }[] = [
    { key: 'this', label: 'This month', from: `${today.slice(0, 7)}-01`, to: today },
    { key: 'last7', label: 'Last 7 days', from: shiftDays(today, -6), to: today },
    { key: 'last', label: 'Last month', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd }
  ];

  const cy = Number(calMonth.slice(0, 4));
  const cm = Number(calMonth.slice(5, 7));
  const lead = weekdayOf(`${calMonth}-01`);
  const calCells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = 1; d <= daysIn(cy, cm); d++) calCells.push(isoOf(cy, cm, d));
  const stepMonth = (n: number) => {
    let y = cy;
    let m = cm + n;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    setCalMonth(`${y}-${pad(m)}`);
  };
  const canNextCal = calMonth < today.slice(0, 7);
  const canPrevCal = cy > minYear || cm > 1;

  const inputClass =
    'liquid-glass-inset w-full min-h-[44px] rounded-2xl px-3 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-[color:var(--g-accent,#7f00ff)]';

  return createPortal(
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop" onClick={onClose}>
      <div className="fixed left-2 right-2 bottom-2 pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose what to show"
          className="liquid-glass liquid-glass-in rounded-[32px] px-[18px] pt-2.5 pb-5 flex flex-col gap-3.5 max-h-[88vh] overflow-y-auto text-slate-900"
        >
          <div className="w-10 h-[5px] rounded-full bg-zinc-300 self-center" aria-hidden="true" />
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-extrabold">Show</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="liquid-glass-inset grid grid-cols-3 gap-1 p-1 rounded-full">
            {(['month', 'day', 'range'] as TimesheetMode[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={draft.mode === m}
                onClick={() => set({ mode: m })}
                className={`min-h-[38px] rounded-full text-[13px] font-bold transition-colors ${
                  draft.mode === m ? 'bg-white/95 text-[color:var(--g-accent,#7f00ff)] shadow-sm' : 'text-slate-500'
                }`}
              >
                {m === 'month' ? 'Month' : m === 'day' ? 'Day' : 'Range'}
              </button>
            ))}
          </div>

          {draft.mode === 'month' && (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label="Previous year"
                  disabled={draft.year <= minYear}
                  onClick={() => set({ year: draft.year - 1 })}
                  className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-40"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="text-base font-extrabold">{draft.year}</div>
                <button
                  type="button"
                  aria-label="Next year"
                  disabled={draft.year >= t.y}
                  onClick={() => set({ year: draft.year + 1, month: draft.year + 1 === t.y ? Math.min(draft.month, t.m) : draft.month })}
                  className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-40"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {MONTH_SHORT.map((label, i) => {
                  const future = draft.year === t.y && i + 1 > t.m;
                  const sel = draft.month === i + 1;
                  return (
                    <button
                      key={label}
                      type="button"
                      disabled={future}
                      aria-pressed={sel}
                      onClick={() => set({ month: i + 1 })}
                      className={`min-h-[44px] rounded-full text-[13px] font-bold disabled:opacity-35 ${sel ? pillOn : pillOff}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {draft.mode === 'day' && (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label="Previous month"
                  disabled={!canPrevCal}
                  onClick={() => stepMonth(-1)}
                  className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="text-[13px] font-bold text-slate-700">{MONTH_LONG[cm - 1]} {cy}</div>
                <button
                  type="button"
                  aria-label="Next month"
                  disabled={!canNextCal}
                  onClick={() => stepMonth(1)}
                  className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-7 gap-1 text-center">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
                  <div key={i} className="text-[11px] text-zinc-500 py-0.5" aria-hidden="true">{w}</div>
                ))}
                {calCells.map((ds, i) =>
                  ds ? (
                    <button
                      key={ds}
                      type="button"
                      disabled={ds > today}
                      aria-label={shortDate(ds)}
                      aria-pressed={draft.day === ds}
                      onClick={() => set({ day: ds })}
                      className={`h-[38px] rounded-xl text-[13px] font-semibold ${
                        draft.day === ds ? pillOn : ds > today ? 'text-zinc-400' : 'bg-white/55 text-slate-900'
                      }`}
                    >
                      {Number(ds.slice(8, 10))}
                    </button>
                  ) : (
                    <span key={`b${i}`} />
                  )
                )}
              </div>
            </>
          )}

          {draft.mode === 'range' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-500">
                  From
                  <input type="date" value={draft.from} max={draft.to || today} onChange={(e) => set({ from: e.target.value })} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-500">
                  To
                  <input type="date" value={draft.to} min={draft.from} max={today} onChange={(e) => set({ to: e.target.value })} className={inputClass} />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => {
                  const sel = draft.from === p.from && draft.to === p.to;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      aria-pressed={sel}
                      onClick={() => set({ from: p.from, to: p.to })}
                      className={`min-h-[38px] px-3.5 rounded-full text-xs font-bold border ${
                        sel
                          ? 'bg-[color:color-mix(in_srgb,var(--g-accent,#7f00ff)_12%,transparent)] text-[color:var(--g-accent,#7f00ff)] border-[color:color-mix(in_srgb,var(--g-accent,#7f00ff)_45%,transparent)]'
                          : 'bg-white/55 text-zinc-700 border-white/85'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <button
            type="button"
            disabled={draft.mode === 'range' && !rangeValid}
            onClick={() => onApply(draft)}
            className="liquid-glass-button min-h-[50px] rounded-full text-[15px] font-extrabold disabled:opacity-50"
          >
            Show {periodLabel(draft)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export interface GaugeCounts {
  ontime: number;
  delay: number;
  extreme: number;
  absent: number;
  leave: number;
}

const ARC = 'M 20 100 A 80 80 0 0 1 180 100';
const ARC_LEN = 251.3;
const LEGEND: { key: StatusFilter; label: string }[] = [
  { key: 'ontime', label: 'On time' },
  { key: 'delay', label: 'Delay' },
  { key: 'extreme', label: 'Extreme' },
  { key: 'absent', label: 'Absent' }
];

// Half gauge: attended % in the middle, every kind of working day as its own
// coloured piece of the arc. Tapping a legend item keeps only that piece lit
// and shows its share; tapping it again shows everything.
export const AttendanceGauge: React.FC<{
  counts: GaugeCounts;
  period: string;
  filter: StatusFilter | null;
  onFilter: (f: StatusFilter | null) => void;
}> = ({ counts, period, filter, onFilter }) => {
  const total = counts.ontime + counts.delay + counts.extreme + counts.absent + counts.leave;
  const attended = counts.ontime + counts.delay + counts.extreme;
  const pct = (n: number) => (total ? Math.round((n * 100) / total) : 0);
  const pieces: { key: DayStatus; n: number }[] = [
    { key: 'ontime', n: counts.ontime },
    { key: 'delay', n: counts.delay },
    { key: 'extreme', n: counts.extreme },
    { key: 'absent', n: counts.absent },
    { key: 'leave', n: counts.leave }
  ];
  let pos = 0;
  const arcs = pieces.map((p) => {
    const len = total ? (p.n / total) * ARC_LEN : 0;
    const dash = len ? `0 ${pos.toFixed(1)} ${len.toFixed(1)} 600` : '0 600';
    pos += len;
    return { ...p, dash };
  });
  // Drawn last-to-first so the round-capped "on time" piece sits on top.
  const drawOrder = [...arcs].reverse();
  const shown = filter ? counts[filter] : attended;
  const caption = filter
    ? `${counts[filter]} of ${total} day${total === 1 ? '' : 's'} · ${filter === 'ontime' ? 'on time' : STATUS_STYLE[filter].label.toLowerCase()}`
    : `attended · ${period}`;
  const aria = `${pct(attended)}% attended: ${counts.ontime} on time, ${counts.delay} delay, ${counts.extreme} extreme delay, ${counts.absent} absent, ${counts.leave} on leave`;

  return (
    <div className="liquid-glass rounded-[28px] px-4 pt-4 pb-3.5 flex flex-col items-center gap-2.5">
      <div className="relative w-[220px] h-[118px]">
        <svg width="220" height="118" viewBox="0 0 200 108" role="img" aria-label={aria}>
          <path d={ARC} fill="none" stroke="rgba(99,0,198,.10)" strokeWidth="14" strokeLinecap="round" />
          {drawOrder.map((a) =>
            a.n ? (
              <path
                key={a.key}
                d={ARC}
                fill="none"
                stroke={STATUS_STYLE[a.key].color}
                strokeWidth="14"
                strokeLinecap={a.key === 'ontime' ? 'round' : 'butt'}
                strokeDasharray={a.dash}
                opacity={!filter || filter === a.key ? 1 : 0.2}
                style={{ transition: 'opacity .2s ease' }}
              />
            ) : null
          )}
        </svg>
        <div className="absolute inset-x-0 bottom-1 text-center">
          <div className="text-[30px] font-extrabold leading-none tracking-tight" style={{ color: filter ? STATUS_STYLE[filter].fg : '#18181b' }}>
            {pct(shown)}%
          </div>
          <div className="text-[11px] text-zinc-500 mt-[3px] px-2 truncate">{caption}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 w-full">
        {LEGEND.map((l) => {
          const on = filter === l.key;
          const s = STATUS_STYLE[l.key];
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(on ? null : l.key)}
              className="min-h-[36px] flex items-center gap-1.5 px-3 rounded-full text-xs font-semibold border"
              style={{ color: on ? s.fg : '#3f3f46', background: on ? s.soft : 'rgba(255,255,255,.45)', borderColor: on ? s.color : 'rgba(255,255,255,.8)' }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
              {l.label}
              <span className="ml-auto tabular-nums opacity-70">{counts[l.key]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// One day of the list on a phone: date tile tinted by status, In – Out,
// project, status chip. Tapping it opens the correction / status modal.
export const PhoneDayCard: React.FC<{
  dateStr: string;
  status: DayStatus;
  times: string;
  where: string;
  statusLabel?: string;
  correction?: 'pending' | 'rejected';
  onClick: () => void;
}> = ({ dateStr, status, times, where, statusLabel, correction, onClick }) => {
  const s = STATUS_STYLE[status];
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-[22px] p-3 flex items-center gap-3 bg-white/80 border border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,.9),0_8px_20px_-14px_rgba(15,23,42,.35)] active:scale-[0.99] transition-transform"
    >
      <div className="w-12 h-[52px] rounded-2xl flex flex-col items-center justify-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,.8)]" style={{ background: s.soft, color: s.fg }}>
        <span className="text-lg font-extrabold leading-none">{Number(dateStr.slice(8, 10))}</span>
        <span className="text-[10px] font-bold mt-[3px]">{weekdayShort(dateStr)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-900 truncate">{times}</div>
        <div className="text-xs text-zinc-500 mt-0.5 truncate">{where}</div>
        {correction && (
          <span
            className={`mt-1 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              correction === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {correction === 'pending' ? <Clock className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
            {correction === 'pending' ? 'Correction pending' : 'Correction rejected'}
          </span>
        )}
      </div>
      <div className="text-[11px] font-bold px-2.5 py-[5px] rounded-full whitespace-nowrap" style={{ background: s.soft, color: s.fg }}>
        {statusLabel || s.label}
      </div>
    </button>
  );
};
