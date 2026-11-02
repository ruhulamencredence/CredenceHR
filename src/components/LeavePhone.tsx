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
      className="liquid-glass rounded-[28px] px-4 pt-4 pb-4 flex flex-col items-center gap-3"
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.95), inset 0 -1px 1px rgba(255,255,255,.35), 0 10px 30px -16px rgba(var(--g-accent-rgb,127,0,255),.3)' }}
    >
      <div className="relative w-[200px] h-[108px]">
        <svg width="200" height="108" viewBox="0 0 200 108" role="img" aria-label={`${big} ${caption}`}>
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
          <div className="text-[28px] font-extrabold leading-none tracking-tight" style={{ color: centerColor }}>{big}</div>
          <div className="text-[11px] text-zinc-500 mt-1 truncate">{caption}</div>
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
      <button type="button" onClick={onSubmit} className="liquid-glass-button w-full min-h-[52px] rounded-full text-[15px] font-extrabold flex items-center justify-center gap-2">
        <Plus className="w-[18px] h-[18px]" strokeWidth={2.6} /> Submit leave
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

// "Casual" -> "CL", "Sick" -> "SL", "Leave Without Pay" -> "LWP".
const typeBadge = (label: string) => {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return `${(words[0] || 'L')[0]}L`.toUpperCase();
};

// One application on a phone: type badge, type + purpose, status chip; a
// From / To / Days row; and who it waits on or who decided it.
export const LeavePhoneCard: React.FC<{ app: LeaveApplication; typeLabel: string; style: { soft: string; fg: string } }> = ({ app: a, typeLabel, style }) => {
  const start = String(a.start_date).slice(0, 10);
  const end = String(a.end_date).slice(0, 10);
  const st = STATUS[a.status];
  const decided = a.decided_at ? ` · ${dayMonth(String(a.decided_at).slice(0, 10))}` : '';
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
  const title = /leave/i.test(typeLabel) ? typeLabel : `${typeLabel} leave`;
  const cell = (label: string, value: string) => (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold text-zinc-500">{label}</div>
      <div className="text-[12.5px] font-bold text-slate-900 mt-0.5 truncate">{value}</div>
    </div>
  );

  return (
    // No backdrop-blur per card (a blur layer per list item stutters on
    // Android).
    <div className="rounded-[24px] px-4 py-3.5 flex flex-col gap-3 bg-white shadow-[0_10px_30px_-14px_rgba(var(--g-accent-rgb,127,0,255),.28),0_2px_6px_-2px_rgba(15,23,42,.06)]">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0 text-xs font-extrabold" style={{ background: style.soft, color: style.fg }}>
          {typeBadge(typeLabel)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-900 truncate">{title}</div>
          {a.purpose && <div className="text-[11.5px] font-medium text-zinc-500 mt-0.5 truncate">{a.purpose}</div>}
        </div>
        <div className="text-[11px] font-bold px-2.5 py-[5px] rounded-full whitespace-nowrap" style={{ background: st.soft, color: st.fg }}>
          {st.label}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-50/80 px-3 py-2.5">
        {cell('From', `${dayMonth(start)}${start.slice(0, 4) !== end.slice(0, 4) ? ` ${start.slice(0, 4)}` : ''}`)}
        {cell('To', `${dayMonth(end)} ${end.slice(0, 4)}`)}
        {cell('Days', String(Number(a.day_count)))}
      </div>
      <div
        className="text-xs flex items-start gap-1.5"
        style={{ color: a.status === 'pending' ? '#92400e' : a.status === 'rejected' ? '#9f1239' : '#3f3f46' }}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 mt-px" style={a.status === 'approved' ? { color: '#16a34a' } : undefined} />
        <span className="min-w-0 break-words">{note}</span>
      </div>
    </div>
  );
};
