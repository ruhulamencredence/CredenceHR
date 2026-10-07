/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride look — the app's violet accent (--g-accent*) and liquid-glass
// pieces, shared by VehicleManagement.tsx and RideDestinationPicker.tsx so
// the web and mobile screens read as one design.

import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

// Desktop card: frosted white with a soft violet shadow.
export const RIDE_CARD =
  'rounded-[28px] border border-white/80 bg-white/85 backdrop-blur-sm shadow-[0_18px_40px_-24px_rgba(85,0,170,0.45),inset_0_1px_0_rgba(255,255,255,0.8)]';
// Well inside a card (route box, info rows).
export const RIDE_WELL = 'rounded-2xl border border-[var(--g-accent-100)] bg-[var(--g-accent-soft)]/60';
export const RIDE_LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5';
export const RIDE_INPUT =
  'w-full rounded-xl border border-slate-200 bg-white/90 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-[var(--g-accent-400)] focus:ring-2 focus:ring-[var(--g-accent-200)]';
export const RIDE_INPUT_SM =
  'rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-[var(--g-accent-400)] focus:ring-2 focus:ring-[var(--g-accent-200)]';

export const BTN_PRIMARY =
  'liquid-glass-button rounded-full inline-flex items-center justify-center gap-1.5 px-5 py-2.5 text-sm font-semibold disabled:opacity-50';
export const BTN_PRIMARY_SM =
  'liquid-glass-button rounded-full inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold disabled:opacity-50';
export const BTN_SOFT_SM =
  'rounded-full inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-[var(--g-accent-soft)] text-[color:var(--g-accent-700)] hover:bg-[var(--g-accent-100)] transition-colors disabled:opacity-40';
export const BTN_GHOST_SM =
  'rounded-full inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors';
export const BTN_WARN_SM =
  'rounded-full inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors';

export type RideStatus = 'pending' | 'approved' | 'ongoing' | 'rejected' | 'cancelled' | 'completed' | 'expired';

const CHIP: Record<RideStatus, { cls: string; dot: string }> = {
  pending: { cls: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  approved: { cls: 'bg-[var(--g-accent-soft)] text-[color:var(--g-accent-700)] ring-[var(--g-accent-200)]', dot: 'bg-[var(--g-accent)]' },
  ongoing: { cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500 animate-pulse' },
  rejected: { cls: 'bg-rose-50 text-rose-700 ring-rose-200', dot: 'bg-rose-500' },
  cancelled: { cls: 'bg-slate-100 text-slate-600 ring-slate-200', dot: 'bg-slate-400' },
  completed: { cls: 'bg-sky-50 text-sky-700 ring-sky-200', dot: 'bg-sky-500' },
  expired: { cls: 'bg-orange-50 text-orange-700 ring-orange-200', dot: 'bg-orange-500' }
};

export function RideStatusChip({ status, label }: { status: RideStatus; label: string }) {
  const c = CHIP[status] || CHIP.cancelled;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${c.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {label}
    </span>
  );
}

// Pickup -> destination as a little timeline (violet ring, then a red pin).
export function RideRoute({ from, to, compact = false }: { from: string; to: string; compact?: boolean }) {
  return (
    <div className="flex gap-2.5 min-w-0">
      <div className="flex flex-col items-center pt-1.5 shrink-0">
        <span className="w-2.5 h-2.5 rounded-full border-[2.5px] border-[var(--g-accent)] bg-white" />
        <span className={`w-px flex-1 border-l-2 border-dotted border-[var(--g-accent-300)] ${compact ? 'my-0.5' : 'my-1'}`} />
        <span className="w-2.5 h-2.5 rounded-[3px] bg-rose-500" />
      </div>
      <div className={`min-w-0 ${compact ? 'space-y-1' : 'space-y-2'}`}>
        <div className="text-[13px] text-slate-500 truncate" title={from}>
          {from}
        </div>
        <div className="text-sm font-semibold text-slate-900 truncate" title={to}>
          {to}
        </div>
      </div>
    </div>
  );
}

export function RideBanner({ tone, children }: { tone: 'success' | 'error' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'success'
      ? 'bg-emerald-50/90 text-emerald-800 border-emerald-200'
      : tone === 'error'
        ? 'bg-rose-50/90 text-rose-700 border-rose-200'
        : 'bg-[var(--g-accent-soft)]/80 text-[color:var(--g-accent-800)] border-[var(--g-accent-100)]';
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div className={`flex items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-sm ${cls}`}>
      {tone !== 'info' && <Icon className="w-4 h-4 mt-0.5 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
