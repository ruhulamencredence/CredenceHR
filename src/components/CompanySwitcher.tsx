/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Header company switcher — only shown to accounts that may work in more than
// one company of their group (see src/lib/company.ts). Picking a company
// reloads the app in that company. The system owner also sees every
// workspace here and can open any of them (working there as its Superadmin).
// An account allowed "All companies" mode (Admin Panel -> Companies -> Company
// access) also gets an All companies entry: every company's employees at once,
// new records still going to the company that was selected.

import React, { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Globe, Layers, LogOut } from 'lucide-react';
import { useMyCompanies, switchCompany, switchToAllCompanies } from '../lib/company';

export const CompanySwitcher: React.FC<{ token: string; transparent?: boolean }> = ({ token, transparent }) => {
  const data = useMyCompanies(token);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const workspaces = data?.workspaces || [];
  if (!data || (data.companies.length < 2 && workspaces.length < 2 && !data.visiting)) return null;
  const active = data.companies.find((c) => c.id === data.active_company_id) || data.companies[0];
  if (!active) return null;
  const all = !!data.all_companies;
  return (
    <div ref={ref} className="relative shrink-0 flex items-center gap-1.5">
      {data.visiting && (
        <span
          title={`You are working inside ${data.group.name} as the system owner`}
          className="hidden sm:inline-flex items-center gap-1 h-8 px-2.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold border border-amber-300"
        >
          <Globe className="w-3.5 h-3.5" /> {data.group.short_name || data.group.name}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={all ? `All companies (new records go to ${active.name}) — switch company` : `${active.name} — switch company`}
        aria-label="Switch company"
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-full border text-xs font-semibold transition-colors ${
          transparent ? 'border-white/40 text-white hover:bg-white/10' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
        }`}
      >
        {all ? <Layers className="w-3.5 h-3.5" /> : <Building2 className="w-3.5 h-3.5" />}
        <span className="max-w-[110px] md:max-w-[180px] truncate">
          <span className="md:hidden">{all ? 'All' : active.short_code}</span>
          <span className="hidden md:inline">{all ? 'All companies' : active.name}</span>
        </span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">{data.group.name || 'Companies'}</div>
          {data.can_work_all_companies && (
            <button
              type="button"
              onClick={() => (all ? setOpen(false) : switchToAllCompanies(active.id))}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm hover:bg-slate-50 border-b border-slate-100 ${all ? 'bg-blue-50/60' : ''}`}
            >
              <Layers className="w-4 h-4 text-slate-500 shrink-0 ml-3 mr-3" />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-semibold text-slate-800">All companies</span>
                <span className="block text-[10px] text-slate-400">
                  {all ? `New records go to ${active.short_code}` : 'Every company’s employees together'}
                </span>
              </span>
              {all && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
            </button>
          )}
          {data.companies.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => (c.id === active.id && !all ? setOpen(false) : switchCompany(c.id))}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm hover:bg-slate-50 ${c.id === active.id && !all ? 'bg-blue-50/60' : ''}`}
            >
              <span className="w-10 shrink-0 text-[10px] font-bold text-slate-500">{c.short_code}</span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-semibold text-slate-800">{c.name}</span>
                {c.is_mother && <span className="block text-[10px] text-slate-400">Mother company</span>}
              </span>
              {c.id === active.id && !all && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
            </button>
          ))}
          {workspaces.length > 1 && (
            <>
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 border-y border-slate-100 bg-slate-50">
                Workspaces (system owner)
              </div>
              <div className="max-h-64 overflow-y-auto">
                {workspaces.map((w) => {
                  const here = w.id === data.group.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => (here ? setOpen(false) : switchCompany(w.is_home && data.home_company_id ? data.home_company_id : w.company_id))}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm hover:bg-slate-50 ${here ? 'bg-blue-50/60' : ''}`}
                    >
                      <Globe className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-semibold text-slate-800">{w.name}</span>
                        <span className="block text-[10px] text-slate-400">
                          {w.workspace_code || '—'}
                          {w.is_home ? ' · your workspace' : ''}
                        </span>
                      </span>
                      {here && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {data.visiting && data.home_company_id && (
            <button
              type="button"
              onClick={() => switchCompany(data.home_company_id!)}
              className="w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 border-t border-slate-100"
            >
              <LogOut className="w-4 h-4 shrink-0" /> Back to my workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
};
