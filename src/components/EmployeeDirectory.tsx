/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Contact, Search, X, Users2, Building2, LayoutGrid, List,
  Mail, Phone, PhoneCall, Briefcase, MapPin, ChevronLeft, ChevronRight
} from 'lucide-react';
import { User, Department, EmployeeDirectoryEntry } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface EmployeeDirectoryProps {
  token: string;
  user: User;
  onBack: () => void;
}

const PAGE_SIZE_OPTIONS = [12, 24] as const;

// Deterministic soft background color for an initials avatar, picked off the
// employee's name so the same person always lands on the same color instead
// of a random one flickering on every re-render.
const AVATAR_PALETTE = [
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700'
];

// Soft pastel gradient tints for the "liquid glass" mobile card background —
// same hash as the avatar color so a given employee's card and avatar tint
// stay visually paired instead of clashing.
const CARD_TINT_PALETTE = [
  'from-blue-100/70 via-white/50 to-indigo-50/40',
  'from-violet-100/70 via-white/50 to-fuchsia-50/40',
  'from-emerald-100/70 via-white/50 to-teal-50/40',
  'from-amber-100/70 via-white/50 to-orange-50/40',
  'from-rose-100/70 via-white/50 to-pink-50/40',
  'from-cyan-100/70 via-white/50 to-sky-50/40'
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function cardTintClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CARD_TINT_PALETTE[hash % CARD_TINT_PALETTE.length];
}

// Office location line for a directory row — Branch is the closest thing
// all_employees has to a physical "sitting place" (Status tab); Division/
// Unit are appended when on file, since a department alone doesn't say
// where someone actually sits.
function officeLocationOf(emp: EmployeeDirectoryEntry): string | null {
  const parts = [emp.branch, emp.division, emp.unit].filter((p) => p && p.trim());
  return parts.length ? parts.join(' · ') : null;
}

const Avatar: React.FC<{ name: string; sizeClass?: string; glass?: boolean }> = ({ name, sizeClass = 'w-12 h-12 text-sm', glass = false }) => (
  <div
    className={`${sizeClass} rounded-full flex items-center justify-center font-bold shrink-0 ${avatarColorClass(name)} ${
      glass ? 'ring-2 ring-white/80 shadow-sm' : ''
    }`}
  >
    {initialsOf(name)}
  </div>
);

// In-memory cache so the same employee's photo (once fetched as a blob
// object URL) isn't re-requested every time their card re-renders or the
// user pages back to a row they've already seen this session. Keyed by
// user_id — entries without a linked user_id never had a login account to
// upload a photo against, so they always fall back to initials.
const photoUrlCache = new Map<number, string | null>();

// Employee Directory's photo shows the account's uploaded profile photo
// (Self Service -> Personal Data, same source as the Navbar/GlobalSidebar
// avatar) via GET /api/profile/photo/:userId, falling back to the initials
// Avatar while loading, when the employee has no linked user_id, or when
// they simply haven't uploaded a photo (404).
const EmployeePhoto: React.FC<{
  userId: number | null;
  token: string;
  name: string;
  sizeClass?: string;
  glass?: boolean;
}> = ({ userId, token, name, sizeClass, glass }) => {
  const [url, setUrl] = useState<string | null>(userId ? photoUrlCache.get(userId) ?? null : null);

  useEffect(() => {
    if (!userId || photoUrlCache.has(userId)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/profile/photo/${userId}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
          photoUrlCache.set(userId, null);
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        photoUrlCache.set(userId, objectUrl);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        photoUrlCache.set(userId, null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, token]);

  if (url) {
    return (
      <img
        src={url}
        alt={name}
        className={`${sizeClass} rounded-full object-cover shrink-0 ${glass ? 'ring-2 ring-white/80 shadow-sm' : ''}`}
      />
    );
  }
  return <Avatar name={name} sizeClass={sizeClass} glass={glass} />;
};

const StatusBadge: React.FC<{ isActive: boolean }> = ({ isActive }) => (
  <span
    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
      isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'
    }`}
  >
    {isActive ? 'Active' : 'Inactive'}
  </span>
);

export const EmployeeDirectory: React.FC<EmployeeDirectoryProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();

  const [employees, setEmployees] = useState<EmployeeDirectoryEntry[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [designationFilter, setDesignationFilter] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(12);
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeDirectoryEntry | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const authHeaders = { Authorization: `Bearer ${token}` };
        const [empRes, deptRes] = await Promise.all([
          fetch(apiUrl('/api/employee-directory'), { headers: authHeaders }),
          fetch(apiUrl('/api/departments'), { headers: authHeaders })
        ]);
        if (!empRes.ok) throw new Error((await empRes.json()).error || 'Failed to load the Employee Directory');
        setEmployees(await empRes.json());
        if (deptRes.ok) setDepartments(await deptRes.json());
      } catch (err: any) {
        setError(err.message || 'Failed to load the Employee Directory');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Designation Filter's own option list — built from whatever designations
  // actually appear on file, rather than a fixed list, since job titles are
  // free-typed on the Employee Info tab.
  const designations = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => {
      if (e.designation && e.designation.trim()) set.add(e.designation.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q) && !(e.employee_id || '').toLowerCase().includes(q)) return false;
      if (departmentFilter && String(e.department_id || '') !== departmentFilter) return false;
      if (designationFilter && e.designation !== designationFilter) return false;
      return true;
    });
  }, [employees, search, departmentFilter, designationFilter]);

  // Any filter/search/page-size change should land back on page 1 — staying
  // on, say, page 4 of a now much shorter result list would just show an
  // empty page.
  useEffect(() => {
    setCurrentPage(1);
  }, [search, departmentFilter, designationFilter, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageSafe = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  const activeCount = employees.filter((e) => e.is_active).length;

  const clearFilters = () => {
    setSearch('');
    setDepartmentFilter('');
    setDesignationFilter('');
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Employee Directory']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-transparent sm:bg-white rounded-none sm:rounded-2xl shadow-none sm:shadow-sm border-0 sm:border sm:border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="p-6 border-b border-slate-200 hidden sm:flex sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center shrink-0">
                <Contact className="w-5 h-5 text-violet-600" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-800">Employee Directory</h1>
                <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                  Every employee on file, with their Department, Designation, and work contact details.
                </p>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-center min-w-[84px]">
                <p className="text-base font-bold text-slate-900">{employees.length}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Employees</p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-center min-w-[84px]">
                <p className="text-base font-bold text-slate-900">{departments.length}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Departments</p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-center min-w-[84px]">
                <p className="text-base font-bold text-emerald-600">{activeCount}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Active</p>
              </div>
            </div>
          </div>

          {error && (
            <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl">
              {error}
            </div>
          )}

          {/* Search & Control Bar */}
          <div className="p-4 sm:p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or Employee ID…"
                className="w-full pl-9 pr-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Department filter — kept visible on mobile (both native app and a
                narrow web browser), unlike Designation/Clear Filters/View Switcher
                just below, which stay desktop-only. Department is the one filter
                most worth having on a phone: Employee Directory has no other way
                to narrow a long roster down to one team while on mobile. */}
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="w-full lg:w-auto px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            {!isNativeApp && (
              <div className="hidden sm:contents">
                <select
                  value={designationFilter}
                  onChange={(e) => setDesignationFilter(e.target.value)}
                  className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">All Designations</option>
                  {designations.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>

                {(search || departmentFilter || designationFilter) && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded-xl transition-colors whitespace-nowrap"
                  >
                    Clear Filters
                  </button>
                )}

                {/* View Switcher */}
                <div className="flex items-center bg-slate-100 rounded-xl p-1 self-start lg:self-auto">
                  <button
                    type="button"
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
                    title="Grid View"
                  >
                    <LayoutGrid className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
                    title="Table / List View"
                  >
                    <List className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="p-4 sm:p-6">
            {loading ? (
              viewMode === 'grid' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="rounded-2xl border border-slate-200 p-4 space-y-3 animate-pulse">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-slate-200" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 bg-slate-200 rounded w-2/3" />
                          <div className="h-2.5 bg-slate-100 rounded w-1/2" />
                        </div>
                      </div>
                      <div className="h-2.5 bg-slate-100 rounded w-full" />
                      <div className="h-2.5 bg-slate-100 rounded w-3/4" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-12 bg-slate-100 rounded-xl animate-pulse" />
                  ))}
                </div>
              )
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Users2 className="w-10 h-10 text-slate-300 mb-3" />
                <p className="text-sm font-medium text-slate-600">No employees found matching your search.</p>
                <p className="text-xs text-slate-400 mt-1">Try a different name, Employee ID, or clear the filters.</p>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                {paginated.map((emp) => (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => setSelectedEmployee(emp)}
                    className={`relative text-left rounded-[28px] sm:rounded-2xl overflow-hidden border border-white/70 sm:border-slate-200 p-3 sm:p-4 space-y-2 sm:space-y-3 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] sm:shadow-sm bg-gradient-to-br ${cardTintClass(emp.name)} sm:bg-none sm:bg-white backdrop-blur-xl sm:backdrop-blur-none hover:shadow-lg hover:border-white sm:hover:border-blue-200 transition-all`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                        <div className="relative shrink-0">
                          <EmployeePhoto
                            userId={emp.user_id}
                            token={token}
                            name={emp.name}
                            sizeClass="w-10 h-10 text-xs sm:w-12 sm:h-12 sm:text-sm"
                            glass
                          />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${
                              emp.is_active ? 'bg-emerald-400' : 'bg-slate-300'
                            }`}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 text-sm truncate">{emp.name}</p>
                          <p className="text-xs text-slate-600 sm:text-slate-500 truncate">{emp.designation || '—'}</p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500 sm:text-slate-300 shrink-0 sm:hidden" />
                      <div className="hidden sm:block shrink-0">
                        <StatusBadge isActive={emp.is_active} />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap gap-1 sm:gap-1.5 min-w-0">
                        {emp.employee_id && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-white/50 sm:bg-slate-100 backdrop-blur sm:backdrop-blur-none text-slate-700 sm:text-slate-600 border border-white/60 sm:border-slate-200">
                            ID: {emp.employee_id}
                          </span>
                        )}
                        {emp.department && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/50 sm:bg-blue-50 backdrop-blur sm:backdrop-blur-none text-blue-800 sm:text-blue-700 border border-white/60 sm:border-blue-200">
                            <Building2 className="w-3 h-3" /> {emp.department}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0 sm:hidden">
                        {emp.email && (
                          <a
                            href={`mailto:${emp.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="w-8 h-8 rounded-full bg-white/60 backdrop-blur border border-white/60 shadow-sm flex items-center justify-center text-slate-600 hover:bg-white hover:text-blue-600 transition-colors"
                            title={emp.email}
                          >
                            <Mail className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {(emp.mobile || emp.phone) && (
                          <a
                            href={`tel:${emp.mobile || emp.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            className="w-8 h-8 rounded-full bg-white/60 backdrop-blur border border-white/60 shadow-sm flex items-center justify-center text-slate-600 hover:bg-white hover:text-emerald-600 transition-colors"
                            title={emp.mobile || emp.phone}
                          >
                            <Phone className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="hidden sm:block space-y-1 text-xs text-slate-600 border-t border-slate-100 pt-2">
                      {emp.email && (
                        <a
                          href={`mailto:${emp.email}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 hover:text-blue-600 truncate"
                        >
                          <Mail className="w-3 h-3 text-slate-400 shrink-0" /> <span className="truncate">{emp.email}</span>
                        </a>
                      )}
                      {(emp.mobile || emp.phone) && (
                        <a
                          href={`tel:${emp.mobile || emp.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 hover:text-blue-600"
                        >
                          <Phone className="w-3 h-3 text-slate-400 shrink-0" /> {emp.mobile || emp.phone}
                        </a>
                      )}
                      {!emp.email && !emp.mobile && !emp.phone && <p className="text-slate-400">No contact info on file</p>}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-left border-collapse min-w-[720px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                      <th className="px-3 py-2 font-semibold">Name &amp; ID</th>
                      <th className="px-3 py-2 font-semibold">Designation</th>
                      <th className="px-3 py-2 font-semibold">Department</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Mobile</th>
                      <th className="px-3 py-2 font-semibold">Extension</th>
                      <th className="px-3 py-2 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginated.map((emp) => (
                      <tr key={emp.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <EmployeePhoto userId={emp.user_id} token={token} name={emp.name} sizeClass="w-8 h-8 text-[10px]" />
                            <div>
                              <p className="font-semibold text-slate-900 text-xs">{emp.name}</p>
                              {emp.employee_id && <p className="text-[10px] text-slate-400 font-mono">{emp.employee_id}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">{emp.designation || '—'}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">{emp.department || '—'}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                          {emp.email ? <a href={`mailto:${emp.email}`} className="hover:text-blue-600">{emp.email}</a> : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                          {emp.mobile ? <a href={`tel:${emp.mobile}`} className="hover:text-blue-600">{emp.mobile}</a> : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{emp.telephone || '—'}</td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedEmployee(emp)}
                            className="px-3 py-1.5 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {!loading && filtered.length > 0 && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6 pt-4 border-t border-slate-100">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>
                    Showing {(pageSafe - 1) * pageSize + 1}–{Math.min(pageSafe * pageSize, filtered.length)} of {filtered.length}
                  </span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])}
                    className="px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n} / page</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={pageSafe <= 1}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-600 px-2">Page {pageSafe} of {totalPages}</span>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={pageSafe >= totalPages}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Employee Details Modal */}
      {selectedEmployee && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className={`rounded-[32px] max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto border border-white/60 backdrop-blur-2xl bg-gradient-to-br ${cardTintClass(selectedEmployee.name)}`}>
            {/* Hero */}
            <div className="relative h-44 sm:h-48 bg-gradient-to-br from-violet-500 via-indigo-500 to-blue-500 flex items-center justify-center shrink-0">
              <button
                onClick={() => setSelectedEmployee(null)}
                className="absolute top-4 left-4 w-9 h-9 rounded-full bg-white/25 backdrop-blur flex items-center justify-center text-white hover:bg-white/40 transition-colors"
              >
                <X className="w-4.5 h-4.5" />
              </button>

              <div className="absolute top-4 right-4 flex items-center gap-2">
                {(selectedEmployee.mobile || selectedEmployee.phone) && (
                  <a
                    href={`tel:${selectedEmployee.mobile || selectedEmployee.phone}`}
                    className="w-9 h-9 rounded-full bg-white/25 backdrop-blur flex items-center justify-center text-white hover:bg-white/40 transition-colors"
                  >
                    <Phone className="w-4 h-4" />
                  </a>
                )}
                {selectedEmployee.email && (
                  <a
                    href={`mailto:${selectedEmployee.email}`}
                    className="w-9 h-9 rounded-full bg-white/25 backdrop-blur flex items-center justify-center text-white hover:bg-white/40 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                  </a>
                )}
              </div>

              <EmployeePhoto
                userId={selectedEmployee.user_id}
                token={token}
                name={selectedEmployee.name}
                sizeClass="w-24 h-24 text-2xl"
                glass
              />

              <span
                className={`absolute bottom-4 right-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold backdrop-blur ${
                  selectedEmployee.is_active ? 'bg-emerald-400/90 text-white' : 'bg-slate-400/80 text-white'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white" /> {selectedEmployee.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>

            {/* Overlapping card */}
            <div className="relative -mt-6 rounded-t-[32px] bg-white/50 backdrop-blur-2xl border-t border-white/60 px-5 pt-5 pb-6 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold text-slate-900 truncate">{selectedEmployee.name}</h2>
                  <p className="text-sm text-slate-500 mt-0.5 truncate">
                    {selectedEmployee.designation || '—'}
                    {selectedEmployee.department ? ` · ${selectedEmployee.department}` : ''}
                  </p>
                </div>
                {selectedEmployee.employee_id && (
                  <span className="shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold bg-violet-50 text-violet-700 border border-violet-100">
                    ID: {selectedEmployee.employee_id}
                  </span>
                )}
              </div>

              {/* Quick stat pills */}
              <div className="grid grid-cols-3 divide-x divide-white/50 bg-white/40 backdrop-blur rounded-2xl border border-white/60 overflow-hidden">
                <div className="px-2 py-3 text-center min-w-0">
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">Department</p>
                  <p className="text-xs font-semibold text-slate-800 mt-1 truncate">{selectedEmployee.department || '—'}</p>
                </div>
                <div className="px-2 py-3 text-center min-w-0">
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">Status</p>
                  <p className={`text-xs font-semibold mt-1 ${selectedEmployee.is_active ? 'text-emerald-600' : 'text-slate-500'}`}>
                    {selectedEmployee.is_active ? 'Active' : 'Inactive'}
                  </p>
                </div>
                <div className="px-2 py-3 text-center min-w-0">
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">Reports To</p>
                  <p className="text-xs font-semibold text-slate-800 mt-1 truncate">{selectedEmployee.supervisor_name || '—'}</p>
                </div>
              </div>

              <div className="space-y-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Contact Information</p>
                {selectedEmployee.email && (
                  <a href={`mailto:${selectedEmployee.email}`} className="flex items-center gap-2 text-sm text-slate-700 hover:text-blue-600">
                    <Mail className="w-4 h-4 text-slate-400" /> {selectedEmployee.email}
                  </a>
                )}
                {selectedEmployee.mobile && (
                  <a href={`tel:${selectedEmployee.mobile}`} className="flex items-center gap-2 text-sm text-slate-700 hover:text-blue-600">
                    <Phone className="w-4 h-4 text-slate-400" /> {selectedEmployee.mobile}
                  </a>
                )}
                {selectedEmployee.phone && selectedEmployee.phone !== selectedEmployee.mobile && (
                  <a href={`tel:${selectedEmployee.phone}`} className="flex items-center gap-2 text-sm text-slate-700 hover:text-blue-600">
                    <PhoneCall className="w-4 h-4 text-slate-400" /> {selectedEmployee.phone}
                  </a>
                )}
                {selectedEmployee.telephone && (
                  <p className="flex items-center gap-2 text-sm text-slate-700">
                    <Briefcase className="w-4 h-4 text-slate-400" /> Ext: {selectedEmployee.telephone}
                  </p>
                )}
                {officeLocationOf(selectedEmployee) && (
                  <p className="flex items-center gap-2 text-sm text-slate-700">
                    <MapPin className="w-4 h-4 text-slate-400" /> {officeLocationOf(selectedEmployee)}
                  </p>
                )}
                {!selectedEmployee.email && !selectedEmployee.mobile && !selectedEmployee.phone && !selectedEmployee.telephone && (
                  <p className="text-xs text-slate-400">No contact info on file.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};