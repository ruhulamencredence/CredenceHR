/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users: Access Templates and bulk changes. Every change goes
// through the same per-user endpoints the Manage panel uses, so the server's
// permission checks and the access audit log (UserManagement.ts) apply to
// each account individually.

import { User } from '../types';
import { apiUrl } from './api';

export type TemplateFeature =
  | 'can_edit_delivery_date'
  | 'can_job_edit'
  | 'can_use_attendance'
  | 'can_use_tracking'
  | 'can_view_leave_summary';

export const TEMPLATE_FEATURES: { key: TemplateFeature; label: string }[] = [
  { key: 'can_use_attendance', label: 'Remote Attendance' },
  { key: 'can_use_tracking', label: 'Live location tracking' },
  { key: 'can_view_leave_summary', label: 'Leave Summary on Dashboard' },
  { key: 'can_edit_delivery_date', label: 'Edit Delivery Date' },
  { key: 'can_job_edit', label: 'Job Edit' }
];

export interface AccessTemplate {
  id: number;
  name: string;
  description: string;
  features: TemplateFeature[];
  modules: string[];
}

export interface AccessViewer {
  isSuperAdmin: boolean;
  canGrantModuleAccess: boolean;
}

// Same rules as the server: a delegated Admin only ever changes role 'user'.
export function canEditUserFeatures(u: User, viewer: AccessViewer): boolean {
  return u.role !== 'superadmin' && (u.role !== 'admin' || viewer.isSuperAdmin);
}
export function canEditUserModules(u: User, viewer: AccessViewer): boolean {
  return viewer.canGrantModuleAccess && (u.role === 'user' || (u.role === 'admin' && viewer.isSuperAdmin));
}

async function put(token: string, path: string, body: unknown, templateName?: string) {
  const res = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(templateName ? { 'X-Access-Template': templateName } : {})
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Update failed');
}

// Turns on the template's switches and ADDS its modules — nothing the
// account already has is taken away.
export async function applyTemplateToUser(token: string, template: AccessTemplate, u: User, viewer: AccessViewer) {
  if (template.features.length > 0) {
    await put(token, `/api/users/${u.id}/feature-permissions`, Object.fromEntries(template.features.map((f) => [f, true])), template.name);
  }
  if (template.modules.length > 0 && canEditUserModules(u, viewer)) {
    const current = u.module_permissions || [];
    const merged = Array.from(new Set([...current, ...template.modules]));
    if (merged.length !== current.length) {
      await put(token, `/api/users/${u.id}/module-permissions`, { modules: merged }, template.name);
    }
  }
}

export async function setFeatureForUser(token: string, u: User, feature: TemplateFeature, value: boolean) {
  await put(token, `/api/users/${u.id}/feature-permissions`, { [feature]: value });
}

export interface BulkResult {
  done: number;
  skipped: string[];
  failed: { name: string; error: string }[];
}

// Runs one change per account, one after another, reporting progress.
export async function runBulk(
  users: User[],
  eligible: (u: User) => boolean,
  change: (u: User) => Promise<void>,
  onProgress: (done: number, total: number) => void
): Promise<BulkResult> {
  const result: BulkResult = { done: 0, skipped: [], failed: [] };
  const targets = users.filter((u) => {
    if (eligible(u)) return true;
    result.skipped.push(u.name);
    return false;
  });
  for (let i = 0; i < targets.length; i++) {
    try {
      await change(targets[i]);
      result.done++;
    } catch (err: any) {
      result.failed.push({ name: targets[i].name, error: err.message || 'Failed' });
    }
    onProgress(i + 1, targets.length);
  }
  return result;
}
