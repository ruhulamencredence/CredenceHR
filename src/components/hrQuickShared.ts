/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared by HR Operations -> Reports -> Quick reports (HrQuickReports.tsx)
// and the Admin Dashboard's "HR reports" card (AdminDashboardHrReports.tsx):
// the reports and the text on their cards. Kept apart so the dashboard
// doesn't load the PDF / Excel code.

export type QuickKind = 'probation' | 'joiners' | 'transfers' | 'resignations' | 'religion' | 'attendance' | 'leave' | 'contracts' | 'headcount' | 'records';
// The Admin Dashboard's "HR reports" card opens a report through this key.
export const QUICK_KIND_STORAGE_KEY = 'hr_ops_quick_kind';

export interface QuickSummary {
  month: string;
  probation: { due_30: number; overdue: number; confirmed: number };
  joiners: { joined: number; top: { label: string; count: number }[] };
  transfers: { transfers: number; scheduled: number };
  religion: { total: number; religions: number; not_recorded: number; top: { label: string; count: number }[] };
  resignations: { in_notice: number; leaving_30: number; submitted: number };
  attendance?: { low: number; often_late: number; checked: number };
  leave?: { low: number; lwp: number };
  contracts?: { due_60: number; ended: number };
  headcount?: { total: number; male: number; female: number };
  records?: { expired: number; unsigned: number; no_login: number };
}

export const QUICK_KINDS: { key: QuickKind; title: string }[] = [
  { key: 'probation', title: 'Probation / Confirmation' },
  { key: 'joiners', title: 'New joiners' },
  { key: 'transfers', title: 'Transfers' },
  { key: 'resignations', title: 'Resignations & exits' },
  { key: 'religion', title: 'Religion' },
  { key: 'attendance', title: 'Attendance watch' },
  { key: 'leave', title: 'Leave watch' },
  { key: 'contracts', title: 'Contracts ending' },
  { key: 'headcount', title: 'Headcount mix' },
  { key: 'records', title: 'Records to fix' }
];

// The five cards' numbers, the same on HR Operations and the Admin Dashboard.
export function quickCardText(k: QuickKind, s: QuickSummary): { label: string; big: string; small: string } {
  switch (k) {
    case 'probation':
      return { label: 'Probation / confirmation', big: String(s.probation.due_30 + s.probation.overdue), small: `probation ends in 30 days${s.probation.overdue ? ` · ${s.probation.overdue} overdue` : ''}` };
    case 'joiners':
      return { label: 'New joiners', big: String(s.joiners.joined), small: s.joiners.top.length ? s.joiners.top.map((t) => `${t.label} ${t.count}`).join(' · ') : 'joined this month' };
    case 'transfers':
      return { label: 'Transfers', big: String(s.transfers.transfers), small: `this month${s.transfers.scheduled ? ` · ${s.transfers.scheduled} take${s.transfers.scheduled === 1 ? 's' : ''} effect later` : ''}` };
    case 'resignations':
      return { label: 'Resignations', big: String(s.resignations.in_notice), small: `in notice${s.resignations.leaving_30 ? ` · ${s.resignations.leaving_30} leave in 30 days` : ''}` };
    case 'religion':
      return { label: 'Religion', big: String(s.religion.religions), small: `religions${s.religion.not_recorded ? ` · ${s.religion.not_recorded} not recorded` : ''}` };
    case 'attendance': {
      const a = s.attendance || { low: 0, often_late: 0, checked: 0 };
      return { label: 'Attendance watch', big: String(a.low), small: `under 80% this month${a.often_late ? ` · ${a.often_late} often late` : ''}` };
    }
    case 'leave': {
      const l = s.leave || { low: 0, lwp: 0 };
      return { label: 'Leave watch', big: String(l.low), small: `leave almost used up${l.lwp ? ` · ${l.lwp} took leave without pay` : ''}` };
    }
    case 'contracts': {
      const c = s.contracts || { due_60: 0, ended: 0 };
      return { label: 'Contracts ending', big: String(c.due_60), small: `in 60 days${c.ended ? ` · ${c.ended} already ended` : ''}` };
    }
    case 'headcount': {
      const h = s.headcount || { total: 0, male: 0, female: 0 };
      return { label: 'Headcount mix', big: String(h.total), small: `${h.male} male · ${h.female} female` };
    }
    case 'records': {
      const r = s.records || { expired: 0, unsigned: 0, no_login: 0 };
      return { label: 'Records to fix', big: String(r.expired + r.unsigned + r.no_login), small: `${r.expired} expired doc · ${r.unsigned} to sign · ${r.no_login} no login` };
    }
  }
}


// Before opening HR Operations from elsewhere (the Admin Dashboard): land on
// Reports -> Quick reports with this report open.
export function presetQuickReport(k: QuickKind) {
  try {
    sessionStorage.setItem('hr_ops_tab', 'reports');
    sessionStorage.setItem('hr_ops_reports_view', 'quick');
    sessionStorage.setItem(QUICK_KIND_STORAGE_KEY, k);
  } catch {
    // storage unavailable — HR Operations opens on its first tab
  }
}
