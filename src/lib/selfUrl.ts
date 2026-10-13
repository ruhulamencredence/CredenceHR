// Self Service page <-> browser address (/self/my-tasks, /self/payroll…).
// Same idea as adminUrl.ts for the Admin Panel tabs.

import type { User } from '../types';

export type SelfView =
  | 'leaveManagement' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory' | 'resignation'
  | 'assetManagement' | 'vehicleManagement' | 'myCases' | 'myLetters' | 'teamAttendance' | 'myTasks' | 'myMobileSim' | 'myLoans';

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
  myLoans: 'my-loans'
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
    default: return true;
  }
};
