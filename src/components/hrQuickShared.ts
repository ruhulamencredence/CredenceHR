/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared by HR Operations -> Reports -> Quick reports (HrQuickReports.tsx)
// and the Admin Dashboard's "HR reports" card (AdminDashboardHrReports.tsx):
// the five reports and the text on their cards. Kept apart so the dashboard
// doesn't load the PDF / Excel code.

export type QuickKind = 'probation' | 'joiners' | 'transfers' | 'resignations' | 'religion';
// The Admin Dashboard's "HR reports" card opens a report through this key.
export const QUICK_KIND_STORAGE_KEY = 'hr_ops_quick_kind';

export interface QuickSummary {
  month: string;
  probation: { due_30: number; overdue: number; confirmed: number };
  joiners: { joined: number; top: { label: string; count: number }[] };
  transfers: { transfers: number; scheduled: number };
  religion: { total: number; religions: number; not_recorded: number; top: { label: string; count: number }[] };
  resignations: { in_notice: number; leaving_30: number; submitted: number };
}

export const QUICK_KINDS: { key: QuickKind; title: string }[] = [
  { key: 'probation', title: 'Probation / Confirmation' },
  { key: 'joiners', title: 'New joiners' },
  { key: 'transfers', title: 'Transfers' },
  { key: 'resignations', title: 'Resignations & exits' },
  { key: 'religion', title: 'Religion' }
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
