/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Header company switcher — only shown to accounts that may work in more than
// one company of their group (see src/lib/company.ts). Picking a company
// reloads the app in that company.

import React, { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useMyCompanies, switchCompany } from '../lib/company';

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
  if (!data || data.companies.length < 2) return null;
  const active = data.companies.find((c) => c.id === data.active_company_id) || data.companies[0];
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${active.name} — switch company`}
        aria-label="Switch company"
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-full border text-xs font-semibold transition-colors ${
          transparent ? 'border-white/40 text-white hover:bg-white/10' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
        }`}
      >
        <Building2 className="w-3.5 h-3.5" />
        <span className="max-w-[110px] md:max-w-[180px] truncate">
          <span className="md:hidden">{active.short_code}</span>
          <span className="hidden md:inline">{active.name}</span>
        </span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">{data.group.name || 'Companies'}</div>
          {data.companies.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => (c.id === active.id ? setOpen(false) : switchCompany(c.id))}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm hover:bg-slate-50 ${c.id === active.id ? 'bg-blue-50/60' : ''}`}
            >
              <span className="w-10 shrink-0 text-[10px] font-bold text-slate-500">{c.short_code}</span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-semibold text-slate-800">{c.name}</span>
                {c.is_mother && <span className="block text-[10px] text-slate-400">Mother company</span>}
              </span>
              {c.id === active.id && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
