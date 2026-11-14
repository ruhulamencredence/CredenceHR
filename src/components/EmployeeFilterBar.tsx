/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employees -> Directory: search, Status and the Filters (the same layout as
// Bill Disbursement — a grid of fields, then each filter that is on as a chip
// with its own ×). On a phone the grid sits behind one "Filters" button
// (PhoneSheet). The server does the filtering: EmployeeFilters.ts, given to
// GET /api/employees and to the Export.

import React from 'react';
import { Search, X } from 'lucide-react';
import { SearchSelect } from './Combobox';
import { DateInput } from './DateInput';
import { PhoneSheet } from './PhoneSheet';

type Opt = { value: string; count?: number; label?: string };

const LBL = 'block text-[10px] font-semibold text-slate-500 mb-1';
const INPUT = 'w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';

// Text fields with a list of values from the employees themselves.
const VALUE_FIELDS: { key: string; label: string; all: string }[] = [
  { key: 'designation', label: 'Designation', all: 'All designations' },
  { key: 'job_status', label: 'Job Status', all: 'Any job status' },
  { key: 'employment_category', label: 'Employment Category', all: 'Any category' },
  { key: 'job_base', label: 'Job Base', all: 'Any job base' },
  { key: 'division', label: 'Division', all: 'Any division' },
  { key: 'gender', label: 'Gender', all: 'Any gender' },
  { key: 'blood_group', label: 'Blood Group', all: 'Any blood group' }
];
const PLACE_LABEL: Record<string, string> = { head_office: 'Head Office', project: 'Project', not_set: 'Not set' };
const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export const EmployeeFilterBar: React.FC<{
  search: string;
  onSearch: (v: string) => void;
  status: 'all' | 'active' | 'inactive';
  onStatus: (v: 'all' | 'active' | 'inactive') => void;
  counts: { all: number; active: number; inactive: number };
  total: number;
  dept: string;
  onDept: (v: string) => void;
  departments: string[];
  filters: Record<string, string>;
  onFilter: (key: string, value: string) => void;
  options: Record<string, Opt[]>;
  onClearAll: () => void;
}> = ({ search, onSearch, status, onStatus, counts, total, dept, onDept, departments, filters, onFilter, options, onClearAll }) => {
  const opts = (k: string) => options[k] || [];
  const withCount = (o: Opt) => (o.count != null ? `${o.value} (${o.count})` : o.value);
  const missingLabel = (v: string) => opts('missing').find((m) => m.value === v)?.label || v;
  const none = (v: string, what: string) => (v === '__none__' ? `No ${what}` : v);

  const chips: { label: string; clear: () => void }[] = [
    ...(search.trim() ? [{ label: `Search: ${search.trim()}`, clear: () => onSearch('') }] : []),
    ...(dept ? [{ label: `Department: ${none(dept, 'department')}`, clear: () => onDept('') }] : []),
    ...(filters.place ? [{ label: `Office / Project: ${PLACE_LABEL[filters.place] || filters.place}`, clear: () => onFilter('place', '') }] : []),
    ...(filters.branch ? [{ label: `Branch: ${none(filters.branch, 'branch')}`, clear: () => onFilter('branch', '') }] : []),
    ...VALUE_FIELDS.filter((f) => filters[f.key]).map((f) => ({ label: `${f.label}: ${none(filters[f.key], f.label.toLowerCase())}`, clear: () => onFilter(f.key, '') })),
    ...(filters.login ? [{ label: filters.login === 'yes' ? 'Has login' : 'No login', clear: () => onFilter('login', '') }] : []),
    ...(filters.joined_from || filters.joined_to
      ? [
          {
            label: `Joined: ${filters.joined_from ? fmtDay(filters.joined_from) : '…'} – ${filters.joined_to ? fmtDay(filters.joined_to) : '…'}`,
            clear: () => {
              onFilter('joined_from', '');
              onFilter('joined_to', '');
            }
          }
        ]
      : []),
    ...(filters.missing ? [{ label: `Missing: ${missingLabel(filters.missing)}`, clear: () => onFilter('missing', '') }] : [])
  ];
  const active = chips.filter((c) => !c.label.startsWith('Search:')).length;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 sm:p-4 flex flex-col gap-3" data-testid="emp-filters">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="emp-search" className={LBL}>Search</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              id="emp-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search employees"
              placeholder="Name, Employee ID, designation, department, branch, email, phone…"
              className={`${INPUT} pl-8`}
            />
          </div>
        </div>
        <div className="min-w-0 sm:w-80">
          <span className={LBL}>Status</span>
          <div className="flex bg-slate-100 rounded-lg p-0.5" role="group" aria-label="Status">
            {(['active', 'inactive', 'all'] as const).map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={status === st}
                onClick={() => onStatus(st)}
                className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold capitalize transition-colors whitespace-nowrap ${
                  status === st ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {st} ({counts[st]})
              </button>
            ))}
          </div>
        </div>
      </div>

      <PhoneSheet label="Filters" kind="filter" title="Filter employees" activeCount={active}>
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 items-end">
          <div className="min-w-0">
            <span className={LBL}>Department</span>
            <SearchSelect value={dept} onChange={(e) => onDept(e.target.value)} aria-label="Department" className={INPUT}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="__none__">No department</option>
            </SearchSelect>
          </div>
          <div className="min-w-0">
            <span className={LBL}>Office / Project</span>
            <select id="emp-place" aria-label="Office / Project" value={filters.place || ''} onChange={(e) => onFilter('place', e.target.value)} className={INPUT}>
              <option value="">All</option>
              <option value="head_office">Head Office</option>
              <option value="project">Project</option>
              <option value="not_set">Not set</option>
            </select>
          </div>
          <div className="min-w-0">
            <span className={LBL}>Duty Location / Branch</span>
            <SearchSelect value={filters.branch || ''} onChange={(e) => onFilter('branch', e.target.value)} aria-label="Branch" className={INPUT}>
              <option value="">All branches</option>
              {opts('branch').map((o) => <option key={o.value} value={o.value}>{withCount(o)}</option>)}
              <option value="__none__">No branch</option>
            </SearchSelect>
          </div>
          {VALUE_FIELDS.map((f) => (
            <div key={f.key} className="min-w-0">
              <span className={LBL}>{f.label}</span>
              <SearchSelect value={filters[f.key] || ''} onChange={(e) => onFilter(f.key, e.target.value)} aria-label={f.label} className={INPUT}>
                <option value="">{f.all}</option>
                {opts(f.key).map((o) => <option key={o.value} value={o.value}>{withCount(o)}</option>)}
                <option value="__none__">Not set</option>
              </SearchSelect>
            </div>
          ))}
          <div className="min-w-0">
            <span className={LBL}>Login</span>
            <select id="emp-login" aria-label="Login" value={filters.login || ''} onChange={(e) => onFilter('login', e.target.value)} className={INPUT}>
              <option value="">With or without</option>
              <option value="yes">Has login</option>
              <option value="no">No login</option>
            </select>
          </div>
          <div className="min-w-0 col-span-2">
            <span className={LBL}>Joining date</span>
            <div className="grid grid-cols-2 gap-1.5">
              <DateInput value={filters.joined_from || ''} onChange={(v) => onFilter('joined_from', v)} aria-label="Joined from" placeholder="from" className={INPUT} />
              <DateInput value={filters.joined_to || ''} onChange={(v) => onFilter('joined_to', v)} aria-label="Joined to" placeholder="to" className={INPUT} />
            </div>
          </div>
          <div className="min-w-0">
            <span className={LBL}>Missing</span>
            <select id="emp-missing" aria-label="Missing" value={filters.missing || ''} onChange={(e) => onFilter('missing', e.target.value)} className={INPUT}>
              <option value="">Nothing picked</option>
              {opts('missing').map((o) => <option key={o.value} value={o.value}>No {o.label}</option>)}
            </select>
          </div>
        </div>
      </PhoneSheet>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="emp-chips">
          <span className="text-[11px] font-semibold text-slate-500 mr-1 tabular-nums">{total} found</span>
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1 text-[11px] font-semibold pl-2.5 pr-1 py-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200">
              {c.label}
              <button type="button" onClick={c.clear} aria-label={`Remove ${c.label}`} className="w-4 h-4 rounded-full grid place-items-center hover:bg-blue-100">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" onClick={onClearAll} className="text-[11px] font-semibold text-slate-500 underline hover:text-slate-800 px-1">
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default EmployeeFilterBar;
