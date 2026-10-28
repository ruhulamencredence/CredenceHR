/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Multi-company — which company the app is working in (see CompanyRoutes.ts /
// companyContext.ts on the server). The picked company is remembered on this
// device and sent with every API call as the X-Company-Id header; the server
// checks the account may enter it and otherwise falls back to the account's
// default company, so a stale or missing value is always safe.
//
// installCompanyHeader() patches window.fetch once (main.tsx) so the several
// hundred existing fetch('/api/...') calls all carry the header without each
// needing to change.

import { useEffect, useState } from 'react';
import { ACCOUNT_BLOCKED_EVENT, DEVICE_REVOKED_EVENT, SESSION_ENDED_EVENT } from './device';

const KEY = 'credence_company_id';
// "All companies" mode (an account the Superadmin allowed it): every API call
// also carries X-Company-Scope: all; the server ignores it without the
// permission. The company above stays the one new records go to.
const ALL_KEY = 'credence_company_all';

export function getAllCompaniesMode(): boolean {
  try {
    return localStorage.getItem(ALL_KEY) === '1';
  } catch {
    return false;
  }
}

function setAllCompaniesMode(on: boolean) {
  try {
    if (on) localStorage.setItem(ALL_KEY, '1');
    else localStorage.removeItem(ALL_KEY);
  } catch {
    // storage unavailable — one company at a time
  }
}

export function getActiveCompanyId(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setActiveCompanyId(id: number | null) {
  try {
    if (id) localStorage.setItem(KEY, String(id));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable — the server uses the account's default company
  }
}

let installed = false;
export function installCompanyHeader() {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const company = getActiveCompanyId();
    const sameOriginApi = url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
    // A phone the Superadmin removed from this account is signed out
    // (DeviceRoutes.ts; App.tsx listens).
    const watch = (p: Promise<Response>) =>
      p.then((res) => {
        if (sameOriginApi && res.status === 401 && res.headers.get('X-Device-Revoked')) window.dispatchEvent(new Event(DEVICE_REVOKED_EVENT));
        const blocked = sameOriginApi && res.status === 401 ? res.headers.get('X-Account-Blocked') : null;
        if (blocked) window.dispatchEvent(new CustomEvent(ACCOUNT_BLOCKED_EVENT, { detail: blocked }));
        const ended = sameOriginApi && res.status === 401 ? res.headers.get('X-Session-Ended') : null;
        if (ended) window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: ended }));
        return res;
      });
    const all = getAllCompaniesMode();
    if ((!company && !all) || !sameOriginApi) return watch(original(input, init));
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (company && !headers.has('X-Company-Id')) headers.set('X-Company-Id', String(company));
    if (all && !headers.has('X-Company-Scope')) headers.set('X-Company-Scope', 'all');
    return watch(original(input, { ...init, headers }));
  };
}

export interface CompanyInfo {
  id: number;
  name: string;
  short_code: string;
  is_mother: boolean;
  has_logo: boolean;
}
export interface WorkspaceEntry {
  id: number;
  name: string;
  workspace_code: string | null;
  company_id: number;
  is_home: boolean;
}
export interface MyCompanies {
  group: { id: number; name: string; short_name: string | null };
  companies: CompanyInfo[];
  default_company_id: number;
  active_company_id: number;
  // All companies mode: allowed for this account / on right now.
  can_work_all_companies?: boolean;
  all_companies?: boolean;
  // The system owner working inside another group's workspace.
  visiting?: boolean;
  home_company_id?: number;
  // Only for the system owner: every workspace, to open any of them.
  workspaces?: WorkspaceEntry[];
}

let cache: { token: string; data: MyCompanies } | null = null;
export function useMyCompanies(token: string | null) {
  const [data, setData] = useState<MyCompanies | null>(cache && cache.token === token ? cache.data : null);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch('/api/companies/mine', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MyCompanies | null) => {
        if (!d || !alive) return;
        cache = { token, data: d };
        // Keep the remembered company in step with what the server used.
        if (getActiveCompanyId() !== d.active_company_id) setActiveCompanyId(d.active_company_id);
        // The permission was taken away: back to one company.
        if (getAllCompaniesMode() && !d.all_companies) setAllCompaniesMode(false);
        setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token]);
  return data;
}

// Switching company reloads the app so every screen loads that company's data.
export function switchCompany(id: number) {
  setAllCompaniesMode(false);
  setActiveCompanyId(id);
  cache = null;
  window.location.reload();
}

// All companies mode: every company the account may enter at once; `id` is
// the company new records go to (normally the one already selected).
export function switchToAllCompanies(id: number) {
  setAllCompaniesMode(true);
  setActiveCompanyId(id);
  cache = null;
  window.location.reload();
}
