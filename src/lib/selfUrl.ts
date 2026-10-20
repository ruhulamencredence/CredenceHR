// Self Service page <-> browser address (/self/my-tasks, /self/payroll…).
// Same idea as adminUrl.ts for the Admin Panel tabs.

import type { User } from '../types';

export type SelfView =
  | 'leaveManagement' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory' | 'resignation'
  | 'assetManagement' | 'vehicleManagement' | 'myCases' | 'myLetters' | 'teamAttendance' | 'myTasks' | 'myMobileSim' | 'myLoans' | 'myTargets' | 'credenceMail' | 'myRoster' | 'myBreak' | 'mySignatures' | 'myPayslips' | 'materialReceive';

const SLUGS: Record<SelfView, string> = {
  leaveManagement: 'leave-management',
  timesheet: 'timesheet',
  approveApplications: 'approve-applications',
  payroll: 'payroll',
  employeeDirectory: 'employee-directory',
  resignation: 'resignation',
  assetManagement: 'asset-management',
  vehicleManagement: 'vehicle-management',
  myCases: 'my-cases',
  myLetters: 'my-letters',
  teamAttendance: 'team-attendance',
  myTasks: 'my-tasks',
  myMobileSim: 'my-mobile-sim',
  myLoans: 'my-loans',
  myTargets: 'my-targets',
  credenceMail: 'mail',
  myRoster: 'duty-roster',
  myBreak: 'break-time',
  materialReceive: 'material-receive',
  mySignatures: 'documents-to-sign',
  myPayslips: 'payslips'
};

export const SELF_URL_PREFIX = '/self/';

export const selfViewToPath = (view: SelfView) => `${SELF_URL_PREFIX}${SLUGS[view]}`;

export const selfPathToView = (pathname: string): SelfView | null => {
  const m = /^\/self\/([a-z0-9-]+)\/?$/i.exec(pathname);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return (Object.keys(SLUGS) as SelfView[]).find((v) => SLUGS[v] === slug) || null;
};

// Same access the menu item is shown under (GlobalSidebar). The pages' APIs
// still check on their own — this only keeps an address from showing a page
// the menu would not.
export const canOpenSelfView = (view: SelfView, user: User | null): boolean => {
  if (!user) return false;
  const sa = user.role === 'superadmin';
  const mods = user.module_permissions || [];
  switch (view) {
    case 'payroll': return sa || mods.includes('payroll');
    case 'leaveManagement': return sa || !!user.can_manage_leave;
    case 'timesheet': return sa || !!user.can_view_timesheet;
    case 'myTasks': return sa || !!user.can_view_tasks || mods.includes('task_management');
    case 'myMobileSim': return sa || !!user.can_view_mobile_bill || mods.includes('mobile_bill');
    case 'myLoans': return sa || !!user.can_view_loan_request;
    case 'myTargets': return sa || !!user.can_view_targets;
    case 'credenceMail': return sa || !!user.can_use_mail;
    case 'myRoster': return sa || !!user.can_view_roster;
    case 'myBreak': return sa || !!user.can_take_break;
    case 'mySignatures': return sa || !!user.can_sign_documents;
    case 'myPayslips': return sa || !!user.can_view_payslip;
    case 'materialReceive': return sa || !!user.can_receive_material;
    default: return true;
  }
};
