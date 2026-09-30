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

const KEY = 'credence_company_id';

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
    if (!company || !sameOriginApi) return original(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-Company-Id')) headers.set('X-Company-Id', String(company));
    return original(input, { ...init, headers });
  };
}

export interface CompanyInfo {
  id: number;
  name: string;
  short_code: string;
  is_mother: boolean;
  has_logo: boolean;
}
export interface MyCompanies {
  group: { id: number; name: string; short_name: string | null };
  companies: CompanyInfo[];
  default_company_id: number;
  active_company_id: number;
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
  setActiveCompanyId(id);
  cache = null;
  window.location.reload();
}
