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
import { ArrowLeft, Search, Copy, Users as UsersIcon, X, Check, ChevronDown, Building2, AlertTriangle } from 'lucide-react';
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
import { AccessViewer, canEditUserModules } from '../lib/accessTemplates';
import { confirmDialog } from '../lib/confirmDialog';
import { ModuleAccessChecklist } from './ModuleAccessChecklist';

import { SearchSelect } from './Combobox';
type SectionKey = 'general' | 'pepm' | 'hr' | 'attendance' | 'claims' | 'employees' | 'hrops' | 'payroll' | 'mail' | 'mis' | 'other';

const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: 'general', label: 'General', hint: 'Panels, calls, emailing reports and the AI Assistant.' },
  { key: 'pepm', label: 'PEPM', hint: 'Budgets, MPR entries, reports and material dispatch.' },
  { key: 'hr', label: 'HR', hint: 'Dashboard, approvals, notices, departments, tasks and targets.' },
  { key: 'attendance', label: 'Attendance & Leave', hint: 'Attendance, roster, leave applications and leave balances.' },
  { key: 'claims', label: 'Claims & Bills', hint: 'Movement and conveyance claims, disbursement and mobile bills.' },
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
  | 'can_view_conveyance_claims'
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
  | 'can_sign_documents'
  | 'can_view_payslip'
  | 'can_request_items'
  | 'can_email_reports';

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
  { key: 'can_email_reports', label: 'Email reports', desc: 'An Email button next to PDF on the reports they can open.', section: 'general', endpoint: 'report-email-access' },
  { key: 'can_use_ai_assistant', label: 'AI Assistant', desc: 'The floating Assistant. On by default.', section: 'general', endpoint: 'ai-assistant-access', defaultOn: true },
  { key: 'can_export_assistant_reports', label: 'Assistant: PDF / Excel download', desc: 'Download the Assistant’s list answers (only figures they can see).', section: 'general', endpoint: 'assistant-report-access' },
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
  { key: 'can_take_break', label: 'Break Time', desc: 'Start and end their breaks in the app.', section: 'attendance', endpoint: 'break-access' },
  { key: 'can_give_feedback', label: 'Give feedback', desc: 'Rate the app and send problems or ideas (and the 7-day "How do you like the app?").', section: 'general', endpoint: 'feedback-access' },
  { key: 'can_use_fingerprint', label: 'Fingerprint login', desc: 'Sign in with fingerprint / face on their own phone (app) or computer (passkey), turned on from Profile. Turning this off removes the saved fingerprints.', section: 'general', endpoint: 'fingerprint-access' },

  { key: 'can_view_movement_claims', label: 'Movement Claim', desc: 'GPS check in / out claims.', section: 'claims', endpoint: 'movement-claim-access' },
  { key: 'can_view_conveyance_claims', label: 'Conveyance Bill Claim', desc: 'Submit conveyance bills.', section: 'claims', endpoint: 'conveyance-claim-access' },
  { key: 'can_view_mobile_bill', label: 'My Mobile SIM', desc: 'Their SIMs, limits and bills.', section: 'claims', endpoint: 'mobile-bill-access' },

  { key: 'can_use_tracking', label: 'Live location tracking', desc: 'Their phone shares its location while on duty.', section: 'employees', endpoint: null },
  { key: 'can_view_service_book', label: 'My Service Book', desc: 'Their own service record, read only.', section: 'employees', endpoint: 'service-book-access' },

  { key: 'can_request_items', label: 'SIM & ID Card requests', desc: 'Ask HR for a company SIM or an ID card (new, lost, damaged).', section: 'hr', endpoint: 'request-items-access' },
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
  claims: 'claims', conveyance: 'claims', disbursement: 'claims', mobile_bill: 'claims',
  employees: 'employees', tracking: 'employees', asset_management: 'employees', vehicle_management: 'employees', vehicle_maintainer: 'employees',
  hr_operations: 'hrops', exit_offboarding: 'hrops', performance_management: 'hrops', recruitment: 'hrops', grievance_disciplinary: 'hrops', hr_analytics: 'hrops', document_vault: 'hrops',
  payroll: 'payroll',
  mail_admin: 'mail',
  users: 'mis', projects: 'mis', branches: 'mis', user_feedback: 'mis'
};
const sectionOfModule = (k: AdminModuleKey): SectionKey => MODULE_SECTION[k] || 'other';

const MODULE_DESC: Partial<Record<AdminModuleKey, string>> = {
  admin_dashboard: 'Quick View, attendance and leave at a glance.',
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
  conveyance: 'Review conveyance bills.',
  disbursement: 'Pay out approved conveyance bills.',
  mobile_bill: 'Company SIMs, limits and operator bills.',
  vehicle_maintainer: 'Direct Book a ride without approval.',
  users: 'Accounts, roles and access.',
  mail_admin: 'Everyone’s connected mailboxes and central groups.'
};

const LAYER_MODULES = PERMISSION_LAYER_MODULES as readonly string[];
type DeptKind = 'attendance_reports' | 'leave_applications' | 'conveyance' | 'duty_roster';
const DEPT_KINDS: { module: DeptKind; endpoint: string; title: string; hint: string; preTick: boolean }[] = [
  { module: 'attendance_reports', endpoint: 'attendance-report-departments', title: 'Departments on the Monthly Attendance Report', hint: 'Nothing ticked = every Department.', preTick: true },
  { module: 'leave_applications', endpoint: 'leave-application-departments', title: 'Departments on the Monthly Leave Application report', hint: 'Nothing ticked = every Department.', preTick: true },
  { module: 'conveyance', endpoint: 'conveyance-claim-departments', title: 'Departments on Conveyance Bill Claim', hint: 'Nothing ticked = every Department.', preTick: true },
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
function changesFor(token: string, u: User, base: Access, draft: Access, dept: DeptState | undefined): Change[] {
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
  return out;
}

type Tri = 'on' | 'off' | 'mixed' | 'none';
interface Agg {
  on: number;
  n: number;
  state: Tri;
}

const Toggle: React.FC<{ state: Tri; onClick: () => void; label: string }> = ({ state, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-pressed={state === 'on'}
    title={state === 'mixed' ? 'Different for the selected accounts — click to turn on for all' : state === 'on' ? 'On — click to turn off' : 'Off — click to turn on'}
    className={`relative inline-flex h-[22px] w-10 items-center rounded-full transition-colors shrink-0 ${
      state === 'on'
        ? 'bg-emerald-500'
        : state === 'mixed'
          ? 'bg-[repeating-linear-gradient(135deg,#10b981_0_5px,#cbd5e1_5px_10px)]'
          : 'bg-slate-300'
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
  onClose: () => void;
  // After a save: reload the accounts and say how it went.
  onSaved: (text: string, ok: boolean) => void;
}

export function ModuleAccessPage({ token, users, initialIds, departments, viewer, onClose, onSaved }: ModuleAccessPageProps) {
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

  const [section, setSection] = useState<SectionKey>('general');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const selected = ids.map((id) => userById.get(id)).filter(Boolean) as User[];
  const single = selected.length === 1 ? selected[0] : null;

  const addUsers = (list: User[]) => {
    const fresh = list.filter((u) => !base[u.id]);
    if (fresh.length > 0) {
      const add = Object.fromEntries(fresh.map((u) => [u.id, accessOf(u)]));
      setBase((b) => ({ ...b, ...add }));
      setDrafts((d) => ({ ...d, ...Object.fromEntries(Object.entries(add).map(([id, a]) => [id, cloneAccess(a)])) }));
    }
    setIds((cur) => [...cur, ...list.map((u) => u.id).filter((id) => !cur.includes(id))]);
  };

  const changesOf = (u: User) => (base[u.id] && drafts[u.id] ? changesFor(token, u, base[u.id], drafts[u.id], depts[u.id]) : []);
  const pending = selected.map((u) => ({ u, changes: changesOf(u) }));
  const changeCount = pending.reduce((s, p) => s + p.changes.length, 0);
  const changedAccounts = pending.filter((p) => p.changes.length > 0).length;

  const dropUser = async (id: number) => {
    const u = userById.get(id);
    if (u && changesOf(u).length > 0 && !(await confirmDialog(`Drop the unsaved changes for ${u.name}?`, { tone: 'danger' }))) return;
    setIds((cur) => cur.filter((x) => x !== id));
    for (const set of [setBase, setDrafts, setDepts] as React.Dispatch<React.SetStateAction<Record<number, any>>>[]) {
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
  const visibleSections = SECTIONS.filter((s) => s.key !== 'other' || ADMIN_MODULES.some((m) => sectionOfModule(m.key) === 'other'));

  const summary = [
    ...FLAGS.filter((f) => !f.adminOnly || anyAdmin).map((f) => ({ label: f.label, agg: flagAgg(f), layers: f.key === 'can_manage_leave' ? 'leave_manage' : null })),
    ...ADMIN_MODULES.map((m) => ({ label: m.label, agg: moduleAgg(m.key), layers: LAYER_MODULES.includes(m.key) ? (m.key as string) : null }))
  ].filter((x) => x.agg.on > 0);

  const pill = (active: boolean) =>
    `text-[11.5px] font-semibold rounded-full px-2.5 py-1 border transition-colors ${active ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-violet-300'}`;

  const renderFlag = (f: FlagDef) => {
    const agg = flagAgg(f);
    return (
      <div
        key={f.key}
        className={`flex items-center gap-3 px-3.5 py-3 rounded-2xl border mb-2 ${f.parent ? 'ml-6' : ''} ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white'}`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900">{f.label}</div>
          <div className="text-xs text-slate-500">{f.desc}</div>
        </div>
        <MixedNote agg={agg} />
        <Toggle state={agg.state} label={f.label} onClick={() => setFlag(f, flip(agg))} />
      </div>
    );
  };

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

  const renderModule = (m: { key: AdminModuleKey; label: string }) => {
    const agg = moduleAgg(m.key);
    const showGroupView = m.key === 'admin_dashboard' && (agg.on > 0 || anyAdmin);
    return (
      <React.Fragment key={m.key}>
        <button
          type="button"
          onClick={() => setModule(m.key, flip(agg))}
          className={`w-full text-left flex items-center gap-3 px-3.5 py-3 rounded-2xl border mb-2 transition-colors ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
        >
          <Box state={agg.state} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">{m.label}</div>
            {MODULE_DESC[m.key] && <div className="text-xs text-slate-500">{MODULE_DESC[m.key]}</div>}
          </div>
          <MixedNote agg={agg} />
        </button>
        {agg.on > 0 && LAYER_MODULES.includes(m.key) && renderLayers(m.key, layersFor(m.key))}
        {agg.on > 0 && DEPT_KINDS.some((d) => d.module === m.key) && renderDepts(m.key as DeptKind)}
        {showGroupView && <div className="ml-6">{renderFlag(FLAG.can_view_group_dashboard)}</div>}
      </React.Fragment>
    );
  };

  const renderLeaveManage = () => {
    const f = FLAG.can_manage_leave;
    const agg = flagAgg(f);
    return (
      <React.Fragment key="leave_manage">
        <button
          type="button"
          onClick={() => setFlag(f, flip(agg))}
          className={`w-full text-left flex items-center gap-3 px-3.5 py-3 rounded-2xl border mb-2 transition-colors ${agg.on > 0 ? 'border-violet-200 bg-violet-50/50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
        >
          <Box state={agg.state} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">{f.label}</div>
            <div className="text-xs text-slate-500">{f.desc}</div>
          </div>
          <MixedNote agg={agg} />
        </button>
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
            <p className="text-xs text-slate-500 mb-3">{meta.hint} Tick a module to open it for them, then pick what they may do in it.</p>
          </>
        )}
        {flags.length > 0 && (
          <>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-3 mb-2">On their own pages</p>
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
              className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Back to Users"
              title="Back to Users"
            >
              <ArrowLeft className="w-5 h-5" />
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
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role === 'admin' ? 'Admin' : 'User'})
                    </option>
                  ))}
              </SearchSelect>
            </div>
          </div>
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
                    <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${n > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{n}</span>
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
    .filter((u) => !needle || [u.name, u.email, u.username].some((t) => String(t || '').toLowerCase().includes(needle)))
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
              placeholder="Search name, email or login ID…"
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
