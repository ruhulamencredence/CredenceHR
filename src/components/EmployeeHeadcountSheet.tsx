/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employees / HR Operations -> "Office / Project & Branch": how many work at
// each Head Office / Project and Duty Location / Branch, tap one for its
// people; plus Excel of the counts, of a list, and (with the export layer)
// every employee's details in the HR Data Import layout. EmployeeHeadcount.ts.

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Building2, ChevronRight, FileSpreadsheet, HardHat, Loader2, MapPin, Search, Users, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { SearchSelect } from './Combobox';
import { useIsPhone } from '../lib/useScrolling';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';

interface Person {
  id: number;
  employee_id: string;
  name: string;
  designation: string;
  department: string;
  phone: string;
  joining_date: string | null;
  active: boolean;
}
interface Branch {
  branch: string;
  count: number;
  people: Person[];
}
interface Group {
  kind: 'Head Office' | 'Project' | 'Not set';
  count: number;
  branches: Branch[];
}
interface Data {
  total: number;
  groups: Group[];
  departments: string[];
}

const KIND_ICON = { 'Head Office': Building2, Project: HardHat, 'Not set': MapPin } as const;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

// Can this account use the headcount / export here? Same rule as the
// server's requireModuleLayer: saved layers decide; none saved = the
// module's default (headcount on, export off). A Superadmin always can.
export function employeeLayer(user: { role?: string; module_permission_layers?: Record<string, string[] | undefined> } | null, source: 'employees' | 'hr', what: 'headcount' | 'export'): boolean {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  const mod = source === 'hr' ? 'hr_operations' : 'employees';
  const key = source === 'hr' ? (what === 'headcount' ? 'hr_headcount' : 'hr_emp_export') : what === 'headcount' ? 'emp_headcount' : 'emp_export';
  const saved = user.module_permission_layers?.[mod];
  return saved && saved.length ? saved.includes(key) : what === 'headcount';
}

// Every employee's details as Excel, in the HR Data Import layout.
// `extra`: the Directory's search and Filters (EmployeeFilters.ts), so the
// file holds exactly the people the list shows.
export async function exportEmployees(
  token: string,
  source: 'employees' | 'hr',
  status: 'active' | 'inactive' | 'all' = 'all',
  dept = '',
  extra: Record<string, string> = {}
): Promise<number> {
  const qs = new URLSearchParams({ status, ...(dept ? { department: dept } : {}), ...extra }).toString();
  const filtered = Object.keys(extra).length > 0;
  const r = await fetch(apiUrl(`${source === 'hr' ? '/api/hr-ops/employee-export' : '/api/employees/export'}?${qs}`), { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Could not export');
  const statusLabel = status === 'active' ? 'Active' : status === 'inactive' ? 'Inactive' : 'All';
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([d.columns, ...d.rows]);
  ws['!cols'] = d.columns.map((c: string) => ({ wch: Math.max(12, Math.min(36, c.length + 4)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const info = XLSX.utils.aoa_to_sheet([
    ['Employee export'],
    [''],
    ['Rows', String(d.rows.length)],
    ['Employees', `${statusLabel}${dept ? ` · ${dept === '__none__' ? 'No department' : dept}` : ''}${filtered ? ` · ${Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}`],
    ['Made', today()],
    ['Import back', 'Same columns as HR Data Import -> Employee Details: correct cells and import this file; empty cells keep what is saved. "Office / Project" is for reading only.'],
    ['Not included', 'Login ID, Password and salary payment accounts.']
  ]);
  info['!cols'] = [{ wch: 14 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  await saveWorkbookCrossPlatform(wb, `Employees_${statusLabel}${dept && dept !== '__none__' ? `_${dept.replace(/[^\w]+/g, '_')}` : ''}${filtered ? '_filtered' : ''}_${today()}.xlsx`);
  return d.rows.length;
}

export const EmployeeHeadcountSheet: React.FC<{
  token: string;
  // 'employees' -> /api/employees/*, 'hr' -> /api/hr-ops/*
  source: 'employees' | 'hr';
  canExport: boolean;
  onClose: () => void;
  onOpenEmployee?: (id: number) => void;
}> = ({ token, source, canExport, onClose, onOpenEmployee }) => {
  const phone = useIsPhone();
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [dept, setDept] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{ kind: string; branch: string | null } | null>(null);
  const [q, setQ] = useState('');
  useBackButtonClose(true, onClose);

  const base = source === 'hr' ? '/api/hr-ops' : '/api/employees';
  const exportPath = source === 'hr' ? '/api/hr-ops/employee-export' : '/api/employees/export';
  const qs = useMemo(() => new URLSearchParams({ status, ...(dept ? { department: dept } : {}) }).toString(), [status, dept]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    fetch(apiUrl(`${base}/headcount?${qs}`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok) throw new Error(d?.error || 'Could not load');
        setData(d);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [base, qs, token]);

  // The people of what is picked (a whole Head Office / Project, or one Branch).
  const picked = useMemo(() => {
    if (!data || !pick) return null;
    const g = data.groups.find((x) => x.kind === pick.kind);
    if (!g) return null;
    const list = pick.branch ? g.branches.find((b) => b.branch === pick.branch)?.people || [] : g.branches.flatMap((b) => b.people.map((p) => ({ ...p, _branch: b.branch })));
    const t = q.trim().toLowerCase();
    return {
      title: pick.branch ? `${pick.branch} · ${g.kind}` : `${g.kind} — all branches`,
      people: (list as (Person & { _branch?: string })[]).filter((p) => !t || [p.name, p.employee_id, p.designation, p.department, p.phone].some((v) => String(v || '').toLowerCase().includes(t)))
    };
  }, [data, pick, q]);

  const statusLabel = status === 'active' ? 'Active' : status === 'inactive' ? 'Inactive' : 'All';

  const downloadCounts = () => {
    if (!data) return;
    const rows: (string | number)[][] = [['Office / Project', 'Duty Location / Branch', 'Employees']];
    for (const g of data.groups) {
      for (const b of g.branches) rows.push([g.kind, b.branch, b.count]);
      rows.push([`${g.kind} total`, '', g.count]);
    }
    rows.push(['Total', '', data.total]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Headcount');
    const people: (string | number)[][] = [['Office / Project', 'Duty Location / Branch', 'Employee ID', 'Name', 'Designation', 'Department', 'Phone', 'Joining Date', 'Active']];
    for (const g of data.groups) for (const b of g.branches) for (const p of b.people) people.push([g.kind, b.branch, p.employee_id, p.name, p.designation, p.department, p.phone, p.joining_date || '', p.active ? 'Yes' : 'No']);
    const wp = XLSX.utils.aoa_to_sheet(people);
    wp['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 14 }, { wch: 28 }, { wch: 24 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 7 }];
    XLSX.utils.book_append_sheet(wb, wp, 'People');
    void saveWorkbookCrossPlatform(wb, `Headcount_by_Branch_${statusLabel}_${today()}.xlsx`);
  };

  const downloadExport = async () => {
    setBusy(true);
    setError('');
    try {
      await exportEmployees(token, source, status, dept);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const list = picked && (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h4 className="text-sm font-bold text-slate-900 flex-1 min-w-0 truncate">
          {picked.title} <span className="text-slate-400 font-semibold">({picked.people.length})</span>
        </h4>
        <label className="flex items-center gap-2 liquid-glass-inset rounded-full px-3 py-1.5 w-56">
          <Search className="w-3.5 h-3.5 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
        </label>
      </div>
      <div className="liquid-glass-inset rounded-2xl overflow-auto flex-1 min-h-0">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white/85 backdrop-blur">
            <tr className="text-left text-slate-500">
              <th className="px-3 py-2 font-semibold">Employee</th>
              {!pick?.branch && <th className="px-3 py-2 font-semibold">Branch</th>}
              <th className="px-3 py-2 font-semibold">Designation</th>
              <th className="px-3 py-2 font-semibold">Department</th>
              <th className="px-3 py-2 font-semibold">Phone</th>
            </tr>
          </thead>
          <tbody>
            {picked.people.map((p: any) => (
              <tr key={p.id} className={`border-t border-slate-200/60 ${onOpenEmployee ? 'cursor-pointer hover:bg-white/50' : ''}`} onClick={() => onOpenEmployee?.(p.id)}>
                <td className="px-3 py-2">
                  <span className="block font-semibold text-slate-800">{p.name}</span>
                  <span className="block text-[11px] text-slate-500">
                    {p.employee_id}
                    {!p.active && ' · Inactive'}
                  </span>
                </td>
                {!pick?.branch && <td className="px-3 py-2 text-slate-600">{p._branch}</td>}
                <td className="px-3 py-2 text-slate-600">{p.designation || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{p.department || '—'}</td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{p.phone || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {picked.people.length === 0 && <p className="text-xs text-slate-500 text-center py-8">No match.</p>}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Office / Project & Branch">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-start gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-slate-700" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900">Office / Project & Branch</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {data ? `${data.total} ${statusLabel.toLowerCase()} employees` : 'Loading…'} — Head Office or Project from the Branch’s type (Admin Panel → Branches).
              </p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 sm:px-6 pb-3 flex flex-wrap items-center gap-2 shrink-0">
            <div className="flex rounded-full bg-white/60 p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Which employees">
              {(['active', 'inactive', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={status === s}
                  onClick={() => setStatus(s)}
                  className={`px-3 py-1.5 rounded-full capitalize ${status === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="w-52">
              <SearchSelect value={dept} onChange={(e) => setDept(e.target.value)} className="w-full text-xs px-3 py-1.5 rounded-full bg-white/80 border border-white">
                <option value="">— All departments —</option>
                {(data?.departments || []).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </SearchSelect>
            </div>
            <span className="flex items-center gap-2 ml-auto">
              <button type="button" onClick={downloadCounts} disabled={!data} className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <FileSpreadsheet className="w-3.5 h-3.5" /> Headcount Excel
              </button>
              {canExport && (
                <button type="button" onClick={() => void downloadExport()} disabled={busy} className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} Export employees
                </button>
              )}
            </span>
          </div>
          {error && <p className="mx-4 sm:mx-6 mb-2 text-xs font-semibold text-rose-700">{error}</p>}

          <div className="flex-1 min-h-0 px-3 sm:px-6 pb-4 flex gap-4">
            {!data ? (
              <div className="flex-1 flex justify-center py-16">{!error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" />}</div>
            ) : phone && picked ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <button type="button" onClick={() => setPick(null)} className="self-start text-xs font-semibold text-slate-600 mb-2">
                  ← All places
                </button>
                {list}
              </div>
            ) : (
              <>
                <div className={`${phone ? 'flex-1' : 'w-[380px] shrink-0'} overflow-y-auto space-y-3 pr-1`}>
                  {data.groups.length === 0 && <p className="text-sm text-slate-500 text-center py-16">Nobody.</p>}
                  {data.groups.map((g) => {
                    const Icon = KIND_ICON[g.kind];
                    return (
                      <div key={g.kind} className="liquid-glass-inset rounded-2xl p-3">
                        <button
                          type="button"
                          onClick={() => setPick({ kind: g.kind, branch: null })}
                          className={`w-full flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left ${pick?.kind === g.kind && !pick.branch ? 'bg-white/80' : 'hover:bg-white/50'}`}
                        >
                          <Icon className="w-4 h-4 text-slate-600" />
                          <span className="flex-1 text-sm font-bold text-slate-900">{g.kind}</span>
                          <span className="text-sm font-extrabold text-slate-900">{g.count}</span>
                        </button>
                        <div className="mt-1 space-y-0.5">
                          {g.branches.map((b) => (
                            <button
                              key={b.branch}
                              type="button"
                              onClick={() => setPick({ kind: g.kind, branch: b.branch })}
                              className={`w-full flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs ${pick?.kind === g.kind && pick.branch === b.branch ? 'bg-white/80 font-semibold' : 'hover:bg-white/50'}`}
                            >
                              <span className="flex-1 min-w-0 truncate text-slate-700">{b.branch}</span>
                              <span className="font-bold text-slate-900">{b.count}</span>
                              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!phone && (
                  <div className="flex-1 min-w-0 min-h-0">
                    {list || <p className="text-sm text-slate-500 text-center py-16">Pick a Head Office / Project or a Branch to see its people.</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmployeeHeadcountSheet;
