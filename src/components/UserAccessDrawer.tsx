/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> "Manage": everything about one account on one
// page — account actions, module/project access, and every per-user
// feature switch with a plain-language description of what it does. Each
// switch still saves on its own (same endpoints AdminPanel.tsx always used);
// this panel just gathers them in one place instead of 16 table columns.

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, KeyRound, Lock, Mail, Trash2, LayoutGrid, ChevronRight, MapPin, Fingerprint, Navigation, CalendarDays,
  CalendarClock, Edit2, ShieldCheck, Eye, History, LayoutTemplate, Undo2, Ban
} from 'lucide-react';
import { User, ADMIN_MODULES } from '../types';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { AccessTemplate } from '../lib/accessTemplates';
import { confirmDialog } from '../lib/confirmDialog';

import { SearchSelect } from './Combobox';
export type UserFeatureField =
  | 'can_edit_delivery_date'
  | 'can_job_edit'
  | 'can_use_attendance'
  | 'can_use_tracking'
  | 'can_view_leave_summary'
  | 'can_grant_module_access';

export function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export const ROLE_BADGE: Record<string, string> = {
  superadmin: 'bg-rose-50 text-rose-800 border-rose-200',
  admin: 'bg-amber-50 text-amber-800 border-amber-200',
  user: 'bg-blue-50 text-blue-800 border-blue-200'
};
export const ROLE_LABEL: Record<string, string> = { superadmin: 'Superadmin', admin: 'Admin', user: 'User' };

const FEATURE_NAME: Record<string, string> = {
  can_edit_delivery_date: 'Edit Delivery Date',
  can_job_edit: 'Job Edit',
  can_use_attendance: 'Remote Attendance',
  can_use_tracking: 'Live location tracking',
  can_view_leave_summary: 'Leave Summary on Dashboard',
  can_grant_module_access: 'Can grant module access',
  can_view_login_location: 'See last login location',
  can_access_user_panel: 'User Panel access',
  can_manage_leave: 'Leave balance edit',
  can_view_movement_claims: 'Movement Claim',
  can_view_conveyance_claims: 'Conveyance Claim',
  can_view_budget_module: 'Budget / Jobs / MPR',
  can_view_timesheet: 'Timesheet',
  can_use_chat: 'Chat',
  can_use_calls: 'Audio / Video Calls',
  can_use_mail: 'Credence Mail',
  can_view_mail_directory: 'Mail: Email Directory',
  can_use_mail_groups: 'Mail: My groups',
  can_receive_material: 'Material Receive',
  can_return_dispatch: 'Take back / Confirm in Dispatch',
  can_give_feedback: 'Give feedback',
  can_use_fingerprint: 'Fingerprint login',
  can_view_roster: 'My Duty Roster',
  can_take_break: 'Break Time',
  can_sign_documents: 'Documents to Sign',
  can_view_payslip: 'My Payslip',
  can_request_items: 'SIM & ID Card requests',
  can_email_reports: 'Email reports',
  can_view_group_dashboard: 'Admin Dashboard: all companies',
  can_view_tasks: 'My Tasks',
  can_view_mobile_bill: 'My Mobile SIM',
  can_view_service_book: 'My Service Book',
  can_view_loan_request: 'Loan / Advance Request',
  can_view_targets: 'My Targets',
  can_view_leave_application: 'Leave Application',
  can_view_my_leave: 'My Leave'
};

interface AuditEntry {
  id: number;
  action: string;
  detail: Record<string, any> | null;
  actor_name: string | null;
  created_at: string;
}

// Plain-language lines for one audit entry (UserManagement.ts records the
// endpoint and request body of every change).
function describeAudit(e: AuditEntry): string[] {
  const d = e.detail || {};
  const onOff = (v: any) => (v ? 'turned on' : 'turned off');
  const lines: string[] = [];
  switch (e.action) {
    case 'role':
      lines.push(`Role changed to ${ROLE_LABEL[d.role] || d.role}`);
      break;
    case 'module-permissions': {
      const names = (Array.isArray(d.modules) ? d.modules : []).map((k: string) => ADMIN_MODULES.find((m) => m.key === k)?.label || k);
      lines.push(names.length > 0 ? `Admin Panel modules set: ${names.join(', ')}` : 'All Admin Panel modules removed');
      break;
    }
    case 'module-permission-layers':
      lines.push(`Module actions updated${d.module ? ` for ${ADMIN_MODULES.find((m) => m.key === d.module)?.label || d.module}` : ''}`);
      break;
    case 'reset-password':
      lines.push('Password reset');
      break;
    case 'email':
      lines.push(`Login ID changed${d.email ? ` to ${d.email}` : ''}`);
      break;
    case 'projects':
      lines.push('Projects updated');
      break;
    case 'delete':
      lines.push('Account deleted');
      break;
    default:
      for (const [k, v] of Object.entries(d)) {
        if (k === '_template') continue;
        if (k === 'attendance_project_id') lines.push(v == null ? 'Attendance project: any' : 'Attendance project changed');
        else if (FEATURE_NAME[k]) lines.push(`${FEATURE_NAME[k]} ${onOff(v)}`);
      }
      if (lines.length === 0) {
        if (e.action.endsWith('-departments')) lines.push('Department scope updated');
        else lines.push(e.action.replace(/-/g, ' '));
      }
  }
  if (d._template) lines[lines.length - 1] += ` (template “${d._template}”)`;
  return lines;
}

function Switch({ on, busy, disabled, onClick, label }: { on: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}
    >
      <span className={`inline-flex items-center justify-center transform rounded-full bg-white transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-1'}`} style={{ width: 18, height: 18 }}>
        {busy && <Spinner size={10} />}
      </span>
    </button>
  );
}

function FeatureRow({
  icon: Icon,
  title,
  description,
  on,
  busy,
  onToggle,
  children
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  on: boolean;
  busy?: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${on ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800">{title}</div>
          <p className="text-xs text-slate-500 mt-0.5">{description}</p>
        </div>
        <Switch on={on} busy={busy} onClick={onToggle} label={title} />
      </div>
      {children && <div className="mt-2 ml-11">{children}</div>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-slate-100">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</h4>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
      <div className="mt-1">{children}</div>
    </section>
  );
}

type PageSection = 'account' | 'access' | 'features' | 'admin' | 'activity';

interface UserAccessDrawerProps {
  u: User;
  isSuperAdmin: boolean;
  canGrantModuleAccess: boolean;
  canSeeLoginLocation: boolean;
  projectCount: number;
  projects: { id: number; project_name: string }[];
  lastLogin: React.ReactNode;
  onClose: () => void;
  onToggleFeature: (field: UserFeatureField, value: boolean) => Promise<void>;
  onToggleLoginLocation: (value: boolean) => Promise<void>;
  onAttendanceProject: (projectId: number | null) => Promise<void>;
  onRoleChange: (role: 'admin' | 'user') => void;
  onOpenModules: () => void;
  onOpenProjects: () => void;
  onChangeLoginId: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
  // Users -> "Block Account" layer: block / unblock this login.
  canBlock: boolean;
  onBlock: (blocked: boolean, reason: string) => Promise<void>;
  token: string;
  templates: AccessTemplate[];
  onApplyTemplate: (t: AccessTemplate) => Promise<void>;
}

export function UserAccessDrawer({
  u,
  isSuperAdmin,
  canGrantModuleAccess,
  canSeeLoginLocation,
  projectCount,
  projects,
  lastLogin,
  onClose,
  onToggleFeature,
  onToggleLoginLocation,
  onAttendanceProject,
  onRoleChange,
  onOpenModules,
  onOpenProjects,
  onChangeLoginId,
  onResetPassword,
  onDelete,
  canBlock,
  onBlock,
  token,
  templates,
  onApplyTemplate
}: UserAccessDrawerProps) {
  useBackButtonClose(true, onClose);
  const [busy, setBusy] = useState<string | null>(null);
  // Last switch changed here, for the "Undo" bar (hidden after a few seconds).
  const [lastChange, setLastChange] = useState<{ field: UserFeatureField; prev: boolean } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [templateMsg, setTemplateMsg] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [section, setSection] = useState<PageSection>('account');
  const blocked = !!u.is_blocked;
  const changeBlock = (next: boolean, reason: string) =>
    run('block', async () => {
      setBlockError(null);
      try {
        await onBlock(next, reason);
        setBlockReason(null);
      } catch (err: any) {
        setBlockError(err.message || 'Could not change the block.');
      }
    });

  // Re-read the activity list whenever this account's access changes.
  const accessSignature = JSON.stringify([
    u.role,
    u.module_permissions,
    u.can_edit_delivery_date,
    u.can_job_edit,
    u.can_use_attendance,
    u.can_use_tracking,
    u.can_view_leave_summary,
    u.attendance_project_id,
    u.can_view_login_location,
    u.can_grant_module_access,
    u.email
  ]);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(apiUrl(`/api/users/${u.id}/access-audit`), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => {
          if (!cancelled) setActivity(Array.isArray(rows) ? rows : []);
        })
        .catch(() => {
          if (!cancelled) setActivity([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [u.id, token, accessSignature]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const isTargetSuper = u.role === 'superadmin';
  // Same rule the old table used: a delegated Admin only ever edits role='user'.
  const canEdit = !isTargetSuper && (u.role !== 'admin' || isSuperAdmin);
  const canManageModules = canGrantModuleAccess && !isTargetSuper && (u.role === 'user' || (u.role === 'admin' && isSuperAdmin));
  const modules = u.module_permissions || [];
  const moduleLabels = modules.map((k) => ADMIN_MODULES.find((m) => m.key === k)?.label || k);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const toggle = (field: UserFeatureField, current: boolean) =>
    run(field, async () => {
      await onToggleFeature(field, !current);
      setLastChange({ field, prev: current });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setLastChange(null), 8000);
    });
  const undo = () => {
    if (!lastChange) return;
    const { field, prev } = lastChange;
    setLastChange(null);
    run(field, () => onToggleFeature(field, prev));
  };
  const applyTemplate = async (id: string) => {
    const t = templates.find((x) => String(x.id) === id);
    if (!t || !(await confirmDialog(`Apply “${t.name}” to ${u.name}? It turns its switches on and adds its modules — nothing is removed.`))) return;
    setTemplateMsg(null);
    run('template', async () => {
      try {
        await onApplyTemplate(t);
        setTemplateMsg(`Applied “${t.name}”.`);
      } catch (err: any) {
        setTemplateMsg(err.message || 'Could not apply the template.');
      }
    });
  };

  const delivery = u.can_edit_delivery_date ?? true;
  const selfService: { label: string; on: boolean }[] = [
    { label: 'Leave Application', on: !!u.can_view_leave_application },
    { label: 'Leave balance edit', on: !!u.can_manage_leave },
    { label: 'Timesheet', on: !!u.can_view_timesheet },
    { label: 'Chat', on: u.can_use_chat !== false },
    { label: 'Audio / Video Calls', on: !!u.can_use_calls },
    { label: 'Credence Mail', on: !!u.can_use_mail },
    { label: 'Mail: Email Directory', on: !!u.can_view_mail_directory },
    { label: 'Mail: My groups', on: !!u.can_use_mail_groups },
    { label: 'Material Receive', on: !!u.can_receive_material },
    { label: 'Take back / Confirm in Dispatch', on: !!u.can_return_dispatch },
    { label: 'Give feedback', on: !!u.can_give_feedback },
    { label: 'Fingerprint login', on: !!u.can_use_fingerprint },
    { label: 'My Duty Roster', on: !!u.can_view_roster },
    { label: 'Break Time', on: !!u.can_take_break },
    { label: 'Documents to Sign', on: !!u.can_sign_documents },
    { label: 'My Payslip', on: !!u.can_view_payslip },
    { label: 'SIM & ID Card requests', on: !!u.can_request_items },
    { label: 'Email reports', on: !!u.can_email_reports },
    { label: 'Admin Dashboard: all companies', on: !!u.can_view_group_dashboard },
    { label: 'My Tasks', on: !!u.can_view_tasks },
    { label: 'My Mobile SIM', on: !!u.can_view_mobile_bill },
    { label: 'My Service Book', on: !!u.can_view_service_book },
    { label: 'Loan / Advance Request', on: !!u.can_view_loan_request },
    { label: 'My Targets', on: !!u.can_view_targets },
    { label: 'Movement Claim', on: !!u.can_view_movement_claims },
    { label: 'Conveyance Claim', on: !!u.can_view_conveyance_claims },
    { label: 'Budget / Jobs / MPR', on: u.can_view_budget_module ?? true }
  ];

  const featureOn = [!!u.can_use_attendance, !!u.can_use_tracking, !!u.can_view_leave_summary, delivery, !!u.can_job_edit].filter(Boolean).length;
  const tabs: { key: PageSection; label: string; icon: React.ElementType; count?: number }[] = [
    { key: 'account', label: 'Account', icon: KeyRound },
    { key: 'access', label: 'Access', icon: LayoutGrid, count: isTargetSuper ? undefined : modules.length + selfService.filter((x) => x.on).length },
    ...(canEdit ? [{ key: 'features' as PageSection, label: 'Features', icon: Fingerprint, count: featureOn }] : []),
    ...(canEdit && isSuperAdmin && u.role === 'admin' ? [{ key: 'admin' as PageSection, label: 'Admin powers', icon: ShieldCheck }] : []),
    { key: 'activity', label: 'Activity', icon: History, count: activity?.length }
  ];
  const current = tabs.some((t) => t.key === section) ? section : 'account';

  // A page in place of the Users page (same frame as Module Access): one
  // section at a time, a rail on the left (a chip row on a phone). The
  // password / Login ID / Projects popups still open on top of it.
  return (
    <div className="w-full">
      <div className="relative bg-white border border-slate-200 rounded-2xl w-full flex flex-col shadow-sm">
        <div className="md:sticky md:top-16 z-20 bg-white rounded-t-2xl border-b border-slate-200 p-4 md:p-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Back to Users"
            title="Back to Users"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold shrink-0" style={{ background: 'var(--g-gradient)' }}>
            {userInitials(u.name)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base md:text-lg font-bold text-slate-900 truncate">{u.name}</h2>
            <div className="text-xs text-slate-500 truncate">{u.email || u.username || '—'}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className={`font-semibold px-2 py-0.5 rounded-full border ${ROLE_BADGE[u.role]}`}>{ROLE_LABEL[u.role]}</span>
              {blocked && <span className="font-semibold px-2 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700">Blocked</span>}
              {u.created_at && <span>Joined {formatDate(u.created_at)}</span>}
            </div>
          </div>
          {canManageModules && (
            <button
              type="button"
              onClick={onOpenModules}
              className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl"
            >
              <LayoutGrid className="w-4 h-4" /> Module Access
            </button>
          )}
        </div>

        <div className="md:grid md:grid-cols-[230px_1fr] min-h-[480px]">
          <nav className="flex md:block gap-1.5 overflow-x-auto md:overflow-visible p-2.5 md:p-3 border-b md:border-b-0 md:border-r border-slate-200 bg-slate-50/50">
            {tabs.map((t) => {
              const active = current === t.key;
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSection(t.key)}
                  className={`shrink-0 md:w-full flex items-center gap-2 px-3 py-2 md:py-2.5 rounded-xl text-sm whitespace-nowrap border md:border-0 md:mb-0.5 ${
                    active ? 'bg-violet-100 border-violet-300 text-violet-800 font-bold' : 'bg-white md:bg-transparent border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{t.label}</span>
                  {t.count !== undefined && (
                    <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${t.count > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{t.count}</span>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="min-w-0 md:max-w-3xl">
            {current === 'account' && (
              <>
                <Section title="Account">
              {isSuperAdmin && !isTargetSuper && (
                <div className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Role</div>
                    <p className="text-xs text-slate-500">Admins can open the Admin Panel; Users only see their own pages.</p>
                  </div>
                  <select
                    value={u.role}
                    onChange={(e) => onRoleChange(e.target.value as 'admin' | 'user')}
                    className="text-sm px-3 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              )}
              {canEdit ? (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button type="button" onClick={onChangeLoginId} className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
                    <Mail className="w-3.5 h-3.5" /> Change Login ID
                  </button>
                  <button type="button" onClick={onResetPassword} className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
                    <Lock className="w-3.5 h-3.5" /> Reset Password
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 py-2">
                  {isTargetSuper ? 'The Superadmin account has every permission and can’t be edited here.' : 'Only the Superadmin can edit another Admin.'}
                </p>
              )}
              {blocked && (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                  <div className="font-semibold flex items-center gap-1.5">
                    <Ban className="w-3.5 h-3.5" /> Login blocked{u.blocked_at ? ` since ${formatDate(u.blocked_at)}` : ''}
                  </div>
                  {u.blocked_reason && <div className="mt-0.5 text-rose-600">{u.blocked_reason}</div>}
                </div>
              )}
              {canEdit && canBlock && (
                <div className="mt-2">
                  {blocked ? (
                    <button
                      type="button"
                      disabled={busy === 'block'}
                      onClick={() => changeBlock(false, '')}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                    >
                      {busy === 'block' ? <Spinner size={14} /> : <Ban className="w-3.5 h-3.5" />} Unblock login
                    </button>
                  ) : blockReason === null ? (
                    <button
                      type="button"
                      onClick={() => setBlockReason('')}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                    >
                      <Ban className="w-3.5 h-3.5" /> Block login
                    </button>
                  ) : (
                    <div className="rounded-xl border border-rose-200 p-2.5 space-y-2">
                      <p className="text-xs text-slate-600">They are signed out at once and can’t sign in until unblocked.</p>
                      <input
                        autoFocus
                        value={blockReason}
                        onChange={(e) => setBlockReason(e.target.value)}
                        placeholder="Reason (e.g. Suspended pending inquiry)"
                        className="w-full text-sm px-3 py-1.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-rose-200 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setBlockReason(null)}
                          className="flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!blockReason.trim() || busy === 'block'}
                          onClick={() => changeBlock(true, blockReason.trim())}
                          className="flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                          {busy === 'block' ? 'Blocking…' : 'Block'}
                        </button>
                      </div>
                    </div>
                  )}
                  {blockError && <p className="mt-1.5 text-xs text-rose-600">{blockError}</p>}
                </div>
              )}
            </Section>
                {canSeeLoginLocation && (
              <Section title="Last login">
                <div className="flex items-start gap-2 py-1 text-xs text-slate-600">
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">{lastLogin}</div>
                </div>
              </Section>
            )}
                {canEdit && (
                  <section className="px-5 py-4">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-rose-500">Danger zone</h4>
                    <div className="mt-2">
                      <button
                  type="button"
                  onClick={onDelete}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete this user
                </button>
                    </div>
                  </section>
                )}
              </>
            )}
            {current === 'access' && <Section title="Access" hint="What this account can open.">
              <button
                type="button"
                disabled={!canManageModules}
                onClick={onOpenModules}
                className="w-full flex items-center gap-3 py-2.5 text-left disabled:cursor-default group"
              >
                <div className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
                  <LayoutGrid className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-800">Admin Panel modules</div>
                  <p className="text-xs text-slate-500 truncate">
                    {isTargetSuper ? 'All modules (Superadmin)' : modules.length > 0 ? moduleLabels.join(', ') : 'None granted'}
                  </p>
                </div>
                {canManageModules && (
                  <span className="text-xs font-semibold text-blue-600 flex items-center gap-0.5 group-hover:underline">
                    Manage <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                )}
              </button>
              <button
                type="button"
                disabled={u.role !== 'user'}
                onClick={onOpenProjects}
                className="w-full flex items-center gap-3 py-2.5 text-left disabled:cursor-default group"
              >
                <div className="w-8 h-8 rounded-lg bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-800">Projects (Budget / Jobs / MPR)</div>
                  <p className="text-xs text-slate-500">
                    {u.role !== 'user' ? 'All projects (Admin)' : projectCount > 0 ? `${projectCount} project${projectCount === 1 ? '' : 's'}` : 'None granted'}
                  </p>
                </div>
                {u.role === 'user' && (
                  <span className="text-xs font-semibold text-blue-600 flex items-center gap-0.5 group-hover:underline">
                    Manage <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                )}
              </button>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {selfService.map((s) => (
                  <span
                    key={s.label}
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${
                      s.on ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-400 border-slate-200 line-through'
                    }`}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              {canManageModules && <p className="text-[11px] text-slate-400 mt-1.5">Self Service pages above are switched in “Admin Panel modules → Manage”.</p>}
              {canEdit && templates.length > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <LayoutTemplate className="w-4 h-4 text-slate-400 shrink-0" />
                  <SearchSelect
                    value=""
                    disabled={busy === 'template'}
                    onChange={(e) => applyTemplate(e.target.value)}
                    className="flex-1 text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    <option value="">Apply an access template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </SearchSelect>
                  {busy === 'template' && <Spinner size={14} />}
                </div>
              )}
              {templateMsg && <p className="text-[11px] text-slate-500 mt-1">{templateMsg}</p>}
            </Section>}
            {current === 'features' && canEdit && (
              <>
                <Section title="Attendance & location">
                  <FeatureRow
                    icon={Fingerprint}
                    title="Remote Attendance"
                    description="Shows the Check In / Check Out card on this person’s Dashboard."
                    on={!!u.can_use_attendance}
                    busy={busy === 'can_use_attendance'}
                    onToggle={() => toggle('can_use_attendance', !!u.can_use_attendance)}
                  >
                    {u.can_use_attendance && (
                      <label className="block">
                        <span className="text-[11px] text-slate-500">Allowed project for check-in</span>
                        <SearchSelect
                          value={u.attendance_project_id ?? ''}
                          disabled={busy === 'attendance_project'}
                          onChange={(e) => run('attendance_project', () => onAttendanceProject(e.target.value ? Number(e.target.value) : null))}
                          className="mt-0.5 w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        >
                          <option value="">Any project (no restriction)</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.project_name}
                            </option>
                          ))}
                        </SearchSelect>
                      </label>
                    )}
                  </FeatureRow>
                  <FeatureRow
                    icon={Navigation}
                    title="Live location tracking (mobile app)"
                    description="The app sends this person’s location in the background for Employee Tracking and the Live Ride Map."
                    on={!!u.can_use_tracking}
                    busy={busy === 'can_use_tracking'}
                    onToggle={() => toggle('can_use_tracking', !!u.can_use_tracking)}
                  />
                </Section>

                <Section title="Leave">
                  <FeatureRow
                    icon={CalendarDays}
                    title="Leave Summary on Dashboard"
                    description="Shows the Leave Summary card and the Leave tab (their own leave list). Applying for leave is a separate permission under modules."
                    on={!!u.can_view_leave_summary}
                    busy={busy === 'can_view_leave_summary'}
                    onToggle={() => toggle('can_view_leave_summary', !!u.can_view_leave_summary)}
                  />
                </Section>

                <Section title="Jobs / MPR">
                  <FeatureRow
                    icon={CalendarClock}
                    title="Edit Delivery Date"
                    description="Can change an entry’s Delivery Date after Submit, even after Final Submit."
                    on={delivery}
                    busy={busy === 'can_edit_delivery_date'}
                    onToggle={() => toggle('can_edit_delivery_date', delivery)}
                  />
                  <FeatureRow
                    icon={Edit2}
                    title="Job Edit"
                    description="Can add, edit or delete MPRs inside a Job whose Budget is already Final Submitted."
                    on={!!u.can_job_edit}
                    busy={busy === 'can_job_edit'}
                    onToggle={() => toggle('can_job_edit', !!u.can_job_edit)}
                  />
                </Section>
              </>
            )}
            {current === 'admin' && canEdit && isSuperAdmin && u.role === 'admin' && <Section title="Admin powers" hint="Only for Admin accounts.">
                    <FeatureRow
                      icon={Eye}
                      title="See users’ last login location"
                      description="Shows the Last Login column in User Management."
                      on={!!u.can_view_login_location}
                      busy={busy === 'login_location'}
                      onToggle={() => run('login_location', () => onToggleLoginLocation(!u.can_view_login_location))}
                    />
                    <FeatureRow
                      icon={ShieldCheck}
                      title="Can grant module access"
                      description="Can set other Users’ Admin Panel modules (never another Admin’s)."
                      on={!!u.can_grant_module_access}
                      busy={busy === 'can_grant_module_access'}
                      onToggle={() => toggle('can_grant_module_access', !!u.can_grant_module_access)}
                    />
                  </Section>}
            {current === 'activity' && <Section title="Activity" hint="Access changes to this account, newest first.">
              {activity === null ? (
                <div className="py-2">
                  <Spinner size={14} />
                </div>
              ) : activity.length === 0 ? (
                <p className="text-xs text-slate-400 py-1">No changes recorded yet.</p>
              ) : (
                <ol className="mt-1 space-y-2.5 border-l-2 border-slate-100 pl-3">
                  {activity.slice(0, 30).map((e) => (
                    <li key={e.id} className="text-xs">
                      {describeAudit(e).map((line, i) => (
                        <div key={i} className="text-slate-700">
                          {line}
                        </div>
                      ))}
                      <div className="text-[11px] text-slate-400 flex items-center gap-1">
                        <History className="w-3 h-3" />
                        {e.actor_name || 'Someone'} · {new Date(e.created_at).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>}
          </div>
        </div>

        {lastChange && (
          <div className="sticky bottom-0 z-20 rounded-b-2xl px-5 py-3 border-t border-slate-200 bg-slate-900 text-white text-xs flex items-center gap-3">
            <span className="flex-1">
              {FEATURE_NAME[lastChange.field] || lastChange.field} {lastChange.prev ? 'turned off' : 'turned on'} — saved.
            </span>
            <button type="button" onClick={undo} className="flex items-center gap-1 font-semibold text-sky-300 hover:text-sky-200">
              <Undo2 className="w-3.5 h-3.5" /> Undo
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

// "Access" column / card line in User Management: what this account can open,
// at a glance — module and project counts, then one chip per feature switch
// that's on.
export function UserAccessChips({ u, projectCount }: { u: User; projectCount: number }) {
  if (u.role === 'superadmin') {
    return <span className="text-xs text-slate-400">Everything (Superadmin)</span>;
  }
  const modules = (u.module_permissions || []).length;
  const chips: { label: string; tone: string }[] = [];
  chips.push({
    label: modules > 0 ? `${modules} module${modules === 1 ? '' : 's'}` : 'No modules',
    tone: modules > 0 ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-slate-50 text-slate-400 border-slate-200'
  });
  if (u.role === 'user') {
    chips.push({
      label: projectCount > 0 ? `${projectCount} project${projectCount === 1 ? '' : 's'}` : 'No projects',
      tone: projectCount > 0 ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-slate-50 text-slate-400 border-slate-200'
    });
  }
  const on = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (u.can_use_attendance) chips.push({ label: 'Attendance', tone: on });
  if (u.can_use_tracking) chips.push({ label: 'Tracking', tone: on });
  if (u.can_view_leave_summary) chips.push({ label: 'Leave Summary', tone: on });
  if (u.can_job_edit) chips.push({ label: 'Job Edit', tone: on });
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.label} className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${c.tone}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}
