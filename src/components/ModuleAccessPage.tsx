/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> Module Access. One section at a time (left rail, a
// chip row on a phone); each section shows the switches for the person's own
// pages next to the Admin Panel modules of the same area, with each module's
// permission layers as chips right under it.
//
// Several accounts can be edited together: a setting they don't share shows
// as mixed ("1 of 3") and keeps each account's own value until it's changed.
// Save sends only what changed, per account, through the same per-user
// endpoints as before (UserManagement.ts), so the server's checks and the
// access audit log apply to every account individually.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Search, Copy, Users as UsersIcon, X, Check, ChevronDown, Building2, AlertTriangle, Smartphone, LayoutTemplate, Save } from 'lucide-react';
import {
  ADMIN_MODULES,
  AdminModuleKey,
  Department,
  EXPLICIT_ONLY_LAYERS,
  LEAVE_MANAGE_LAYERS,
  LEAVE_MANAGE_EXPLICIT_ONLY,
  PERMISSION_LAYER_MODULES,
  User,
  layersFor
} from '../types';
import { apiUrl } from '../lib/api';
import { AccessViewer, AccessTemplate, TemplateAccess, TEMPLATE_FEATURES, canEditUserModules } from '../lib/accessTemplates';
import { confirmDialog } from '../lib/confirmDialog';
import { ModuleAccessChecklist } from './ModuleAccessChecklist';

import { SearchSelect } from './Combobox';
import { personLabel, personDetails } from '../lib/personLabel';
type SectionKey = 'general' | 'pepm' | 'hr' | 'attendance' | 'claims' | 'employees' | 'hrops' | 'payroll' | 'mail' | 'mis' | 'other';

const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: 'general', label: 'General', hint: 'Panels, calls, emailing reports and the AI Assistant.' },
  { key: 'pepm', label: 'PEPM', hint: 'Budgets, MPR entries, reports and material dispatch.' },
  { key: 'hr', label: 'HR', hint: 'Dashboard, approvals, notices, departments, tasks and targets.' },
  { key: 'attendance', label: 'Attendance & Leave', hint: 'Attendance, roster, leave applications and leave balances.' },
  { key: 'claims', label: 'Claims & Bills', hint: 'Check In/Out and bill claims, disbursement and mobile bills.' },
  { key: 'employees', label: 'Employees & Assets', hint: 'Employee records, tracking, assets and vehicles.' },
  { key: 'hrops', label: 'HR Operations', hint: 'Onboarding, exit, performance, recruitment and documents.' },
  { key: 'payroll', label: 'Payroll', hint: 'Salary, payslips and loans.' },
  { key: 'mail', label: 'Mail', hint: 'Credence Mail and Mail Administration.' },
  { key: 'mis', label: 'MIS & Settings', hint: 'Users, projects and branches.' },
  { key: 'other', label: 'Other', hint: 'Modules not placed in a section yet.' }
];

// Per-account switches. endpoint null = PUT /api/users/:id/feature-permissions.
type FlagKey =
  | 'can_access_user_panel'
  | 'can_use_attendance'
  | 'can_use_tracking'
  | 'can_view_leave_summary'
  | 'can_edit_delivery_date'
  | 'can_job_edit'
  | 'can_manage_leave'
  | 'can_view_movement_claims'
  | 'can_view_bill_claims'
  | 'can_view_budget_module'
  | 'can_view_timesheet'
  | 'can_view_leave_application'
  | 'can_view_group_dashboard'
  | 'can_view_tasks'
  | 'can_view_mobile_bill'
  | 'can_view_service_book'
  | 'can_view_loan_request'
  | 'can_view_targets'
  | 'can_use_ai_assistant'
  | 'can_export_assistant_reports'
  | 'can_handle_assistant_support'
  | 'can_use_calls'
  | 'can_use_disappearing'
  | 'can_use_chat'
  | 'can_use_mail'
  | 'can_view_mail_directory'
  | 'can_use_mail_groups'
  | 'can_receive_material'
  | 'can_return_dispatch'
  | 'can_give_feedback'
  | 'can_use_fingerprint'
  | 'can_view_roster'
  | 'can_take_break'
  | 'can_save_ride_places'
  | 'can_update_check_out'
  | 'can_add_adhoc_approver'
  | 'can_use_assistant_voice'
  | 'can_sign_documents'
  | 'can_view_payslip'
  | 'can_request_items'
  | 'can_email_reports'
  | 'can_view_my_ot'
  | 'can_approve_team_ot';

interface FlagDef {
  key: FlagKey;
  label: string;
  desc: string;
  section: SectionKey;
  endpoint: string | null;
  // On unless turned off (the column defaults to true).
  defaultOn?: boolean;
  // Only for role 'admin' accounts.
  adminOnly?: boolean;
  // Shown under this switch, only while it's on.
  parent?: FlagKey;
}

const FLAGS: FlagDef[] = [
  { key: 'can_access_user_panel', label: 'User Panel access', desc: 'This Admin also gets the User Panel (attendance, claims, job entry).', section: 'general', endpoint: 'user-panel-access', adminOnly: true },
  { key: 'can_use_chat', label: 'Chat', desc: 'Messages with other accounts (one-to-one, groups). On by default.', section: 'general', endpoint: 'chat-access', defaultOn: true },
  { key: 'can_use_calls', label: 'Audio / Video Calls', desc: 'Call, and be called by, other accounts from a one-to-one Chat (needs Chat).', section: 'general', endpoint: 'calls-access' },
  { key: 'can_use_disappearing', label: 'Disappearing messages', desc: 'May turn on disappearing messages in a chat (group: as its admin). Such messages and their files are deleted for good — no record is kept.', section: 'general', endpoint: 'disappearing-access', parent: 'can_use_chat' },
  { key: 'can_email_reports', label: 'Email reports', desc: 'An Email button next to PDF on the reports they can open.', section: 'general', endpoint: 'report-email-access' },
  { key: 'can_use_ai_assistant', label: 'AI Assistant', desc: 'The floating Assistant. On by default.', section: 'general', endpoint: 'ai-assistant-access', defaultOn: true },
  { key: 'can_export_assistant_reports', label: 'Assistant: PDF / Excel download', desc: 'Download the Assistant’s list answers (only figures they can see).', section: 'general', endpoint: 'assistant-report-access' },
  { key: 'can_use_assistant_voice', label: 'AI Assistant — voice', desc: 'Speak a question with the mic and hear the answer read out. The recording is sent to Google (Gemini) to be written down, then dropped.', section: 'general', endpoint: 'assistant-voice-access', parent: 'can_use_ai_assistant' },
  { key: 'can_handle_assistant_support', label: 'Assistant live support', desc: 'Answer people who ask the Assistant for a human.', section: 'general', endpoint: 'assistant-support-access' },

  { key: 'can_view_budget_module', label: 'Budget / Jobs / Job Entry Details', desc: 'Enter MPRs for their projects. On by default.', section: 'pepm', endpoint: 'budget-module-access', defaultOn: true },
  { key: 'can_job_edit', label: 'Job Edit', desc: 'Change MPRs after Final Submit.', section: 'pepm', endpoint: null },
  { key: 'can_edit_delivery_date', label: 'Edit Delivery Date', desc: 'Change an MPR row’s delivery date.', section: 'pepm', endpoint: null },
  { key: 'can_receive_material', label: 'Material Receive', desc: 'Confirm material Purchase sent to their projects.', section: 'pepm', endpoint: 'material-receive-access' },
  { key: 'can_return_dispatch', label: 'Take back / Confirm in Dispatch', desc: 'Take their own MPR rows back out of Dispatch Material (with a new delivery date), or confirm them, while nothing is sent.', section: 'pepm', endpoint: 'return-dispatch-access' },

  { key: 'can_view_tasks', label: 'My Tasks', desc: 'Tasks given to them, and requests to HR.', section: 'hr', endpoint: 'tasks-access' },
  { key: 'can_view_targets', label: 'My Targets', desc: 'Monthly / yearly targets and their progress.', section: 'hr', endpoint: 'targets-access' },
  { key: 'can_sign_documents', label: 'Documents to Sign', desc: 'Sign documents HR sends them.', section: 'hr', endpoint: 'sign-documents-access' },

  { key: 'can_use_attendance', label: 'Remote Attendance', desc: 'Mark attendance from their phone.', section: 'attendance', endpoint: null },
  { key: 'can_view_timesheet', label: 'Timesheet', desc: 'Own attendance history and Correct Attendance.', section: 'attendance', endpoint: 'timesheet-access' },
  { key: 'can_view_leave_application', label: 'Leave Application', desc: 'Apply for leave and see their own balance.', section: 'attendance', endpoint: 'leave-application-access' },
  { key: 'can_view_leave_summary', label: 'Leave Summary on Dashboard', desc: 'Their leave balance card on the dashboard.', section: 'attendance', endpoint: null },
  { key: 'can_view_roster', label: 'My Duty Roster', desc: 'Their own shifts and Off days.', section: 'attendance', endpoint: 'roster-access' },
  { key: 'can_view_my_ot', label: 'My OT', desc: 'Their own overtime: hours worked out, approved, waiting.', section: 'attendance', endpoint: 'my-ot-access' },
  { key: 'can_approve_team_ot', label: 'Team OT (approve)', desc: 'Approve the overtime of the people they supervise (Direct Supervisor or Site Attendance team), when OT Rules says the Team Supervisor approves.', section: 'attendance', endpoint: 'team-ot-access' },
  { key: 'can_update_check_out', label: 'Remote Attendance — update Out Time', desc: 'Give the Out Time again later the same day (e.g. after tapping it too early); the new time goes for approval again.', section: 'attendance', endpoint: 'check-out-update-access' },
  { key: 'can_take_break', label: 'Break Time', desc: 'Start and end their breaks in the app.', section: 'attendance', endpoint: 'break-access' },
  { key: 'can_save_ride_places', label: 'Book a Ride — saved places', desc: 'Save pickup / drop places (Home, Work…) with a note for the driver, and pick them first next time.', section: 'general', endpoint: 'ride-places-access' },
  { key: 'can_add_adhoc_approver', label: 'Approvals — add an ad-hoc approver', desc: 'On a request waiting on them, ask one more person to approve first; it comes back to them after that person approves.', section: 'general', endpoint: 'adhoc-approver-access' },
  { key: 'can_give_feedback', label: 'Give feedback', desc: 'Rate the app and send problems or ideas (and the 7-day "How do you like the app?").', section: 'general', endpoint: 'feedback-access' },
  { key: 'can_use_fingerprint', label: 'Fingerprint login', desc: 'Sign in with fingerprint / face on their own phone (app) or computer (passkey), turned on from Profile. Turning this off removes the saved fingerprints.', section: 'general', endpoint: 'fingerprint-access' },

  { key: 'can_view_movement_claims', label: 'Check In/Out', desc: 'GPS check in / out claims.', section: 'claims', endpoint: 'movement-claim-access' },
  { key: 'can_view_bill_claims', label: 'Bill Claim', desc: 'Submit bill claims.', section: 'claims', endpoint: 'bill-claim-access' },
  { key: 'can_view_mobile_bill', label: 'My SIM & Bill', desc: 'Their SIMs, limits and bills.', section: 'claims', endpoint: 'mobile-bill-access' },

  { key: 'can_use_tracking', label: 'Live location tracking', desc: 'Their phone shares its location while on duty.', section: 'employees', endpoint: null },
  { key: 'can_view_service_book', label: 'My Service Book', desc: 'Their own service record, read only.', section: 'employees', endpoint: 'service-book-access' },

  { key: 'can_request_items', label: 'Request SIM / ID Card', desc: 'Ask HR for a company SIM or an ID card (new, lost, damaged).', section: 'hr', endpoint: 'request-items-access' },
  { key: 'can_view_payslip', label: 'My Payslip', desc: 'See and download their approved payslips.', section: 'payroll', endpoint: 'payslip-access' },
  { key: 'can_view_loan_request', label: 'Loan / Advance Request', desc: 'Apply for a loan or salary advance.', section: 'payroll', endpoint: 'loan-request-access' },

  { key: 'can_use_mail', label: 'Credence Mail', desc: 'Connect their company mailbox and read / send mail.', section: 'mail', endpoint: 'mail-access' },
  { key: 'can_view_mail_directory', label: 'Email Directory', desc: 'Find any employee’s email address.', section: 'mail', endpoint: 'mail-directory-access', parent: 'can_use_mail' },
  { key: 'can_use_mail_groups', label: 'My groups', desc: 'Their own named lists of people for To / Cc / Bcc.', section: 'mail', endpoint: 'mail-groups-access', parent: 'can_use_mail' },

  // Shown with the modules they belong to (see MODULE_EXTRA_FLAGS / LEAVE_MANAGE).
  { key: 'can_view_group_dashboard', label: 'See all companies (group view)', desc: 'Admin Dashboard covers the mother and every sister company.', section: 'hr', endpoint: 'group-dashboard-access' },
  { key: 'can_manage_leave', label: 'Leave Manage (leave balances)', desc: 'Edit everyone’s leave balances, categories and policy.', section: 'attendance', endpoint: 'leave-management-access' }
];
const FLAG = Object.fromEntries(FLAGS.map((f) => [f.key, f])) as Record<FlagKey, FlagDef>;
// Not listed as plain switches: drawn with their module instead.
const INLINE_FLAGS: FlagKey[] = ['can_view_group_dashboard', 'can_manage_leave'];

const MODULE_SECTION: Partial<Record<AdminModuleKey, SectionKey>> = {
  reports: 'pepm', mprs: 'pepm', imports: 'pepm', recycle: 'pepm', editlog: 'pepm',
  admin_dashboard: 'hr', approvals: 'hr', notices: 'hr', holidays: 'hr', departments: 'hr', task_management: 'hr', target_reports: 'hr',
  attendance: 'attendance', attendance_reports: 'attendance', office_attendance: 'attendance', duty_roster: 'attendance', break_time: 'attendance', leave_applications: 'attendance',
  claims: 'claims', bill_claim: 'claims', disbursement: 'claims', mobile_bill: 'claims',
  employees: 'employees', tracking: 'employees', asset_management: 'employees', vehicle_management: 'employees', vehicle_maintainer: 'employees',
  hr_operations: 'hrops', exit_offboarding: 'hrops', performance_management: 'hrops', recruitment: 'hrops', grievance_disciplinary: 'hrops', hr_analytics: 'hrops', management_dashboard: 'hr', data_import: 'hr', document_vault: 'hrops',
  payroll: 'payroll',
  mail_admin: 'mail',
  users: 'mis', projects: 'mis', branches: 'mis', user_feedback: 'mis'
};
const sectionOfModule = (k: AdminModuleKey): SectionKey => MODULE_SECTION[k] || 'other';

const MODULE_DESC: Partial<Record<AdminModuleKey, string>> = {
  admin_dashboard: 'Quick View, attendance and leave at a glance.',
  data_import: 'Import from Excel. Tick each kind; having the module itself does not allow importing.',
  reports: 'MPR Entries Report, Budget Submission Status, Dispatch Material.',
  mprs: 'MPR numbers of each project.',
  imports: 'Bulk upload from Excel.',
  recycle: 'Deleted jobs, restore them.',
  editlog: 'Who changed which MPR row.',
  approvals: 'Approval workflows.',
  attendance_reports: 'Monthly attendance by department.',
  leave_applications: 'Who applied for leave, by month.',
  duty_roster: 'Shifts and who works when.',
  break_time: 'Who is on a break, daily totals, over-limit.',
  user_feedback: 'Ratings, problems and ideas people send about the app.',
  bill_claim: 'Review bill claims and conveyance bills.',
  disbursement: 'Pay out approved conveyance bills.',
  mobile_bill: 'Company SIMs, limits and operator bills.',
  vehicle_maintainer: 'Direct Book a ride without approval.',
  users: 'Accounts, roles and access.',
  mail_admin: 'Everyone’s connected mailboxes and central groups.'
};

const LAYER_MODULES = PERMISSION_LAYER_MODULES as readonly string[];
type DeptKind = 'attendance_reports' | 'leave_applications' | 'bill_claim' | 'duty_roster';
const DEPT_KINDS: { module: DeptKind; endpoint: string; title: string; hint: string; preTick: boolean }[] = [
  { module: 'attendance_reports', endpoint: 'attendance-report-departments', title: 'Departments on the Monthly Attendance Report', hint: 'Nothing ticked = every Department.', preTick: true },
  { module: 'leave_applications', endpoint: 'leave-application-departments', title: 'Departments on the Monthly Leave Application report', hint: 'Nothing ticked = every Department.', preTick: true },
  { module: 'bill_claim', endpoint: 'bill-claim-departments', title: 'Departments on Bill Claim', hint: 'Nothing ticked = every Department.', preTick: true },
  { module: 'duty_roster', endpoint: 'roster-departments', title: 'Departments whose roster they set', hint: 'Nothing ticked = every Department and the shifts too (full setup, e.g. HR). Ticked = only those, shifts read only.', preTick: false }
];

interface Access {
  modules: Set<string>;
  layers: Record<string, Set<string>>;
  flags: Record<FlagKey, boolean>;
}
interface DeptState {
  saved: Record<DeptKind, string[]>;
  draft: Record<DeptKind, Set<string>>;
}
// Employee Tracking -> whom they may see (TrackingScope.ts): Departments plus
// single Employees; both empty = everyone.
interface TrackEmployee {
  id: number;
  employee_id: string;
  name: string;
  designation: string;
  department: string;
}
interface TrackScope {
  saved: { departments: string[]; employee_ids: number[] };
  draft: { departments: Set<string>; employees: Set<number> };
  options: TrackEmployee[];
}
const fetchTrackScope = (token: string, userId: number) =>
  fetch(apiUrl(`/api/users/${userId}/tracking-scope`), { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((d: any) => ({
      departments: Array.isArray(d?.departments) ? (d.departments as string[]) : [],
      employee_ids: Array.isArray(d?.employee_ids) ? (d.employee_ids as number[]).map(Number) : [],
      employees: Array.isArray(d?.employees) ? (d.employees as TrackEmployee[]) : []
    }));

const flagOf = (u: User, k: FlagKey): boolean => {
  const v = (u as any)[k];
  if (k === 'can_view_leave_application') return !!u.can_view_leave_application || !!u.can_view_my_leave;
  return FLAG[k].defaultOn ? v !== false : !!v;
};

const defaultLayers = (m: string) => layersFor(m as AdminModuleKey).map((l) => l.key as string).filter((k) => !EXPLICIT_ONLY_LAYERS.includes(k as any));

// Same defaults as the server: a granted module with no saved layer rows has
// every layer but the explicit-only ones; Leave Manage with none has all.
function accessOf(u: User): Access {
  const modules = new Set<string>(u.module_permissions || []);
  const layers: Record<string, Set<string>> = {};
  for (const m of LAYER_MODULES) {
    const saved = u.module_permission_layers?.[m];
    layers[m] = new Set(saved && saved.length > 0 ? saved : modules.has(m) ? defaultLayers(m) : []);
  }
  const savedLeave = u.module_permission_layers?.leave_manage;
  layers.leave_manage = new Set(savedLeave && savedLeave.length > 0 ? savedLeave : u.can_manage_leave ? LEAVE_MANAGE_LAYERS.map((l) => l.key).filter((k) => !LEAVE_MANAGE_EXPLICIT_ONLY.includes(k)) : []);
  const flags = Object.fromEntries(FLAGS.map((f) => [f.key, flagOf(u, f.key)])) as Record<FlagKey, boolean>;
  if (u.role !== 'admin') flags.can_access_user_panel = false;
  return { modules, layers, flags };
}
const cloneAccess = (a: Access): Access => ({
  modules: new Set(a.modules),
  layers: Object.fromEntries(Object.entries(a.layers).map(([k, v]) => [k, new Set(v)])),
  flags: { ...a.flags }
});
// Mobile App (APK) access (AppAccess.ts on the server): the app switched on
// at all, and — once given its own ticks (custom) — which modules / switches
// it has. Not custom = the app has exactly what the website has. An App
// tick never gives more than the Web tick.
interface AppAcc {
  can: boolean;
  custom: boolean;
  items: Set<string>;
}
const cloneApp = (p: AppAcc): AppAcc => ({ can: p.can, custom: p.custom, items: new Set(p.items) });
const webItems = (a: Access) => {
  const out = new Set<string>(a.modules);
  for (const f of FLAGS) if (a.flags[f.key]) out.add(f.key);
  return out;
};
// What the app ends up with, written so two states can be compared.
const appKey = (p: AppAcc, a: Access) => {
  const web = webItems(a);
  return `${p.can ? 1 : 0}|${p.custom ? [...p.items].filter((k) => web.has(k)).sort().join(',') : '='}`;
};
const fetchAppAccess = (token: string, ids: number[]): Promise<Record<number, AppAcc>> =>
  fetch(apiUrl(`/api/app-access?ids=${ids.join(',')}`), { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .catch(() => ({ items: [] }))
    .then((d: any) =>
      Object.fromEntries(
        (Array.isArray(d?.items) ? d.items : []).map((x: any) => [Number(x.id), { can: !!x.can_use_app, custom: !!x.custom, items: new Set<string>((x.app || []).map(String)) }])
      )
    );

const sameSet = (a: Set<string> | string[], b: Set<string> | string[]) => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

interface Change {
  label: string;
  run: () => Promise<void>;
}

// Everything that differs between an account's saved access and its draft,
// as the requests that save it.
function changesFor(token: string, u: User, base: Access, draft: Access, dept: DeptState | undefined, track?: TrackScope, appBase?: AppAcc, appDraft?: AppAcc): Change[] {
  const put = async (path: string, body: unknown) => {
    const res = await fetch(apiUrl(`/api/users/${u.id}/${path}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Update failed');
  };
  const out: Change[] = [];
  if (!sameSet(base.modules, draft.modules)) {
    const n = [...draft.modules].filter((m) => !base.modules.has(m)).length + [...base.modules].filter((m) => !draft.modules.has(m)).length;
    out.push({ label: `${n} module${n === 1 ? '' : 's'}`, run: () => put('module-permissions', { modules: [...draft.modules] }) });
  }
  for (const m of LAYER_MODULES) {
    if (!draft.modules.has(m)) continue;
    if (base.modules.has(m) && sameSet(base.layers[m] || [], draft.layers[m] || [])) continue;
    out.push({ label: `${m} layers`, run: () => put('module-permission-layers', { module: m, layers: [...(draft.layers[m] || [])] }) });
  }
  if (dept) {
    for (const d of DEPT_KINDS) {
      if (!draft.modules.has(d.module) || sameSet(dept.saved[d.module], dept.draft[d.module])) continue;
      out.push({ label: `${d.module} departments`, run: () => put(d.endpoint, { departments: [...dept.draft[d.module]] }) });
    }
  }
  if (track && draft.modules.has('tracking') && (!sameSet(track.saved.departments, track.draft.departments) || !sameSet(track.saved.employee_ids.map(String), [...track.draft.employees].map(String)))) {
    out.push({ label: 'Employee Tracking — who they can see', run: () => put('tracking-scope', { departments: [...track.draft.departments], employee_ids: [...track.draft.employees] }) });
  }
  for (const f of FLAGS) {
    if (f.adminOnly && u.role !== 'admin') continue;
    const v = draft.flags[f.key];
    const changed = f.key === 'can_view_leave_application' ? v !== !!u.can_view_leave_application || v !== !!u.can_view_my_leave : v !== base.flags[f.key];
    if (!changed) continue;
    out.push({ label: f.label, run: () => put(f.endpoint ?? 'feature-permissions', { [f.key]: v }) });
  }
  if (draft.flags.can_manage_leave && (!base.flags.can_manage_leave || !sameSet(base.layers.leave_manage, draft.layers.leave_manage))) {
    out.push({ label: 'Leave Manage layers', run: () => put('module-permission-layers', { module: 'leave_manage', layers: [...draft.layers.leave_manage] }) });
  }
  // Saved last, after the website's own access it is narrowed to.
  if (appBase && appDraft && appKey(appBase, base) !== appKey(appDraft, draft)) {
    const web = webItems(draft);
    out.push({
      label: 'Mobile App',
      run: () => put('app-access', { can_use_app: appDraft.can, ...(appDraft.custom ? { app: [...appDraft.items].filter((k) => web.has(k)) } : {}) })
    });
  }
  return out;
}

type Tri = 'on' | 'off' | 'mixed' | 'none';
interface Agg {
  on: number;
  n: number;
  state: Tri;
}

// tone: web = the website (sky), app = the mobile app (violet).
const TONE = {
  web: { on: 'bg-sky-500', mixed: 'bg-[repeating-linear-gradient(135deg,#0ea5e9_0_5px,#cbd5e1_5px_10px)]' },
  app: { on: 'bg-violet-600', mixed: 'bg-[repeating-linear-gradient(135deg,#7c3aed_0_5px,#cbd5e1_5px_10px)]' }
};
const Toggle: React.FC<{ state: Tri; onClick: () => void; label: string; tone?: keyof typeof TONE; disabled?: boolean; hint?: string }> = ({ state, onClick, label, tone = 'web', disabled, hint }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    aria-pressed={state === 'on'}
    title={hint || (state === 'mixed' ? 'Different for the selected accounts — click to turn on for all' : state === 'on' ? 'On — click to turn off' : 'Off — click to turn on')}
    className={`relative inline-flex h-[22px] w-10 items-center rounded-full transition-colors shrink-0 disabled:opacity-35 disabled:cursor-not-allowed ${
      state === 'on' ? TONE[tone].on : state === 'mixed' ? TONE[tone].mixed : 'bg-slate-300'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
        state === 'on' ? 'translate-x-[21px]' : state === 'mixed' ? 'translate-x-[12px]' : 'translate-x-[3px]'
      }`}
    />
  </button>
);

const Box: React.FC<{ state: Tri }> = ({ state }) => (
  <span
    className={`w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center shrink-0 ${
      state === 'on' || state === 'mixed' ? 'bg-violet-600 border-violet-600 text-white' : 'border-slate-400 bg-white'
    }`}
  >
    {state === 'on' && <Check className="w-3 h-3" strokeWidth={3} />}
    {state === 'mixed' && <span className="block w-2 h-0.5 bg-white rounded" />}
  </span>
);

const MixedNote: React.FC<{ agg: Agg }> = ({ agg }) =>
  agg.state === 'mixed' ? <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">{agg.on} of {agg.n}</span> : null;

interface ModuleAccessPageProps {
  token: string;
  users: User[];
  initialIds: number[];
  departments: Department[];
  viewer: AccessViewer;
  // The page Back returns to (Users, or Employees when opened from there).
  backTo?: 'Users' | 'Employees';
  onClose: () => void;
  // After a save: reload the accounts and say how it went.
  onSaved: (text: string, ok: boolean) => void;
  // Access Templates (Users module): "Apply template…" here, and — with the
  // Users module's Edit / Add layer — "Save as template".
  templatesAllowed?: boolean;
  canSaveTemplate?: boolean;
}

export function ModuleAccessPage({ token, users, initialIds, departments, viewer, backTo = 'Users', onClose, onSaved, templatesAllowed = false, canSaveTemplate = false }: ModuleAccessPageProps) {
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const editable = useMemo(() => users.filter((u) => canEditUserModules(u, viewer)), [users, viewer]);

  const [ids, setIds] = useState<number[]>(() => initialIds.filter((id) => userById.has(id)));
  // Saved access of each account taken into the page, and its draft.
  const [base, setBase] = useState<Record<number, Access>>(() =>
    Object.fromEntries(initialIds.filter((id) => userById.has(id)).map((id) => [id, accessOf(userById.get(id)!)]))
  );
  const [drafts, setDrafts] = useState<Record<number, Access>>(() => Object.fromEntries(Object.entries(base).map(([id, a]) => [id, cloneAccess(a)])));
  // Department scopes: fetched for an account while it's edited on its own.
  const [depts, setDepts] = useState<Record<number, DeptState>>({});
  const [loadingDepts, setLoadingDepts] = useState(false);
  const [tracks, setTracks] = useState<Record<number, TrackScope>>({});

  const [section, setSection] = useState<SectionKey>('general');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const selected = ids.map((id) => userById.get(id)).filter(Boolean) as User[];
  const single = selected.length === 1 ? selected[0] : null;

  // Mobile App access of each account, saved and draft (fetched when added).
  const [appBase, setAppBase] = useState<Record<number, AppAcc>>({});
  const [appDrafts, setAppDrafts] = useState<Record<number, AppAcc>>({});
  useEffect(() => {
    const missing = ids.filter((id) => !appBase[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    fetchAppAccess(token, missing).then((got) => {
      if (cancelled) return;
      setAppBase((b) => ({ ...b, ...got }));
      setAppDrafts((d) => ({ ...d, ...Object.fromEntries(Object.entries(got).map(([id, p]) => [id, cloneApp(p)])) }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  const addUsers = (list: User[]) => {
    const fresh = list.filter((u) => !base[u.id]);
    if (fresh.length > 0) {
      const add = Object.fromEntries(fresh.map((u) => [u.id, accessOf(u)]));
      setBase((b) => ({ ...b, ...add }));
      setDrafts((d) => ({ ...d, ...Object.fromEntries(Object.entries(add).map(([id, a]) => [id, cloneAccess(a)])) }));
    }
    setIds((cur) => [...cur, ...list.map((u) => u.id).filter((id) => !cur.includes(id))]);
  };

  const changesOf = (u: User) => (base[u.id] && drafts[u.id] ? changesFor(token, u, base[u.id], drafts[u.id], depts[u.id], tracks[u.id], appBase[u.id], appDrafts[u.id]) : []);
  const pending = selected.map((u) => ({ u, changes: changesOf(u) }));
  const changeCount = pending.reduce((s, p) => s + p.changes.length, 0);
  const changedAccounts = pending.filter((p) => p.changes.length > 0).length;

  const dropUser = async (id: number) => {
    const u = userById.get(id);
    if (u && changesOf(u).length > 0 && !(await confirmDialog(`Drop the unsaved changes for ${u.name}?`, { tone: 'danger' }))) return;
    setIds((cur) => cur.filter((x) => x !== id));
    for (const set of [setBase, setDrafts, setDepts, setTracks, setAppBase, setAppDrafts] as React.Dispatch<React.SetStateAction<Record<number, any>>>[]) {
      set((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };
  const onlyUser = async (u: User) => {
    for (const id of ids) if (id !== u.id) await dropUser(id);
    addUsers([u]);
  };

  // Department scopes of the one account being edited, fetched fresh.
  useEffect(() => {
    if (!single || depts[single.id]) return;
    const u = single;
    let cancelled = false;
    setLoadingDepts(true);
    Promise.all(
      DEPT_KINDS.map((d) =>
        fetch(apiUrl(`/api/users/${u.id}/${d.endpoint}`), { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => (r.ok ? r.json() : { departments: [] }))
          .then((data) => (Array.isArray(data?.departments) ? (data.departments as string[]) : []))
          .catch(() => [] as string[])
      )
    )
      .then((lists) => {
        if (cancelled) return;
        const saved = {} as Record<DeptKind, string[]>;
        const draft = {} as Record<DeptKind, Set<string>>;
        DEPT_KINDS.forEach((d, i) => {
          saved[d.module] = lists[i];
          // A Department they supervise is pre-ticked the first time only.
          const start = lists[i].length === 0 && d.preTick ? departments.filter((x) => x.supervisor_user_id === u.id).map((x) => x.name) : lists[i];
          draft[d.module] = new Set(start);
        });
        setDepts((m) => ({ ...m, [u.id]: { saved, draft } }));
      })
      .finally(() => !cancelled && setLoadingDepts(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single?.id]);

  // Employee Tracking scope of the one account being edited, fetched fresh.
  useEffect(() => {
    if (!single || tracks[single.id]) return;
    const u = single;
    let cancelled = false;
    fetchTrackScope(token, u.id).then((d) => {
      if (cancelled) return;
      setTracks((m) => ({
        ...m,
        [u.id]: { saved: { departments: d.departments, employee_ids: d.employee_ids }, draft: { departments: new Set(d.departments), employees: new Set(d.employee_ids) }, options: d.employees }
      }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single?.id]);
  const editTrack = (fn: (t: TrackScope['draft']) => void) => {
    if (!single) return;
    setTracks((m) => {
      const cur = m[single.id];
      if (!cur) return m;
      const draft = { departments: new Set(cur.draft.departments), employees: new Set(cur.draft.employees) };
      fn(draft);
      return { ...m, [single.id]: { ...cur, draft } };
    });
  };

  // --- reading the selected accounts' drafts ---
  const aggregate = (get: (a: Access) => boolean, eligible: (u: User, a: Access) => boolean = () => true): Agg => {
    let on = 0;
    let n = 0;
    for (const u of selected) {
      const a = drafts[u.id];
      if (!a || !eligible(u, a)) continue;
      n++;
      if (get(a)) on++;
    }
    return { on, n, state: n === 0 ? 'none' : on === 0 ? 'off' : on === n ? 'on' : 'mixed' };
  };
  const flagEligible = (f: FlagDef) => (u: User) => !f.adminOnly || u.role === 'admin';
  const flagAgg = (f: FlagDef) => aggregate((a) => a.flags[f.key], flagEligible(f));
  const moduleAgg = (m: string) => aggregate((a) => a.modules.has(m));
  const layerAgg = (m: string, l: string) => aggregate((a) => !!a.layers[m]?.has(l), (_u, a) => (m === 'leave_manage' ? a.flags.can_manage_leave : a.modules.has(m)));

  // --- changing them: a click sets the same value on every selected account ---
  const edit = (fn: (a: Access, u: User) => void) =>
    setDrafts((d) => {
      const next = { ...d };
      for (const u of selected) {
        if (!next[u.id]) continue;
        const a = cloneAccess(next[u.id]);
        fn(a, u);
        next[u.id] = a;
      }
      return next;
    });
  const setFlag = (f: FlagDef, on: boolean) =>
    edit((a, u) => {
      if (!flagEligible(f)(u)) return;
      a.flags[f.key] = on;
      if (f.key === 'can_manage_leave' && on && a.layers.leave_manage.size === 0) a.layers.leave_manage = new Set(LEAVE_MANAGE_LAYERS.map((l) => l.key).filter((k) => !LEAVE_MANAGE_EXPLICIT_ONLY.includes(k)));
    });
  const setModule = (m: string, on: boolean) =>
    edit((a) => {
      if (on) {
        a.modules.add(m);
        if (LAYER_MODULES.includes(m) && (a.layers[m]?.size || 0) === 0) a.layers[m] = new Set(defaultLayers(m));
      } else a.modules.delete(m);
    });
  const setLayer = (m: string, l: string, on: boolean) =>
    edit((a) => {
      if (m === 'leave_manage' ? !a.flags.can_manage_leave : !a.modules.has(m)) return;
      const s = new Set(a.layers[m] || []);
      if (on) s.add(l);
      else s.delete(l);
      a.layers[m] = s;
    });
  const flip = (agg: Agg) => agg.state !== 'on';

  // --- the Mobile App column ---
  // On in the app = on for the website, the app switched on, and ticked for
  // the app (or the app has no ticks of its own and follows the website).
  const appHas = (p: AppAcc, key: string, webOn: boolean) => webOn && p.can && (!p.custom || p.items.has(key));
  const appAgg = (key: string, webGet: (a: Access) => boolean, eligible: (u: User, a: Access) => boolean = () => true): Agg => {
    let on = 0;
    let n = 0;
    for (const u of selected) {
      const a = drafts[u.id];
      const p = appDrafts[u.id];
      if (!a || !p || !eligible(u, a)) continue;
      n++;
      if (appHas(p, key, webGet(a))) on++;
    }
    return { on, n, state: n === 0 ? 'none' : on === 0 ? 'off' : on === n ? 'on' : 'mixed' };
  };
  const appCanAgg = (): Agg => {
    const list = selected.filter((u) => appDrafts[u.id]);
    const on = list.filter((u) => appDrafts[u.id].can).length;
    return { on, n: list.length, state: list.length === 0 ? 'none' : on === 0 ? 'off' : on === list.length ? 'on' : 'mixed' };
  };
  const anyAppOn = selected.some((u) => appDrafts[u.id]?.can);
  const editApp = (fn: (p: AppAcc, a: Access, u: User) => void) =>
    setAppDrafts((d) => {
      const next = { ...d };
      for (const u of selected) {
        if (!next[u.id] || !drafts[u.id]) continue;
        const p = cloneApp(next[u.id]);
        fn(p, drafts[u.id], u);
        next[u.id] = p;
      }
      return next;
    });
  // An App tick of its own: the app stops following the website from here.
  const setAppItem = (key: string, on: boolean, webGet: (a: Access) => boolean) =>
    editApp((p, a) => {
      if (!webGet(a) || !p.can) return;
      if (!p.custom) {
        p.custom = true;
        p.items = webItems(a);
      }
      if (on) p.items.add(key);
      else p.items.delete(key);
    });
  const setAppCan = (on: boolean) => editApp((p) => (p.can = on));
  const copyWebToApp = () => {
    editApp((p) => {
      p.can = true;
      p.custom = false;
      p.items = new Set();
    });
    setNotice('The app now gets the same access as the website — check it, then Save.');
  };

  const setDept = (kind: DeptKind, keys: string[], on: boolean) => {
    if (!single) return;
    setDepts((m) => {
      const cur = m[single.id];
      if (!cur) return m;
      const s = new Set(cur.draft[kind]);
      keys.forEach((k) => (on ? s.add(k) : s.delete(k)));
      return { ...m, [single.id]: { ...cur, draft: { ...cur.draft, [kind]: s } } };
    });
  };

  // ---- Access Templates ----
  const [templates, setTemplates] = useState<AccessTemplate[]>([]);
  const [saveTpl, setSaveTpl] = useState<{ name: string; description: string; busy: boolean; error: string } | null>(null);
  useEffect(() => {
    if (!templatesAllowed) return;
    fetch(apiUrl('/api/access-templates'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => Array.isArray(list) && setTemplates(list))
      .catch(() => undefined);
  }, [token, templatesAllowed]);

  // "Apply template…": fills the form like "Copy access from…"; nothing is
  // saved until Save. A template saved from here holds the whole access and
  // is filled in exactly (switches it doesn't know — added later — stay as
  // they are); an older one (switches + modules) only adds those.
  const applyTemplate = (id: number) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const full: TemplateAccess | null = t.access || null;
    setDrafts((d) => {
      const next = { ...d };
      for (const u of selected) {
        const cur = d[u.id];
        if (!cur) continue;
        let c: Access;
        if (full) {
          const layers: Record<string, Set<string>> = {};
          for (const m of [...LAYER_MODULES, 'leave_manage']) layers[m] = new Set(full.layers?.[m] || []);
          const flags = { ...cur.flags };
          for (const [k, v] of Object.entries(full.flags || {})) if (k in FLAG) (flags as any)[k] = v;
          c = { modules: new Set(full.modules), layers, flags };
        } else {
          c = cloneAccess(cur);
          for (const m of t.modules) {
            if (c.modules.has(m)) continue;
            c.modules.add(m);
            if (LAYER_MODULES.includes(m) && !(c.layers[m]?.size)) c.layers[m] = new Set(defaultLayers(m));
          }
          for (const f of t.features) if (f in FLAG) (c.flags as any)[f] = true;
        }
        if (u.role !== 'admin') c.flags.can_access_user_panel = false;
        next[u.id] = c;
      }
      return next;
    });
    if (full?.app) {
      const app = full.app;
      setAppDrafts((d) => ({ ...d, ...Object.fromEntries(selected.map((u) => [u.id, { can: app.can, custom: app.custom, items: new Set(app.items) }])) }));
    }
    setNotice(`Template “${t.name}” filled in — check it, then Save.`);
  };

  // "Save as template": what is on the screen for this account, as it is now
  // (not yet saved changes included) — modules, layers, switches, App access.
  const saveAsTemplate = async () => {
    if (!single || !saveTpl) return;
    const name = saveTpl.name.trim();
    if (!name) return setSaveTpl({ ...saveTpl, error: 'Give the template a name.' });
    const a = drafts[single.id];
    const app = appDrafts[single.id];
    if (!a) return;
    const access: TemplateAccess = {
      modules: [...a.modules],
      layers: Object.fromEntries(
        Object.entries(a.layers)
          .filter(([m, v]) => v.size > 0 && (m === 'leave_manage' ? !!(a.flags as any).can_manage_leave : a.modules.has(m)))
          .map(([m, v]) => [m, [...v]])
      ),
      flags: { ...(a.flags as Record<string, boolean>) },
      app: app ? { can: app.can, custom: app.custom, items: [...app.items] } : null
    };
    const features = TEMPLATE_FEATURES.map((f) => f.key).filter((k) => (a.flags as any)[k] === true);
    setSaveTpl({ ...saveTpl, busy: true, error: '' });
    try {
      const res = await fetch(apiUrl('/api/access-templates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, description: saveTpl.description.trim(), features, modules: access.modules, access })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save the template.');
      setTemplates((list) => [...list, { ...d, access }].sort((x, y) => x.name.localeCompare(y.name)));
      setSaveTpl(null);
      setNotice(`Saved as template “${name}” — pick it in “Apply template…” for anyone.`);
    } catch (e: any) {
      setSaveTpl((s0) => (s0 ? { ...s0, busy: false, error: e.message } : s0));
    }
  };

  // "Copy access from…": fills the form; nothing is saved until Save.
  const copyFrom = async (sourceId: number) => {
    const src = userById.get(sourceId);
    if (!src) return;
    const a = accessOf(src);
    setDrafts((d) => {
      const next = { ...d };
      for (const u of selected) {
        const c = cloneAccess(a);
        if (u.role !== 'admin') c.flags.can_access_user_panel = false;
        next[u.id] = c;
      }
      return next;
    });
    const srcApp = (await fetchAppAccess(token, [src.id]))[src.id];
    if (srcApp) setAppDrafts((d) => ({ ...d, ...Object.fromEntries(selected.map((u) => [u.id, cloneApp(srcApp)])) }));
    if (single) {
      const target = single;
      const lists = await Promise.all(
        DEPT_KINDS.map((d) =>
          fetch(apiUrl(`/api/users/${src.id}/${d.endpoint}`), { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : { departments: [] }))
            .then((data) => (Array.isArray(data?.departments) ? (data.departments as string[]) : []))
            .catch(() => [] as string[])
        )
      );
      setDepts((m) => {
        const cur = m[target.id];
        if (!cur) return m;
        const draft = { ...cur.draft };
        DEPT_KINDS.forEach((d, i) => (draft[d.module] = new Set(lists[i])));
        return { ...m, [target.id]: { ...cur, draft } };
      });
      const t = await fetchTrackScope(token, src.id);
      setTracks((m) => {
        const cur = m[target.id];
        if (!cur) return m;
        return { ...m, [target.id]: { ...cur, draft: { departments: new Set(t.departments), employees: new Set(t.employee_ids) } } };
      });
    }
    setNotice(`Copied access from ${src.name} — check it, then Save.`);
  };

  const back = async () => {
    if (changeCount > 0 && !(await confirmDialog(`Leave without saving ${changeCount} change${changeCount === 1 ? '' : 's'}?`, { tone: 'danger' }))) return;
    onClose();
  };

  const save = async () => {
    const work = pending.filter((p) => p.changes.length > 0);
    if (work.length === 0) return;
    if (work.length > 1 && !(await confirmDialog(`Save ${changeCount} change${changeCount === 1 ? '' : 's'} for ${work.length} accounts?`))) return;
    const total = work.reduce((s, p) => s + p.changes.length, 0);
    let done = 0;
    const failed: string[] = [];
    setFailures([]);
    setSaving({ done, total });
    for (const { u, changes } of work) {
      for (const c of changes) {
        try {
          await c.run();
        } catch (err: any) {
          failed.push(`${u.name} — ${c.label}: ${err.message || 'Failed'}`);
        }
        setSaving({ done: ++done, total });
      }
    }
    setSaving(null);
    if (failed.length === 0) {
      onSaved(work.length === 1 ? `Module access updated for ${work[0].u.name}.` : `Module access updated for ${work.length} accounts.`, true);
      onClose();
    } else {
      setFailures(failed);
      onSaved(`Some changes were not saved (${failed.length}).`, false);
    }
  };

  // --- what to draw ---
  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) => !q || texts.some((t) => (t || '').toLowerCase().includes(q));
  const anyAdmin = selected.some((u) => u.role === 'admin');

  const flagsIn = (s: SectionKey) =>
    FLAGS.filter((f) => f.section === s && !INLINE_FLAGS.includes(f.key) && (!f.adminOnly || anyAdmin)).filter((f) => {
      if (!f.parent) return matches(f.label, f.desc);
      // A sub-switch shows only while its parent is on for someone.
      return aggregate((a) => a.flags[f.parent!]).on > 0 && matches(f.label, f.desc, FLAG[f.parent].label);
    });
  const modulesIn = (s: SectionKey) =>
    ADMIN_MODULES.filter((m) => sectionOfModule(m.key) === s).filter(
      (m) =>
        matches(m.label, MODULE_DESC[m.key]) ||
        (q && layersFor(m.key).some((l) => LAYER_MODULES.includes(m.key) && l.label.toLowerCase().includes(q))) ||
        (m.key === 'admin_dashboard' && matches(FLAG.can_view_group_dashboard.label))
    );
  const leaveManageIn = (s: SectionKey) => s === 'attendance' && matches(FLAG.can_manage_leave.label, FLAG.can_manage_leave.desc, 'leave balance');
  const sectionHasItems = (s: SectionKey) => flagsIn(s).length > 0 || modulesIn(s).length > 0 || leaveManageIn(s);
  const sectionOnCount = (s: SectionKey) =>
    FLAGS.filter((f) => f.section === s && (!f.adminOnly || anyAdmin)).filter((f) => flagAgg(f).on > 0).length +
    ADMIN_MODULES.filter((m) => sectionOfModule(m.key) === s && moduleAgg(m.key).on > 0).length;
  const sectionAppCount = (s: SectionKey) =>
    FLAGS.filter((f) => f.section === s && (!f.adminOnly || anyAdmin)).filter((f) => appAgg(f.key, (a) => a.flags[f.key], flagEligible(f)).on > 0).length +
    ADMIN_MODULES.filter((m) => sectionOfModule(m.key) === s && appAgg(m.key, (a) => a.modules.has(m.key)).on > 0).length;
  const visibleSections = SECTIONS.filter((s) => s.key !== 'other' || ADMIN_MODULES.some((m) => sectionOfModule(m.key) === 'other'));

  const summary = [
    ...FLAGS.filter((f) => !f.adminOnly || anyAdmin).map((f) => ({ label: f.label, agg: flagAgg(f), app: appAgg(f.key, (a) => a.flags[f.key], flagEligible(f)), layers: f.key === 'can_manage_leave' ? 'leave_manage' : null })),
    ...ADMIN_MODULES.map((m) => ({ label: m.label, agg: moduleAgg(m.key), app: appAgg(m.key, (a) => a.modules.has(m.key)), layers: LAYER_MODULES.includes(m.key) ? (m.key as string) : null }))
  ].filter((x) => x.agg.on > 0);

  const pill = (active: boolean) =>
    `text-[11.5px] font-semibold rounded-full px-2.5 py-1 border transition-colors ${active ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-violet-300'}`;

  // The App switch of one row, next to its Web switch.
  const appCell = (key: string, label: string, webAgg: Agg, webGet: (a: Access) => boolean, eligible?: (u: User, a: Access) => boolean) => {
    const agg = appAgg(key, webGet, eligible);
    const off = agg.n === 0 || webAgg.on === 0 || !anyAppOn;
    return (
      <span className="w-12 sm:w-14 flex justify-center shrink-0">
        <Toggle
          tone="app"
          state={off ? 'off' : agg.state}
          disabled={off}
          hint={agg.n === 0 ? 'Loading…' : !anyAppOn ? 'Mobile App access is off' : webAgg.on === 0 ? 'Turn it on for the website first' : undefined}
          label={`${label} in the app`}
          onClick={() => setAppItem(key, flip(agg), webGet)}
        />
      </span>
    );
  };
  const webCell = (node: React.ReactNode) => <span className="w-12 sm:w-14 flex justify-center shrink-0">{node}</span>;
  // On for the website but not in the app: say so under the row.
  const websiteOnly = (key: string, webAgg: Agg, webGet: (a: Access) => boolean, ml = 'ml-4') => {
    if (!anyAppOn || webAgg.on === 0) return null;
    const agg = appAgg(key, webGet);
    if (agg.n === 0 || agg.on > 0) return null;
    return <p className={`${ml} -mt-1 mb-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-1.5`}>Website only — not in the mobile app for {selected.length > 1 ? 'these accounts' : 'this account'}.</p>;
  };

  const renderFlag = (f: FlagDef) => {
    const agg = flagAgg(f);
    const webGet = (a: Access) => a.flags[f.key];
    return (
      <React.Fragment key={f.key}>
        <div className={`flex items-center gap-2 sm:gap-3 pl-3.5 pr-1.5 py-3 rounded-2xl border mb-2 ${f.parent ? 'ml-6' : ''} ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white'}`}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">{f.label}</div>
            <div className="text-xs text-slate-500">{f.desc}</div>
          </div>
          <MixedNote agg={agg} />
          {webCell(<Toggle state={agg.state} label={f.label} onClick={() => setFlag(f, flip(agg))} />)}
          {appCell(f.key, f.label, agg, webGet, flagEligible(f))}
        </div>
        {websiteOnly(f.key, agg, webGet, f.parent ? 'ml-10' : 'ml-4')}
      </React.Fragment>
    );
  };
  const columnHeads = (
    <div className="flex justify-end pr-1.5 -mb-1" aria-hidden="true">
      <span className="w-12 sm:w-14 text-center text-[10px] font-extrabold tracking-[0.08em] text-sky-600">WEB</span>
      <span className="w-12 sm:w-14 text-center text-[10px] font-extrabold tracking-[0.08em] text-violet-600">APP</span>
    </div>
  );

  const renderLayers = (m: string, options: { key: string; label: string }[]) => (
    <div className="flex flex-wrap gap-1.5 -mt-1 mb-3 ml-9">
      {options.map((l) => {
        const agg = layerAgg(m, l.key);
        return (
          <button key={l.key} type="button" onClick={() => setLayer(m, l.key, flip(agg))} className={`${pill(agg.state === 'on')} ${agg.state === 'mixed' ? '!border-amber-300 !bg-amber-50 !text-amber-800' : ''}`}>
            {l.label}
            {agg.state === 'mixed' ? ` · ${agg.on}/${agg.n}` : ''}
          </button>
        );
      })}
    </div>
  );

  const renderDepts = (kind: DeptKind) => {
    const d = DEPT_KINDS.find((x) => x.module === kind)!;
    if (!single) {
      return <p className="ml-9 -mt-1 mb-3 text-[11px] text-slate-500">Department access is set one account at a time — open just one account to change it.</p>;
    }
    const ds = depts[single.id];
    return (
      <div className="ml-9 -mt-1 mb-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-0.5">
          <Building2 className="w-3.5 h-3.5 text-amber-600" /> {d.title}
        </p>
        <p className="text-[11px] text-slate-500 mb-2">{d.hint}</p>
        {loadingDepts || !ds ? (
          <p className="text-[11px] text-slate-400">Loading…</p>
        ) : departments.length === 0 ? (
          <p className="text-[11px] text-slate-400">No Departments set up yet (Admin Panel → Departments).</p>
        ) : (
          <ModuleAccessChecklist
            items={departments.map((x) => ({ key: x.name, label: x.name, badge: x.supervisor_user_id === single.id ? 'Supervisor' : undefined }))}
            selected={ds.draft[kind]}
            onToggle={(k) => setDept(kind, [k], !ds.draft[kind].has(k))}
            onSetMany={(keys, checked) => setDept(kind, keys, checked)}
            tone="amber"
            searchPlaceholder="Search departments…"
          />
        )}
      </div>
    );
  };

  const renderTrackingScope = () => {
    if (!single) {
      return <p className="ml-9 -mt-1 mb-3 text-[11px] text-slate-500">Who they can track is set one account at a time — open just one account to change it.</p>;
    }
    const ts = tracks[single.id];
    const empById = new Map((ts?.options || []).map((e) => [e.id, e]));
    const picked = ts ? [...ts.draft.employees].map((id) => empById.get(id) || { id, employee_id: '', name: `Employee #${id}`, designation: '', department: '' }) : [];
    const everyone = !!ts && ts.draft.departments.size === 0 && ts.draft.employees.size === 0;
    return (
      <div className="ml-9 -mt-1 mb-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-0.5">
          <UsersIcon className="w-3.5 h-3.5 text-amber-600" /> Who they can see on Employee Tracking
        </p>
        <p className="text-[11px] text-slate-500 mb-2">
          Nothing chosen = every employee. Chosen = only the people in the ticked Departments plus the employees added below — on the map, status cards, history, Stay Report and Live Follow.
        </p>
        {!ts ? (
          <p className="text-[11px] text-slate-400">Loading…</p>
        ) : (
          <>
            <p className="text-[11px] font-semibold text-amber-900 mb-2">{everyone ? 'Now: everyone' : `Now: ${ts.draft.departments.size} department${ts.draft.departments.size === 1 ? '' : 's'} + ${ts.draft.employees.size} employee${ts.draft.employees.size === 1 ? '' : 's'}`}</p>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Departments</p>
            {departments.length === 0 ? (
              <p className="text-[11px] text-slate-400 mb-2">No Departments set up yet (Admin Panel → Departments).</p>
            ) : (
              <ModuleAccessChecklist
                items={departments.map((x) => ({ key: x.name, label: x.name, badge: x.supervisor_user_id === single.id ? 'Supervisor' : undefined }))}
                selected={ts.draft.departments}
                onToggle={(k) => editTrack((d) => (d.departments.has(k) ? d.departments.delete(k) : d.departments.add(k)))}
                onSetMany={(keys, checked) => editTrack((d) => keys.forEach((k) => (checked ? d.departments.add(k) : d.departments.delete(k))))}
                tone="amber"
                searchPlaceholder="Search departments…"
              />
            )}
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-3 mb-1">Single employees</p>
            <SearchSelect
              value=""
              onChange={(e) => e.target.value && editTrack((d) => d.employees.add(Number(e.target.value)))}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="">— Add an employee —</option>
              {ts.options
                .filter((e) => !ts.draft.employees.has(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {[e.name, e.employee_id, e.designation, e.department].filter(Boolean).join(' · ')}
                  </option>
                ))}
            </SearchSelect>
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {picked.map((e) => (
                  <span key={e.id} className="inline-flex items-center gap-1 text-[11.5px] font-semibold bg-white border border-amber-300 text-amber-900 rounded-full pl-2.5 pr-1 py-0.5">
                    {e.name}
                    {e.employee_id ? ` · ${e.employee_id}` : ''}
                    <button type="button" onClick={() => editTrack((d) => d.employees.delete(e.id))} className="p-0.5 rounded-full hover:bg-amber-100" aria-label={`Remove ${e.name}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderModule = (m: { key: AdminModuleKey; label: string }) => {
    const agg = moduleAgg(m.key);
    const showGroupView = m.key === 'admin_dashboard' && (agg.on > 0 || anyAdmin);
    return (
      <React.Fragment key={m.key}>
        <div className={`w-full flex items-center gap-2 sm:gap-3 pl-3.5 pr-1.5 py-3 rounded-2xl border mb-2 transition-colors ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white'}`}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">{m.label}</div>
            {MODULE_DESC[m.key] && <div className="text-xs text-slate-500">{MODULE_DESC[m.key]}</div>}
          </div>
          <MixedNote agg={agg} />
          {webCell(<Toggle state={agg.state} label={m.label} onClick={() => setModule(m.key, flip(agg))} />)}
          {appCell(m.key, m.label, agg, (a) => a.modules.has(m.key))}
        </div>
        {websiteOnly(m.key, agg, (a) => a.modules.has(m.key))}
        {agg.on > 0 && LAYER_MODULES.includes(m.key) && renderLayers(m.key, layersFor(m.key))}
        {agg.on > 0 && DEPT_KINDS.some((d) => d.module === m.key) && renderDepts(m.key as DeptKind)}
        {agg.on > 0 && m.key === 'tracking' && renderTrackingScope()}
        {showGroupView && <div className="ml-6">{renderFlag(FLAG.can_view_group_dashboard)}</div>}
      </React.Fragment>
    );
  };

  const renderLeaveManage = () => {
    const f = FLAG.can_manage_leave;
    const agg = flagAgg(f);
    return (
      <React.Fragment key="leave_manage">
        <div className={`w-full flex items-center gap-2 sm:gap-3 pl-3.5 pr-1.5 py-3 rounded-2xl border mb-2 transition-colors ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white'}`}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">{f.label}</div>
            <div className="text-xs text-slate-500">{f.desc}</div>
          </div>
          <MixedNote agg={agg} />
          {webCell(<Toggle state={agg.state} label={f.label} onClick={() => setFlag(f, flip(agg))} />)}
          {appCell(f.key, f.label, agg, (a) => a.flags[f.key])}
        </div>
        {websiteOnly(f.key, agg, (a) => a.flags[f.key])}
        {agg.on > 0 && renderLayers('leave_manage', LEAVE_MANAGE_LAYERS)}
      </React.Fragment>
    );
  };

  const renderSection = (s: SectionKey, withTitle: boolean) => {
    const meta = SECTIONS.find((x) => x.key === s)!;
    const flags = flagsIn(s);
    const mods = modulesIn(s);
    const lm = leaveManageIn(s);
    if (flags.length === 0 && mods.length === 0 && !lm) return null;
    return (
      <div key={s} className={withTitle ? 'mb-6' : ''}>
        {withTitle ? (
          <h3 className="text-sm font-bold text-slate-900 mb-2">{meta.label}</h3>
        ) : (
          <>
            <h3 className="text-base font-extrabold text-slate-900">{meta.label}</h3>
            <p className="text-xs text-slate-500 mb-3">{meta.hint} Turn a module on for the website (Web) and, separately, for the mobile app (App); then pick what they may do in it — the same on both.</p>
          </>
        )}
        {columnHeads}
        {flags.length > 0 && (
          <>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-1 mb-2">On their own pages</p>
            {flags.map(renderFlag)}
          </>
        )}
        {(mods.length > 0 || lm) && (
          <>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-4 mb-2">Admin Panel</p>
            {mods.map(renderModule)}
            {lm && renderLeaveManage()}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="w-full">
      <div className="relative bg-white border border-slate-200 rounded-2xl w-full flex flex-col shadow-sm">
        <div className="md:sticky md:top-16 z-20 bg-white rounded-t-2xl border-b border-slate-200">
          <div className="p-4 md:p-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={back}
              className={`h-9 shrink-0 rounded-full flex items-center justify-center gap-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${backTo === 'Users' ? 'w-9' : 'px-3 border border-slate-200 text-sm font-semibold'}`}
              aria-label={`Back to ${backTo}`}
              title={`Back to ${backTo}`}
            >
              <ArrowLeft className="w-5 h-5" />
              {backTo !== 'Users' && <span>{backTo}</span>}
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="text-base md:text-lg font-bold text-slate-900">Module Access</h2>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {selected.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-1 text-xs bg-slate-100 text-slate-700 rounded-full pl-2.5 pr-1 py-0.5 max-w-full">
                    <span className="truncate font-semibold">{u.name}</span>
                    <span className="text-slate-400 truncate hidden sm:inline">· {u.role === 'admin' ? 'Admin' : 'User'}</span>
                    {selected.length > 1 && (
                      <button type="button" onClick={() => dropUser(u.id)} className="w-5 h-5 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-200" aria-label={`Remove ${u.name}`}>
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
                <UserPicker users={editable} selectedIds={ids} onAdd={(u) => addUsers([u])} onRemove={dropUser} onOnly={onlyUser} />
              </div>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={!!saving || changeCount === 0}
              className="hidden sm:inline-flex px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
            >
              {saving ? `Saving ${saving.done} of ${saving.total}…` : selected.length > 1 ? `Save for ${changedAccounts || selected.length} account${(changedAccounts || selected.length) === 1 ? '' : 's'}` : 'Save Access'}
            </button>
          </div>
          <div className="px-4 md:px-5 pb-3 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Search anything — e.g. "dispatch", "payslip"'
                className="w-full pl-10 pr-9 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600 focus:border-violet-600"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700" aria-label="Clear search">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="relative sm:w-[230px]">
              <Copy className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <SearchSelect
                value=""
                onChange={(e) => e.target.value && copyFrom(Number(e.target.value))}
                className="w-full pl-10 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600 cursor-pointer appearance-none"
              >
                <option value="">Copy access from…</option>
                {users
                  .filter((u) => !ids.includes(u.id) && u.role !== 'superadmin')
                  .map((u) => (
                    <option key={u.id} value={u.id}>{personLabel(u)}</option>
                  ))}
              </SearchSelect>
            </div>
            {templatesAllowed && templates.length > 0 && (
              <div className="relative sm:w-[210px]">
                <LayoutTemplate className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                <SearchSelect
                  value=""
                  aria-label="Apply template"
                  onChange={(e) => e.target.value && applyTemplate(Number(e.target.value))}
                  className="w-full pl-10 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600 cursor-pointer appearance-none"
                >
                  <option value="">Apply template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.access ? '' : ' · switches & modules'}
                    </option>
                  ))}
                </SearchSelect>
              </div>
            )}
            {canSaveTemplate && (
              <button
                type="button"
                disabled={!single}
                title={single ? 'Keep this access as a template' : 'Open one account to save its access as a template'}
                onClick={() => setSaveTpl({ name: '', description: '', busy: false, error: '' })}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-xl hover:bg-violet-100 disabled:opacity-50 whitespace-nowrap"
              >
                <Save className="w-4 h-4" /> Save as template
              </button>
            )}
          </div>
          <AppAccessCard
            agg={appCanAgg()}
            following={selected.length > 0 && selected.every((u) => appDrafts[u.id] && !appDrafts[u.id].custom)}
            onToggle={(on) => setAppCan(on)}
            onCopy={copyWebToApp}
          />
          {selected.length > 1 && (
            <div className="px-4 md:px-5 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <UsersIcon className="w-4 h-4 shrink-0 mt-px" />
              <span>
                <b>Editing {selected.length} accounts together.</b> A setting marked “1 of {selected.length}” differs between them and stays as each one has it unless you change it; what you change is set the same for all.
              </span>
            </div>
          )}
          {notice && <div className="px-4 md:px-5 py-2 text-xs text-emerald-800 bg-emerald-50 border-t border-emerald-200">{notice}</div>}
          {failures.length > 0 && (
            <div className="px-4 md:px-5 py-2 text-xs text-rose-800 bg-rose-50 border-t border-rose-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <div>{failures.map((f, i) => <div key={i}>{f}</div>)}</div>
            </div>
          )}
        </div>

        <div className="px-4 md:px-5 py-2.5 bg-violet-50/60 border-b border-violet-100 text-xs text-violet-900 flex flex-wrap items-center gap-1.5">
          <b className="mr-1">Turned on ({summary.length}):</b>
          {summary.length === 0 && <span className="text-violet-700/70">Nothing yet.</span>}
          {summary.map((x) => {
            const layerLabels =
              x.layers && x.agg.state === 'on' && selected.length === 1
                ? (x.layers === 'leave_manage' ? LEAVE_MANAGE_LAYERS : layersFor(x.layers as AdminModuleKey)).filter((l) => drafts[selected[0].id]?.layers[x.layers!]?.has(l.key)).map((l) => l.label)
                : [];
            return (
              <span key={x.label} className="bg-white border border-violet-200 rounded-full px-2.5 py-0.5 font-semibold">
                {x.label}
                {layerLabels.length > 0 && <span className="font-normal text-violet-700"> · {layerLabels.join(', ')}</span>}
                {x.agg.state === 'mixed' && <span className="font-normal text-amber-700"> ({x.agg.on} of {x.agg.n})</span>}
                <span className="ml-1.5 text-[9.5px] font-extrabold bg-sky-100 text-sky-700 rounded-md px-1 py-px align-middle">WEB</span>
                {x.app.on > 0 && <span className="ml-1 text-[9.5px] font-extrabold bg-violet-100 text-violet-700 rounded-md px-1 py-px align-middle">APP</span>}
              </span>
            );
          })}
        </div>

        <div className="md:grid md:grid-cols-[230px_1fr] min-h-[480px]">
          {!q && (
            <nav className="flex md:block gap-1.5 overflow-x-auto md:overflow-visible p-2.5 md:p-3 border-b md:border-b-0 md:border-r border-slate-200 bg-slate-50/50">
              {visibleSections.map((s) => {
                const n = sectionOnCount(s.key);
                const active = section === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSection(s.key)}
                    className={`shrink-0 md:w-full flex items-center justify-between gap-2 px-3 py-2 md:py-2.5 rounded-xl text-sm whitespace-nowrap border md:border-0 mb-0 md:mb-0.5 ${
                      active ? 'bg-violet-100 border-violet-300 text-violet-800 font-bold' : 'bg-white md:bg-transparent border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {s.label}
                    <span
                      title={`${n} on the website · ${sectionAppCount(s.key)} in the app`}
                      className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${n > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}
                    >
                      {n > 0 ? `${n} · ${sectionAppCount(s.key)}` : n}
                    </span>
                  </button>
                );
              })}
            </nav>
          )}
          <div className={`p-4 md:p-6 ${q ? 'md:col-span-2' : ''}`}>
            {q ? (
              visibleSections.some((s) => sectionHasItems(s.key)) ? (
                visibleSections.map((s) => renderSection(s.key, true))
              ) : (
                <p className="text-sm text-slate-500 py-10 text-center">Nothing matches “{query}”.</p>
              )
            ) : (
              renderSection(section, false)
            )}
          </div>
        </div>

        {saveTpl && single && createPortal(
          <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={() => !saveTpl.busy && setSaveTpl(null)}>
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Save as template"
              onClick={(e) => e.stopPropagation()}
              className="liquid-glass liquid-glass-in w-full sm:max-w-md rounded-t-[32px] sm:rounded-[32px] p-5 sm:p-6"
              style={{ paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 1.25rem)' }}
            >
              <button
                type="button"
                onClick={() => setSaveTpl(null)}
                aria-label="Close"
                className="liquid-glass-chip absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-3 pr-10">
                <span className="liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center text-violet-600 shrink-0">
                  <LayoutTemplate className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-slate-900 leading-tight">Save as template</h3>
                  <p className="text-xs text-slate-600">From {single.name}&rsquo;s access on this screen</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <label className="block">
                  <span className="text-xs font-semibold text-slate-700">Template name</span>
                  <input
                    autoFocus
                    value={saveTpl.name}
                    maxLength={100}
                    onChange={(e) => setSaveTpl({ ...saveTpl, name: e.target.value, error: '' })}
                    onKeyDown={(e) => e.key === 'Enter' && void saveAsTemplate()}
                    placeholder="e.g. Site Engineer, HR Executive"
                    className="mt-1 w-full px-3 py-2.5 text-sm bg-white/80 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-slate-700">Description (optional)</span>
                  <input
                    value={saveTpl.description}
                    maxLength={255}
                    onChange={(e) => setSaveTpl({ ...saveTpl, description: e.target.value })}
                    placeholder="Who it is for"
                    className="mt-1 w-full px-3 py-2.5 text-sm bg-white/80 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600"
                  />
                </label>
                <div className="liquid-glass-inset rounded-2xl px-3.5 py-2.5 text-xs text-slate-600 leading-relaxed">
                  Keeps the modules and what they may do in each, every switch, and the Mobile App access. Department limits and whom they see on Tracking stay with each person and are not part of a template.
                </div>
                {saveTpl.error && <p className="text-xs font-semibold text-rose-600">{saveTpl.error}</p>}
              </div>
              <div className="mt-5 flex gap-2">
                <button type="button" onClick={() => setSaveTpl(null)} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saveTpl.busy}
                  onClick={() => void saveAsTemplate()}
                  className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-60"
                >
                  {saveTpl.busy ? 'Saving…' : 'Save template'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        <div className="sticky bottom-0 z-20 bg-white rounded-b-2xl px-4 md:px-5 py-3.5 border-t border-slate-200 flex items-center justify-end gap-2">
          <span className="text-xs text-slate-500 mr-auto">
            {changeCount === 0
              ? 'No changes yet.'
              : `${changeCount} change${changeCount === 1 ? '' : 's'} will be saved${selected.length > 1 ? ` for ${changedAccounts} account${changedAccounts === 1 ? '' : 's'}` : ''}.`}
          </span>
          <button type="button" onClick={back} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!!saving || changeCount === 0}
            className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
          >
            {saving ? `Saving ${saving.done} of ${saving.total}…` : selected.length > 1 ? `Save for ${changedAccounts || selected.length} account${(changedAccounts || selected.length) === 1 ? '' : 's'}` : 'Save Access'}
          </button>
        </div>
      </div>
    </div>
  );
}

// The Mobile App (APK) switch for the whole account, and "Copy Web → App".
function AppAccessCard({ agg, following, onToggle, onCopy }: { agg: Agg; following: boolean; onToggle: (on: boolean) => void; onCopy: () => void }) {
  const loading = agg.n === 0;
  return (
    <div className="mx-4 md:mx-5 mb-3 rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 p-3 sm:p-3.5 flex flex-wrap items-center gap-3">
      <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 text-white flex items-center justify-center shrink-0">
        <Smartphone className="w-5 h-5" />
      </span>
      <div className="flex-1 min-w-[180px]">
        <div className="text-sm font-bold text-slate-900 flex items-center gap-2">
          Mobile App (APK) access
          {agg.state === 'mixed' && <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">{agg.on} of {agg.n}</span>}
        </div>
        <div className="text-xs text-slate-600">
          {loading
            ? 'Loading…'
            : agg.on === 0
              ? 'Off — this account can’t sign in to the phone app. The website is not affected.'
              : following
                ? 'On — the app has the same access as the website. Turn an App switch off below to take something out of the app only.'
                : 'On — the app has only the App switches turned on below (never more than the website).'}
        </div>
      </div>
      <div className="flex items-center gap-2 ml-auto">
        {!loading && agg.on > 0 && !following && (
          <button type="button" onClick={onCopy} className="text-xs font-semibold text-violet-700 bg-white border border-violet-300 hover:bg-violet-50 rounded-full px-3 py-1.5 whitespace-nowrap">
            Copy Web → App
          </button>
        )}
        <Toggle tone="app" state={loading ? 'off' : agg.state} disabled={loading} label="Mobile App access" onClick={() => onToggle(agg.state !== 'on')} />
      </div>
    </div>
  );
}

// "+ Add / change user": search the accounts this viewer may give access to.
// Ticking adds or removes an account; "Only" edits just that one.
function UserPicker({
  users,
  selectedIds,
  onAdd,
  onRemove,
  onOnly
}: {
  users: User[];
  selectedIds: number[];
  onAdd: (u: User) => void;
  onRemove: (id: number) => void;
  onOnly: (u: User) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const list = users
    .filter((u) => !needle || [u.name, u.email, u.username, u.employee_code, u.designation, u.department].some((t) => String(t || '').toLowerCase().includes(needle)))
    .slice(0, 60);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-full px-2.5 py-0.5"
      >
        + Add / change user <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-40 w-[min(92vw,340px)]">
          <div className="liquid-glass liquid-glass-in rounded-[24px] p-2.5">
            <input
              autoFocus
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, ID, designation, department or email…"
              className="w-full px-3 py-2 text-sm bg-white/80 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-600"
            />
            <div className="liquid-glass-inset rounded-[18px] mt-2 max-h-72 overflow-y-auto">
              {list.length === 0 && <p className="px-3 py-4 text-xs text-slate-500 text-center">No account found.</p>}
              {list.map((u) => {
                const on = selectedIds.includes(u.id);
                return (
                  <div key={u.id} className="flex items-center gap-2 px-2.5 py-2 hover:bg-white/60">
                    <button
                      type="button"
                      onClick={() => (on ? selectedIds.length > 1 && onRemove(u.id) : onAdd(u))}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left"
                    >
                      <Box state={on ? 'on' : 'off'} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-800 truncate">{u.name}</span>
                        {personDetails(u) && <span className="block text-[11px] text-slate-600 truncate">{personDetails(u)}</span>}
                        <span className="block text-[11px] text-slate-500 truncate">
                          {u.email || u.username} · {u.role === 'admin' ? 'Admin' : 'User'}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onOnly(u);
                        setOpen(false);
                      }}
                      className="text-[11px] font-semibold text-violet-700 hover:bg-violet-100 rounded-full px-2 py-0.5 shrink-0"
                      title="Edit only this account"
                    >
                      Only
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
