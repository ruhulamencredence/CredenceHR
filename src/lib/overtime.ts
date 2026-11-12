/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Overtime (OvertimeRoutes.ts) — small labels shared by OT Approval, Team OT,
// My OT and OT Rules.

export const hoursText = (minutes: number) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return !h && r ? `${r} m` : r ? `${h} h ${r} m` : `${h} h`;
};
// "2:30" <-> 150 minutes, for the hours box an approver can trim.
export const hm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(Math.round(minutes) % 60).padStart(2, '0')}`;
export const parseHm = (v: string): number | null => {
  const s = String(v || '').trim();
  const m = /^(\d{1,2})(?::([0-5]?\d))?$/.exec(s) || /^(\d{1,2})\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  if (s.includes('.')) return Math.round(Number(s) * 60);
  return Number(m[1]) * 60 + Number(m[2] || 0);
};
export const timeOnly = (v: string | null) => {
  if (!v) return '—';
  const t = /(\d{2}):(\d{2})/.exec(String(v).slice(10));
  if (!t) return '—';
  const h = Number(t[1]);
  return `${((h + 11) % 12) + 1}:${t[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};
export const otStatusLabel = (s: string) =>
  s === 'auto' ? 'Approved (planned)' : s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected' : s === 'not_eligible' ? 'Not paid' : 'Waiting';
export const otStatusTone = (s: string) =>
  s === 'auto' || s === 'approved' ? 'bg-emerald-50 text-emerald-700' : s === 'rejected' ? 'bg-rose-50 text-rose-700' : s === 'not_eligible' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700';
export const APPROVER_MODE_LABEL: Record<string, string> = {
  supervisor: 'Team Supervisor',
  roster_manager: 'Roster manager',
  either: 'Either one',
  both: 'Both, one after the other'
};
