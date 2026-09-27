/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> "Manage": everything about one account in one side
// panel — account actions, module/project access, and every per-user
// feature switch with a plain-language description of what it does. Each
// switch still saves on its own (same endpoints AdminPanel.tsx always used);
// this panel just gathers them in one place instead of 16 table columns.

import React, { useState } from 'react';
import {
  X, KeyRound, Lock, Mail, Trash2, LayoutGrid, ChevronRight, MapPin, Fingerprint, Navigation, CalendarDays,
  CalendarClock, Edit2, ShieldCheck, Eye
} from 'lucide-react';
import { User, ADMIN_MODULES } from '../types';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

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
  onDelete
}: UserAccessDrawerProps) {
  useBackButtonClose(true, onClose);
  const [busy, setBusy] = useState<string | null>(null);

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
  const toggle = (field: UserFeatureField, current: boolean) => run(field, () => onToggleFeature(field, !current));

  const delivery = u.can_edit_delivery_date ?? true;
  const selfService: { label: string; on: boolean }[] = [
    { label: 'Leave Application', on: !!u.can_view_leave_application },
    { label: 'Leave balance edit', on: !!u.can_manage_leave },
    { label: 'Timesheet', on: !!u.can_view_timesheet },
    { label: 'Movement Claim', on: !!u.can_view_movement_claims },
    { label: 'Conveyance Claim', on: !!u.can_view_conveyance_claims },
    { label: 'Budget / Jobs / MPR', on: u.can_view_budget_module ?? true }
  ];

  // Starts below the app Navbar (h-16) so the header stays visible; the
  // Module Access / Projects / password popups (z-50) open on top of it.
  return (
    <div className="fixed inset-x-0 bottom-0 top-16 z-[45] flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-start gap-3">
          <div className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold shrink-0" style={{ background: 'var(--g-gradient)' }}>
            {userInitials(u.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold text-slate-900 truncate">{u.name}</div>
            <div className="text-xs text-slate-500 truncate">{u.email || u.username || '—'}</div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
              <span className={`font-semibold px-2 py-0.5 rounded-full border ${ROLE_BADGE[u.role]}`}>{ROLE_LABEL[u.role]}</span>
              {u.created_at && <span>Joined {formatDate(u.created_at)}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Account */}
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
          </Section>

          {/* Access */}
          <Section title="Access" hint="What this account can open.">
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
          </Section>

          {/* Features */}
          {canEdit ? (
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
                      <select
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
                      </select>
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

              {isSuperAdmin && u.role === 'admin' && (
                <Section title="Admin powers" hint="Only for Admin accounts.">
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
                </Section>
              )}
            </>
          ) : null}

          {canSeeLoginLocation && (
            <Section title="Last login">
              <div className="flex items-start gap-2 py-1 text-xs text-slate-600">
                <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="min-w-0">{lastLogin}</div>
              </div>
            </Section>
          )}

          {canEdit && (
            <div className="px-5 py-5">
              <button
                type="button"
                onClick={onDelete}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete this user
              </button>
            </div>
          )}
        </div>
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
