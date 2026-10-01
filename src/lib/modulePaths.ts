/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Breadcrumb trail (ModulePath) for every Admin Panel tab — same grouping
// and labels as the sidebar (GlobalSidebar.tsx): Admin Panel -> PEPM
// Management / HRM (with its Attendance, Claims/Bill/Disbursement,
// Employee, HR Advanced sub-groups) / MIS.
const HRM = ['Admin Panel', 'HRM'];

export const ADMIN_TAB_PATH: Record<string, string[]> = {
  dashboard: ['Admin Panel', 'Admin Dashboard'],

  reports: ['Admin Panel', 'PEPM Management', 'Reports'],
  mprs: ['Admin Panel', 'PEPM Management', 'MPR Nos'],
  imports: ['Admin Panel', 'PEPM Management', 'Data Import'],
  recycle: ['Admin Panel', 'PEPM Management', 'Job Recycle'],
  editlog: ['Admin Panel', 'PEPM Management', 'MPR Edit Log'],

  approvals: [...HRM, 'Approval Chain'],
  notices: [...HRM, 'Notices'],
  holidays: [...HRM, 'Holidays'],
  leave_applications: [...HRM, 'Monthly Leave Application'],
  departments: [...HRM, 'Departments'],

  attendance: [...HRM, 'Attendance', 'Remote Attendance'],
  attendance_reports: [...HRM, 'Attendance', 'Monthly Attendance Report'],
  office_attendance: [...HRM, 'Attendance', 'Office Attendance'],

  claims: [...HRM, 'Claims/Bill/Disbursement', 'Movement Claims'],
  conveyance: [...HRM, 'Claims/Bill/Disbursement', 'Bill Claim'],
  disbursement: [...HRM, 'Claims/Bill/Disbursement', 'Bill Disbursement'],
  my_conveyance: [...HRM, 'Claims/Bill/Disbursement', 'My Conveyance Bill Claim'],
  bill_claim_policy: [...HRM, 'Claims/Bill/Disbursement', 'Bill Claim Policy'],

  employees: [...HRM, 'Employee', 'Employees'],
  tracking: [...HRM, 'Employee', 'Employee Tracking'],
  asset_management: [...HRM, 'Employee', 'Asset Management'],
  vehicle_management: [...HRM, 'Employee', 'Vehicle Management'],

  exit_offboarding: [...HRM, 'HR Advanced', 'Exit / Offboarding'],
  performance_management: [...HRM, 'HR Advanced', 'Performance Management'],
  recruitment: [...HRM, 'HR Advanced', 'Recruitment (ATS)'],
  grievance_disciplinary: [...HRM, 'HR Advanced', 'Grievance & Disciplinary'],
  hr_analytics: [...HRM, 'HR Advanced', 'HR Analytics'],
  document_vault: [...HRM, 'HR Advanced', 'Document Vault'],
  hr_operations: [...HRM, 'HR Operations'],

  users: ['Admin Panel', 'MIS', 'Users'],
  projects: ['Admin Panel', 'MIS', 'Projects'],
  branches: ['Admin Panel', 'MIS', 'Branches'],

  permanent_delete_log: ['Admin Panel', 'Permanent Delete Log'],
  companies: ['Admin Panel', 'Companies'],
  devices: ['Admin Panel', 'Device Access'],
  servers: ['Admin Panel', 'Servers']
};
