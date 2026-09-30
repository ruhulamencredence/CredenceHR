/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which company the current request is working in (multi-company support —
// see CompanyRoutes.ts). authenticateToken in server.ts resolves it once per
// request from the X-Company-Id header (the company picked in the app's
// switcher), checks the account may enter that company, and runs the rest of
// the request inside companyStore — so any code below it (route handlers,
// getAdminModules, helpers) can ask activeCompanyId() without it being passed
// around.
//
// Everything that existed before multi-company belongs to company 1 (the
// mother company, seeded by ensureCompanySchema), so a request that carries no
// header — an older app build, a script — keeps working exactly as before.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CompanyContext {
  companyId: number;
  groupId: number;
  // The group's mother company, and which kinds of settings (holidays, leave
  // policy…) this company uses from it instead of its own — see
  // SHARE_KINDS in companyScope.ts.
  motherId?: number;
  shared?: string[];
  // Background jobs that work on a whole group at once (e.g. the leave-year
  // rollover): every company of the group, never another group.
  wholeGroup?: boolean;
}

export const DEFAULT_COMPANY_ID = 1;
export const DEFAULT_GROUP_ID = 1;

export const companyStore = new AsyncLocalStorage<CompanyContext>();

export function activeCompanyId(): number {
  return companyStore.getStore()?.companyId ?? DEFAULT_COMPANY_ID;
}

export function activeGroupId(): number {
  return companyStore.getStore()?.groupId ?? DEFAULT_GROUP_ID;
}
