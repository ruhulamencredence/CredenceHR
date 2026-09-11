import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ListChecks, Search, Save, Layers, Building2, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle } from 'lucide-react';
import { User, LeaveBalance } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface LeaveManagementProps {
  token: string;
  user: User;
  onBack: () => void;
}

// "Self Service" > "Leave Management" — reachable from the Navbar's web-only
// "Self Service" header menu (see Navbar.tsx / App.tsx), same "takes over the
// main area" pattern as LeaveApplication.
//
// A Superadmin, or any Admin/User the Superadmin has granted can_manage_leave
// to (Admin Panel -> Users -> Module Access -> "Also allow editing Leave
// balances"), sees EVERY account here and can edit their Casual/Sick/Leave-
// without-Pay balance. Everyone else only ever sees their own balance,
// read-only.
export const LeaveManagement: React.FC<LeaveManagementProps> = ({ token, user, onBack }) => {
  const canManageAll = user.role === 'superadmin' || !!user.can_manage_leave;
  // Same isNativeApp split JobEditPanel.tsx already uses: the web build keeps
  // the table below untouched, the Android APK build gets a card list instead
  // (a wide multi-column table doesn't work well on a phone screen).
  const isNativeApp = Capacitor.isNativePlatform();

  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Row currently being edited (by user_id) plus its in-progress field values —
  // only ever relevant when canManageAll is true.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ casual_leave: string; sick_leave: string; leave_without_pay: string }>({
    casual_leave: '',
    sick_leave: '',
    leave_without_pay: ''
  });
  const [savingId, setSavingId] = useState<number | null>(null);

  // "Set Balance in Bulk" — set Casual/Sick/Leave-without-Pay for many accounts
  // at once instead of one row at a time: either every account (Global) or
  // every account whose linked Employee Directory row has one of the chosen
  // Departments (see LeaveBalance.department). Only ever shown/usable when
  // canManageAll is true.
  const [showBulkPanel, setShowBulkPanel] = useState(false);
  const [bulkApplyToAll, setBulkApplyToAll] = useState(true);
  const [bulkDepartments, setBulkDepartments] = useState<string[]>([]);
  const [bulkDraft, setBulkDraft] = useState<{ casual_leave: string; sick_leave: string; leave_without_pay: string }>({
    casual_leave: '',
    sick_leave: '',
    leave_without_pay: ''
  });
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [bulkSuccess, setBulkSuccess] = useState('');

  const departmentOptions = Array.from(
    new Set(balances.map((b) => b.department).filter((d): d is string => !!d))
  ).sort((a, b) => a.localeCompare(b));

  const fetchBalances = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/leave-balances'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave balances');
      setBalances(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load Leave balances');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = (b: LeaveBalance) => {
    setEditingId(b.user_id);
    setDraft({
      casual_leave: String(b.casual_leave),
      sick_leave: String(b.sick_leave),
      leave_without_pay: String(b.leave_without_pay)
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async (userId: number) => {
    const casual = Number(draft.casual_leave);
    const sick = Number(draft.sick_leave);
    const lwp = Number(draft.leave_without_pay);
    if ([casual, sick, lwp].some((n) => !Number.isFinite(n) || n < 0)) {
      setError('Leave balances must be non-negative numbers.');
      return;
    }
    setSavingId(userId);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/leave-balances/${userId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ casual_leave: casual, sick_leave: sick, leave_without_pay: lwp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setBalances((prev) =>
        prev.map((b) =>
          b.user_id === userId
            ? { ...b, casual_leave: casual, sick_leave: sick, leave_without_pay: lwp }
            : b
        )
      );
      setEditingId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const filtered = balances.filter((b) =>
    (b.user_name || '').toLowerCase().includes(search.toLowerCase())
  );

  const selectBulkAll = () => {
    setBulkApplyToAll(true);
    setBulkDepartments([]);
  };

  const toggleBulkDepartment = (dept: string) => {
    setBulkApplyToAll(false);
    setBulkDepartments((prev) => (prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept]));
  };

  const applyBulk = async () => {
    const casual = Number(bulkDraft.casual_leave);
    const sick = Number(bulkDraft.sick_leave);
    const lwp = Number(bulkDraft.leave_without_pay);
    if ([casual, sick, lwp].some((n) => !Number.isFinite(n) || n < 0)) {
      setBulkSuccess('');
      setBulkError('Leave balances must be non-negative numbers.');
      return;
    }
    if (!bulkApplyToAll && bulkDepartments.length === 0) {
      setBulkSuccess('');
      setBulkError('Select at least one Department, or choose Global (All Accounts).');
      return;
    }
    setBulkSaving(true);
    setBulkError('');
    setBulkSuccess('');
    try {
      const res = await fetch(apiUrl('/api/leave-balances/bulk'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          departments: bulkApplyToAll ? [] : bulkDepartments,
          casual_leave: casual,
          sick_leave: sick,
          leave_without_pay: lwp
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update balances');
      setBulkSuccess(`Updated ${data.updated_count} account${data.updated_count === 1 ? '' : 's'}.`);
      setBulkDraft({ casual_leave: '', sick_leave: '', leave_without_pay: '' });
      await fetchBalances();
    } catch (err: any) {
      setBulkError(err.message || 'Failed to update balances');
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'My Leave']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <ListChecks className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-800">My Leave</h1>
                <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                  {canManageAll
                    ? 'Set the Casual Leave, Sick Leave and Leave without Pay balance for every account.'
                    : 'Your current Casual Leave, Sick Leave and Leave without Pay balance.'}
                </p>
              </div>
            </div>
            {canManageAll && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name..."
                  className="pl-8 pr-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
                />
              </div>
            )}
          </div>

          {canManageAll && !isNativeApp && (
            <div className="border-b border-slate-200 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowBulkPanel((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-6 py-3 text-left hover:bg-slate-100/70 transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <Layers className="w-3.5 h-3.5 text-blue-600" /> Set Balance in Bulk
                </span>
                {showBulkPanel ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {showBulkPanel && (
                <div className="px-6 pb-5">
                  <p className="text-[11px] text-slate-500 mb-3">
                    Apply one balance to many accounts at once — Global (every account) or one or more Departments.
                  </p>

                  <div className="flex flex-wrap gap-2 mb-3">
                    <button
                      type="button"
                      onClick={selectBulkAll}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                        bulkApplyToAll
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                      }`}
                    >
                      Global (All Accounts)
                    </button>
                    {departmentOptions.map((dept) => {
                      const selected = !bulkApplyToAll && bulkDepartments.includes(dept);
                      return (
                        <button
                          key={dept}
                          type="button"
                          onClick={() => toggleBulkDepartment(dept)}
                          className={`flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                            selected
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                          }`}
                        >
                          <Building2 className="w-3 h-3" /> {dept}
                        </button>
                      );
                    })}
                    {departmentOptions.length === 0 && (
                      <span className="text-[11px] text-slate-400 self-center">
                        No Departments found in the Employee Directory yet — Global is the only option.
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    {(['casual_leave', 'sick_leave', 'leave_without_pay'] as const).map((field) => (
                      <div key={field}>
                        <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                          {field === 'casual_leave' ? 'Casual Leave' : field === 'sick_leave' ? 'Sick Leave' : 'Leave without Pay'}
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={bulkDraft[field]}
                          onChange={(e) => setBulkDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                          placeholder="0"
                          className="w-28 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={applyBulk}
                      disabled={bulkSaving}
                      className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50"
                    >
                      {bulkSaving ? <Spinner size={14} /> : <Layers className="w-3.5 h-3.5" />}
                      {bulkSaving ? 'Applying…' : 'Apply'}
                    </button>
                  </div>

                  {bulkError && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {bulkError}
                    </div>
                  )}
                  {bulkSuccess && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {bulkSuccess}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {canManageAll && isNativeApp && (
            <div className="border-b border-slate-200 p-4">
              <div
                className={`rounded-xl border overflow-hidden ${
                  showBulkPanel ? 'border-blue-300 bg-blue-50/20' : 'border-slate-200 bg-white'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setShowBulkPanel((v) => !v)}
                  className="w-full flex items-center justify-between gap-3 p-3.5 text-left"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Layers className="w-4 h-4 text-blue-600" /> Set Balance in Bulk
                  </span>
                  {showBulkPanel ? (
                    <ChevronUp className="w-4 h-4 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  )}
                </button>

                {showBulkPanel && (
                  <div className="px-3.5 pb-3.5">
                    <p className="text-[11px] text-slate-500 mb-3">
                      Apply one balance to many accounts — Global (every account), or pick one or more Departments below.
                    </p>

                    <button
                      type="button"
                      onClick={selectBulkAll}
                      className={`w-full text-left text-sm font-semibold px-3.5 py-2.5 rounded-xl border mb-2 transition-colors ${
                        bulkApplyToAll
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      Global — All Accounts
                    </button>

                    {departmentOptions.length > 0 ? (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {departmentOptions.map((dept) => {
                          const selected = !bulkApplyToAll && bulkDepartments.includes(dept);
                          return (
                            <button
                              key={dept}
                              type="button"
                              onClick={() => toggleBulkDepartment(dept)}
                              className={`flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                                selected
                                  ? 'bg-blue-600 text-white border-blue-600'
                                  : 'bg-slate-50 text-slate-600 border-slate-200'
                              }`}
                            >
                              <Building2 className="w-3 h-3" /> {dept}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-400 mb-3">
                        No Departments found in the Employee Directory yet — Global is the only option.
                      </p>
                    )}

                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {(['casual_leave', 'sick_leave', 'leave_without_pay'] as const).map((field) => (
                        <div key={field}>
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide leading-tight">
                            {field === 'casual_leave' ? 'Casual' : field === 'sick_leave' ? 'Sick' : 'LWP'}
                          </p>
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={bulkDraft[field]}
                            onChange={(e) => setBulkDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                            placeholder="0"
                            className="w-full mt-1 px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={applyBulk}
                      disabled={bulkSaving}
                      className="w-full flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-xl transition-colors"
                    >
                      {bulkSaving ? <Spinner size={16} /> : <Layers className="w-4 h-4" />}
                      {bulkSaving ? 'Applying…' : 'Apply to Selected'}
                    </button>

                    {bulkError && (
                      <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {bulkError}
                      </div>
                    )}
                    {bulkSuccess && (
                      <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {bulkSuccess}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Spinner size={24} className="mb-2" />
              <p className="text-xs">Loading Leave balances...</p>
            </div>
          ) : canManageAll && isNativeApp ? (
            <div className="p-4 space-y-2.5">
              {filtered.map((b) => {
                const isEditing = editingId === b.user_id;
                const isSaving = savingId === b.user_id;
                return (
                  <div
                    key={b.user_id}
                    className={`rounded-xl border overflow-hidden ${
                      isEditing ? 'border-blue-300 bg-blue-50/20' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="p-3.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-slate-900 truncate">{b.user_name}</p>
                        <span
                          className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border shrink-0 ${
                            b.user_role === 'admin'
                              ? 'bg-amber-50 text-amber-800 border-amber-200'
                              : 'bg-blue-50 text-blue-800 border-blue-200'
                          }`}
                        >
                          {b.user_role === 'admin' ? 'Admin' : 'User'}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-3 mt-3">
                        {(['casual_leave', 'sick_leave', 'leave_without_pay'] as const).map((field) => (
                          <div key={field}>
                            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide leading-tight">
                              {field === 'casual_leave' ? 'Casual' : field === 'sick_leave' ? 'Sick' : 'LWP'}
                            </p>
                            {isEditing ? (
                              <input
                                type="number"
                                min={0}
                                step={0.5}
                                value={draft[field]}
                                onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                                className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            ) : (
                              <p className="text-sm text-slate-700 font-medium mt-0.5">{b[field]}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 border-t border-slate-100">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => saveEdit(b.user_id)}
                            disabled={isSaving}
                            className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                          >
                            {isSaving ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
                            {isSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            disabled={isSaving}
                            className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100 border-l border-slate-100 disabled:opacity-50 transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(b)}
                          className="col-span-2 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-blue-600 bg-blue-50/60 hover:bg-blue-50 transition-colors"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-2 py-10 text-center text-xs text-slate-400">No accounts found.</p>
              )}
            </div>
          ) : canManageAll ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3 text-left">Name</th>
                    <th className="px-6 py-3 text-left">Role</th>
                    <th className="px-6 py-3 text-left">Casual Leave</th>
                    <th className="px-6 py-3 text-left">Sick Leave</th>
                    <th className="px-6 py-3 text-left">Leave without Pay</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {filtered.map((b) => {
                    const isEditing = editingId === b.user_id;
                    const isSaving = savingId === b.user_id;
                    return (
                      <tr key={b.user_id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap font-medium text-slate-900 text-xs">
                          {b.user_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                              b.user_role === 'admin'
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : 'bg-blue-50 text-blue-800 border-blue-200'
                            }`}
                          >
                            {b.user_role === 'admin' ? 'Admin' : 'User'}
                          </span>
                        </td>
                        {(['casual_leave', 'sick_leave', 'leave_without_pay'] as const).map((field) => (
                          <td key={field} className="px-6 py-4 whitespace-nowrap text-xs text-slate-700">
                            {isEditing ? (
                              <input
                                type="number"
                                min={0}
                                step={0.5}
                                value={draft[field]}
                                onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                                className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            ) : (
                              b[field]
                            )}
                          </td>
                        ))}
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={cancelEdit}
                                disabled={isSaving}
                                className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => saveEdit(b.user_id)}
                                disabled={isSaving}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                              >
                                {isSaving ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
                                Save
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(b)}
                              className="px-3 py-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800"
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-xs text-slate-400">
                        No accounts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {balances.length === 0 ? (
                <p className="text-xs text-slate-400 sm:col-span-3 text-center py-8">
                  No Leave balance has been set for you yet.
                </p>
              ) : (
                <>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Casual Leave</p>
                    <p className="text-2xl font-bold text-slate-900">{balances[0].casual_leave}</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Sick Leave</p>
                    <p className="text-2xl font-bold text-slate-900">{balances[0].sick_leave}</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Leave without Pay</p>
                    <p className="text-2xl font-bold text-slate-900">{balances[0].leave_without_pay}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};