/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Phone-width layout of the Leave Applications page (LeaveReviewPage.tsx):
// a half gauge of this year's leave (days left in the middle, each leave
// type's days taken as its own coloured piece), one button per leave type
// that filters both the gauge and the list, the Review / Approved / Rejected
// switch, and compact application cards. Desktop keeps its table.

import React from 'react';
import { Check, Clock, Plus, X } from 'lucide-react';
import { LeaveApplication } from '../types';

export interface LeaveTypeInfo {
  key: string;
  label: string;
  short: string;
  // Days still available; null for a type with no yearly allowance
  // (Leave Without Pay), which then shows days taken instead.
  left: number | null;
  taken: number;
}

const PALETTE: Record<string, { color: string; soft: string; fg: string }> = {
  casual: { color: '#2563eb', soft: '#dbeafe', fg: '#1e40af' },
  sick: { color: '#0d9488', soft: '#ccfbf1', fg: '#115e59' },
  without_pay: { color: '#d97706', soft: '#fef3c7', fg: '#92400e' }
};
const CUSTOM_PALETTE = [
  { color: '#7c3aed', soft: '#ede9fe', fg: '#5b21b6' },
  { color: '#db2777', soft: '#fce7f3', fg: '#9d174d' },
  { color: '#0891b2', soft: '#cffafe', fg: '#155e75' },
  { color: '#65a30d', soft: '#ecfccb', fg: '#3f6212' }
];

// Colours for a leave type: the three built-in ones are fixed; custom
// categories take the next colour in order of the list passed in.
export function leaveTypeStyle(key: string, allKeys: string[]) {
  if (PALETTE[key]) return PALETTE[key];
  const customs = allKeys.filter((k) => !PALETTE[k]);
  const i = customs.indexOf(key);
  return CUSTOM_PALETTE[(i < 0 ? 0 : i) % CUSTOM_PALETTE.length];
}

const ARC = 'M 20 100 A 80 80 0 0 1 180 100';
const ARC_LEN = 251.3;
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

export const LeaveGauge: React.FC<{
  types: LeaveTypeInfo[];
  year: number;
  filter: string | null;
  onFilter: (key: string | null) => void;
  onSubmit: () => void;
}> = ({ types, year, filter, onFilter, onSubmit }) => {
  const keys = types.map((t) => t.key);
  const picked = filter ? types.find((t) => t.key === filter) || null : null;
  // Without a pick: every type with a yearly allowance. With one: just it.
  const shown = picked ? [picked] : types.filter((t) => t.left != null);
  const used = shown.reduce((n, t) => n + t.taken, 0);
  const left = shown.reduce((n, t) => n + Math.max(0, t.left ?? 0), 0);
  const noAllowance = !!picked && picked.left == null;
  const whole = noAllowance ? Math.max(picked!.taken, 1) : used + left || 1;

  let pos = 0;
  const arcs = shown.map((t) => {
    const len = (t.taken / whole) * ARC_LEN;
    const dash = `0 ${pos.toFixed(1)} ${len.toFixed(1)} 600`;
    const first = pos === 0;
    pos += len;
    return { key: t.key, len, dash, first };
  });

  const big = noAllowance ? plural(picked!.taken) : plural(left);
  const caption = noAllowance ? `taken without pay · ${year}` : `left · ${used} taken in ${year}`;
  const centerColor = picked ? leaveTypeStyle(picked.key, keys).fg : '#18181b';

  return (
    // A shorter drop shadow than .liquid-glass's own, so it doesn't spill
    // over the Review / Approved / Rejected switch below.
    <div
      className="liquid-glass rounded-[26px] px-3 pt-3 pb-3 flex flex-col items-center gap-2"
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.95), inset 0 -1px 1px rgba(255,255,255,.35), 0 10px 22px -16px rgba(15,23,42,.35)' }}
    >
      <div className="relative w-[168px] h-[90px]">
        <svg width="168" height="90" viewBox="0 0 200 108" role="img" aria-label={`${big} ${caption}`}>
          <path d={ARC} fill="none" stroke="rgba(99,0,198,.10)" strokeWidth="14" strokeLinecap="round" />
          {[...arcs].reverse().map((a) =>
            a.len > 0 ? (
              <path
                key={a.key}
                d={ARC}
                fill="none"
                stroke={leaveTypeStyle(a.key, keys).color}
                strokeWidth="14"
                strokeLinecap={a.first ? 'round' : 'butt'}
                strokeDasharray={a.dash}
              />
            ) : null
          )}
        </svg>
        <div className="absolute inset-x-0 bottom-1 text-center">
          <div className="text-[22px] font-extrabold leading-none tracking-tight" style={{ color: centerColor }}>{big}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{caption}</div>
        </div>
      </div>
      {/* One row: up to five types share the width; more scroll sideways. */}
      <div
        className={types.length > 5 ? 'flex gap-1 w-full overflow-x-auto [&>button]:w-[68px] [&>button]:shrink-0' : 'grid gap-1 w-full'}
        style={types.length > 5 ? undefined : { gridTemplateColumns: `repeat(${Math.max(types.length, 1)}, minmax(0, 1fr))` }}
      >
        {types.map((t) => {
          const on = filter === t.key;
          const s = leaveTypeStyle(t.key, keys);
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(on ? null : t.key)}
              title={t.left == null ? `${t.label}: ${plural(t.taken)} taken` : `${t.label}: ${plural(t.left)} left`}
              className="min-w-0 min-h-[40px] flex flex-col items-center justify-center gap-[3px] px-0.5 py-1 rounded-xl border whitespace-nowrap"
              style={{ color: on ? s.fg : '#3f3f46', background: on ? s.soft : 'rgba(255,255,255,.45)', borderColor: on ? s.color : 'rgba(255,255,255,.8)' }}
            >
              <span className="flex items-center gap-1 text-sm font-extrabold tabular-nums leading-none">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                {t.left == null ? t.taken : t.left}
              </span>
              <span className="text-[10.5px] font-semibold leading-none max-w-full truncate">{t.short}</span>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onSubmit} className="liquid-glass-button w-full min-h-[40px] rounded-full text-[13px] font-extrabold flex items-center justify-center gap-1.5">
        <Plus className="w-4 h-4" /> Submit leave
      </button>
    </div>
  );
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (ds: string) => `${Number(ds.slice(8, 10))} ${MONTH_SHORT[Number(ds.slice(5, 7)) - 1]}`;

const STATUS = {
  pending: { label: 'In review', soft: '#fef3c7', fg: '#92400e' },
  approved: { label: 'Approved', soft: '#dcfce7', fg: '#166534' },
  rejected: { label: 'Rejected', soft: '#ffe4e6', fg: '#9f1239' }
};

export const LeavePhoneCard: React.FC<{ app: LeaveApplication; typeLabel: string; style: { soft: string; fg: string } }> = ({ app: a, typeLabel, style }) => {
  const start = String(a.start_date).slice(0, 10);
  const end = String(a.end_date).slice(0, 10);
  const range = start === end ? `${dayMonth(start)} ${start.slice(0, 4)}` : `${dayMonth(start)} – ${dayMonth(end)} ${end.slice(0, 4)}`;
  const st = STATUS[a.status];
  const decided = a.decided_at ? ` on ${dayMonth(String(a.decided_at).slice(0, 10))}` : '';
  const note =
    a.status === 'pending'
      ? a.no_approver
        ? 'No approver set yet — tell HR'
        : `Waiting on ${a.approver_name || 'approver'}${a.total_steps ? ` (layer ${a.current_step} of ${a.total_steps})` : ''}`
      : a.status === 'approved'
      ? `Approved${a.decided_by_name ? ` by ${a.decided_by_name}` : ''}${decided}`
      : a.remarks
      ? `Reason: ${a.remarks}`
      : `Rejected${a.decided_by_name ? ` by ${a.decided_by_name}` : ''}${decided}`;
  const Icon = a.status === 'pending' ? Clock : a.status === 'approved' ? Check : X;

  return (
    // No backdrop-blur per card (a blur layer per list item stutters on
    // Android); a more opaque white keeps the glass look.
    <div className="rounded-[22px] p-3 flex flex-col gap-2.5 bg-white/80 border border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,.9),0_8px_20px_-14px_rgba(15,23,42,.35)]">
      <div className="flex items-center gap-3">
        <div className="w-12 h-[52px] rounded-2xl flex flex-col items-center justify-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,.8)]" style={{ background: style.soft, color: style.fg }}>
          <span className="text-lg font-extrabold leading-none">{Number(start.slice(8, 10))}</span>
          <span className="text-[10px] font-bold mt-[3px]">{MONTH_SHORT[Number(start.slice(5, 7)) - 1]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-900 truncate">
            {typeLabel} · {plural(Number(a.day_count))}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5 truncate">{range}</div>
        </div>
        <div className="text-[11px] font-bold px-2.5 py-[5px] rounded-full whitespace-nowrap" style={{ background: st.soft, color: st.fg }}>
          {st.label}
        </div>
      </div>
      <div
        className="liquid-glass-inset rounded-[14px] px-2.5 py-2 text-xs flex items-start gap-1.5"
        style={{ color: a.status === 'pending' ? '#92400e' : a.status === 'rejected' ? '#9f1239' : '#3f3f46' }}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span className="min-w-0 break-words">{note}</span>
      </div>
    </div>
  );
};
