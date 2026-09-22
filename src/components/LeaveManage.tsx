import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ListChecks, Search, Save, Layers, Building2, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, Plus, X, ShieldCheck, CalendarClock, GitBranch, Trash2, PlayCircle, Power } from 'lucide-react';
import { User, LeaveBalance, LeaveCategoryPolicy, LeaveYearSettings, LeaveBalanceWorkflow } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface LeaveManageProps {
  token: string;
  user: User;
  onBack: () => void;
}

// "Self Service" > "Leave Manage" — reachable only for a Superadmin, or any
// Admin/User the Superadmin has granted can_manage_leave to (Admin Panel ->
// Users -> Module Access -> "Also allow editing Leave balances"); see
// GlobalSidebar.tsx's canManageLeave gate on this menu item. Split out of the
// old combined LeaveManagement.tsx — the plain "view only my own balance"
// case that file used to also handle now lives in its own always-available
// MyLeave.tsx page instead, so this page no longer needs (or renders) that
// branch at all.
export const LeaveManage: React.FC<LeaveManageProps> = ({ token, user, onBack }) => {
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
  // Fixed categories are always present; bulkDraft is otherwise keyed by
  // whatever's in bulkCategories below, so it grows/shrinks as custom
  // categories are added/removed. Kept as Record<string,string> (not the old
  // fixed 3-key shape) so dynamic keys can share the same draft object.
  const [bulkDraft, setBulkDraft] = useState<Record<string, string>>({
    casual_leave: '',
    sick_leave: '',
    leave_without_pay: ''
  });
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [bulkSuccess, setBulkSuccess] = useState('');

  // "Leave Policies" — per Leave Type (Casual/Sick/Leave without Pay + any
  // custom category) advance-notice/Reliever/max-consecutive-days/exhaustion
  // rules, enforced server-side on every Leave Application submission. Only
  // ever shown/usable when canManageAll is true, same as the Bulk panel.
  const [showPoliciesPanel, setShowPoliciesPanel] = useState(false);
  const [policies, setPolicies] = useState<LeaveCategoryPolicy[]>([]);
  const [policyDraft, setPolicyDraft] = useState<Record<string, { min_advance_notice_days: string; reliever_required: boolean; max_consecutive_days: string; require_paid_leave_exhausted: boolean }>>({});
  const [savingPolicyFor, setSavingPolicyFor] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [policySuccess, setPolicySuccess] = useState('');

  const draftFor = (categoryKey: string) =>
    policyDraft[categoryKey] || { min_advance_notice_days: '0', reliever_required: true, max_consecutive_days: '', require_paid_leave_exhausted: false };

  const fetchPolicies = async () => {
    try {
      const res = await fetch(apiUrl('/api/leave-policies'), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave Policies');
      const rows: LeaveCategoryPolicy[] = Array.isArray(data) ? data : [];
      setPolicies(rows);
      setPolicyDraft((prev) => {
        const next = { ...prev };
        for (const p of rows) {
          next[p.category_key] = {
            min_advance_notice_days: String(p.min_advance_notice_days),
            reliever_required: p.reliever_required,
            max_consecutive_days: p.max_consecutive_days === null ? '' : String(p.max_consecutive_days),
            require_paid_leave_exhausted: p.require_paid_leave_exhausted
          };
        }
        return next;
      });
    } catch {
      // Non-fatal — the panel just falls back to its built-in defaults (no
      // restriction, Reliever required) until it can load.
    }
  };

  const savePolicy = async (categoryKey: string) => {
    const draft = draftFor(categoryKey);
    const minAdvanceNoticeDays = Number(draft.min_advance_notice_days);
    if (!Number.isFinite(minAdvanceNoticeDays) || minAdvanceNoticeDays < 0) {
      setPolicySuccess('');
      setPolicyError('Advance Notice (days) must be a non-negative number.');
      return;
    }
    let maxConsecutiveDays: number | null = null;
    if (draft.max_consecutive_days.trim() !== '') {
      maxConsecutiveDays = Number(draft.max_consecutive_days);
      if (!Number.isFinite(maxConsecutiveDays) || maxConsecutiveDays < 1) {
        setPolicySuccess('');
        setPolicyError('Max Consecutive Days must be a positive number, or left blank for no cap.');
        return;
      }
    }
    setSavingPolicyFor(categoryKey);
    setPolicyError('');
    setPolicySuccess('');
    try {
      const res = await fetch(apiUrl(`/api/leave-policies/${encodeURIComponent(categoryKey)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          min_advance_notice_days: minAdvanceNoticeDays,
          reliever_required: draft.reliever_required,
          max_consecutive_days: maxConsecutiveDays,
          require_paid_leave_exhausted: draft.require_paid_leave_exhausted
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save this Leave Policy');
      setPolicies((prev) => [...prev.filter((p) => p.category_key !== categoryKey), data]);
      setPolicySuccess('Policy saved.');
    } catch (err: any) {
      setPolicyError(err.message || 'Failed to save this Leave Policy');
    } finally {
      setSavingPolicyFor(null);
    }
  };

  // "Year Settings" — the recurring HR Leave Year close/start dates
  // (MM-DD, no year — same dates every year) plus whether the next Leave
  // Year should start automatically once the start date arrives. Only ever
  // shown/usable when canManageAll is true, same as every other panel here.
  const [showYearSettingsPanel, setShowYearSettingsPanel] = useState(false);
  const [yearSettings, setYearSettings] = useState<LeaveYearSettings | null>(null);
  const [yearSettingsDraft, setYearSettingsDraft] = useState({ close_month_day: '12-31', start_month_day: '01-01', auto_rollover: false });
  const [savingYearSettings, setSavingYearSettings] = useState(false);
  const [yearSettingsError, setYearSettingsError] = useState('');
  const [yearSettingsSuccess, setYearSettingsSuccess] = useState('');

  // MM-DD helpers — mirrors normalizeMonthDay/dayAfterMonthDay in
  // LeaveRoutes.ts so the Start Date suggestion shown here matches exactly
  // what the server would compute if it were left blank. 2024 is just a
  // leap-year canvas for the <input type="date"> round-trip below; no real
  // year is ever stored.
  const suggestNextDay = (monthDay: string): string => {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(monthDay.trim());
    if (!m) return monthDay;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12) return monthDay;
    const d = new Date(2024, month - 1, day);
    d.setDate(d.getDate() + 1);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const fetchYearSettings = async () => {
    try {
      const res = await fetch(apiUrl('/api/leave-year-settings'), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Year Settings');
      setYearSettings(data);
      setYearSettingsDraft({ close_month_day: data.close_month_day, start_month_day: data.start_month_day, auto_rollover: data.auto_rollover });
    } catch {
      // Non-fatal — the panel just falls back to its built-in defaults
      // (Dec 31 close / Jan 1 start, auto-rollover off) until it can load.
    }
  };

  // Changing the Close Date re-suggests the Start Date, but only when the
  // Start Date still matches the OLD suggestion — an admin who already typed
  // a deliberately different Start Date never gets it silently overwritten.
  const handleCloseDateChange = (value: string) => {
    setYearSettingsDraft((prev) => {
      const prevSuggested = suggestNextDay(prev.close_month_day);
      const nextStart = prev.start_month_day === prevSuggested || !prev.start_month_day ? suggestNextDay(value) : prev.start_month_day;
      return { ...prev, close_month_day: value, start_month_day: nextStart };
    });
  };

  const saveYearSettings = async () => {
    setSavingYearSettings(true);
    setYearSettingsError('');
    setYearSettingsSuccess('');
    try {
      const res = await fetch(apiUrl('/api/leave-year-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(yearSettingsDraft)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save Year Settings');
      setYearSettings(data);
      setYearSettingsDraft({ close_month_day: data.close_month_day, start_month_day: data.start_month_day, auto_rollover: data.auto_rollover });
      setYearSettingsSuccess('Year Settings saved.');
    } catch (err: any) {
      setYearSettingsError(err.message || 'Failed to save Year Settings');
    } finally {
      setSavingYearSettings(false);
    }
  };

  // "Leave Balance Workflows" — General (everyone) plus one workflow per
  // Designation (MD/GM/AGM/DGM/Manager, etc, free text matching the Employee
  // Directory's Designation field), each holding its own per-category annual
  // balance. Applying (by hand here, or automatically at Year Settings'
  // Start Date when auto_rollover is on) sets every matching account's
  // balance the same way "Set Balance in Bulk" above already does.
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [workflows, setWorkflows] = useState<LeaveBalanceWorkflow[]>([]);
  const [workflowDesignationOptions, setWorkflowDesignationOptions] = useState<string[]>([]);
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<number, Record<string, string>>>({});
  const [workflowError, setWorkflowError] = useState('');
  const [workflowSuccess, setWorkflowSuccess] = useState('');
  const [savingWorkflowId, setSavingWorkflowId] = useState<number | null>(null);
  const [applyingWorkflowId, setApplyingWorkflowId] = useState<number | 'all' | null>(null);
  const [deletingWorkflowId, setDeletingWorkflowId] = useState<number | null>(null);
  const [showAddWorkflow, setShowAddWorkflow] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [newWorkflowDesignation, setNewWorkflowDesignation] = useState('');
  const [addingWorkflow, setAddingWorkflow] = useState(false);

  const DESIGNATION_QUICK_PICKS = ['MD', 'GM', 'AGM', 'DGM', 'Manager'];

  const draftsForNewWorkflow = () => Object.fromEntries(bulkCategories.map((c) => [c.key, '']));

  const fetchWorkflows = async () => {
    try {
      const res = await fetch(apiUrl('/api/leave-balance-workflows'), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave Balance Workflows');
      const wfs: LeaveBalanceWorkflow[] = Array.isArray(data.workflows) ? data.workflows : [];
      setWorkflows(wfs);
      setWorkflowDesignationOptions(Array.isArray(data.designations) ? data.designations : []);
      setWorkflowDrafts((prev) => {
        const next = { ...prev };
        for (const wf of wfs) {
          const draft: Record<string, string> = { ...draftsForNewWorkflow(), ...next[wf.id] };
          for (const it of wf.items) draft[it.category_key] = String(it.balance_days);
          next[wf.id] = draft;
        }
        return next;
      });
    } catch {
      // Non-fatal — the panel just shows nothing to edit until it can load.
    }
  };

  const saveWorkflow = async (workflowId: number) => {
    const draft = workflowDrafts[workflowId] || {};
    const items: { category_key: string; balance_days: number }[] = [];
    for (const cat of bulkCategories) {
      const raw = (draft[cat.key] ?? '').trim();
      if (raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        setWorkflowSuccess('');
        setWorkflowError(`"${cat.label}" must be a non-negative number.`);
        return;
      }
      items.push({ category_key: cat.key, balance_days: num });
    }
    setSavingWorkflowId(workflowId);
    setWorkflowError('');
    setWorkflowSuccess('');
    try {
      const res = await fetch(apiUrl(`/api/leave-balance-workflows/${workflowId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save this Workflow');
      setWorkflows((prev) => prev.map((w) => (w.id === workflowId ? { ...w, items: data.items } : w)));
      setWorkflowSuccess('Workflow saved.');
    } catch (err: any) {
      setWorkflowError(err.message || 'Failed to save this Workflow');
    } finally {
      setSavingWorkflowId(null);
    }
  };

  const toggleWorkflowActive = async (wf: LeaveBalanceWorkflow) => {
    setWorkflowError('');
    try {
      const res = await fetch(apiUrl(`/api/leave-balance-workflows/${wf.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: !wf.is_active })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update this Workflow');
      setWorkflows((prev) => prev.map((w) => (w.id === wf.id ? { ...w, is_active: data.is_active } : w)));
    } catch (err: any) {
      setWorkflowError(err.message || 'Failed to update this Workflow');
    }
  };

  const addWorkflow = async () => {
    const name = newWorkflowName.trim();
    const designation = newWorkflowDesignation.trim();
    if (!name || !designation) {
      setWorkflowSuccess('');
      setWorkflowError('Workflow name and Designation are both required.');
      return;
    }
    setAddingWorkflow(true);
    setWorkflowError('');
    setWorkflowSuccess('');
    try {
      const res = await fetch(apiUrl('/api/leave-balance-workflows'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, designation })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create this Workflow');
      const newWf: LeaveBalanceWorkflow = { id: data.id, name: data.name, scope_type: 'designation', designation: data.designation, is_active: true, items: [] };
      setWorkflows((prev) => [...prev, newWf]);
      setWorkflowDrafts((prev) => ({ ...prev, [data.id]: draftsForNewWorkflow() }));
      setNewWorkflowName('');
      setNewWorkflowDesignation('');
      setShowAddWorkflow(false);
    } catch (err: any) {
      setWorkflowError(err.message || 'Failed to create this Workflow');
    } finally {
      setAddingWorkflow(false);
    }
  };

  const deleteWorkflow = async (workflowId: number) => {
    if (!window.confirm('Delete this Leave Balance Workflow? This cannot be undone.')) return;
    setDeletingWorkflowId(workflowId);
    setWorkflowError('');
    try {
      const res = await fetch(apiUrl(`/api/leave-balance-workflows/${workflowId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete this Workflow');
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId));
    } catch (err: any) {
      setWorkflowError(err.message || 'Failed to delete this Workflow');
    } finally {
      setDeletingWorkflowId(null);
    }
  };

  const applyWorkflow = async (workflowId: number | null) => {
    setApplyingWorkflowId(workflowId ?? 'all');
    setWorkflowError('');
    setWorkflowSuccess('');
    try {
      const res = await fetch(apiUrl('/api/leave-balance-workflows/apply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(workflowId ? { workflow_id: workflowId } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply');
      setWorkflowSuccess(`Applied to ${data.updated_count} account${data.updated_count === 1 ? '' : 's'}.`);
      await fetchBalances();
    } catch (err: any) {
      setWorkflowError(err.message || 'Failed to apply');
    } finally {
      setApplyingWorkflowId(null);
    }
  };

  // Custom Leave Categories — Leave Manager can define extra categories on
  // the fly (e.g. "Maternity Leave", "Earned Leave") right from the bulk
  // panel, beyond the fixed Casual/Sick/LWP set. Persisted via
  // GET/POST /api/leave-categories (shared across every Leave Manager, not
  // just this session) and applied per-account through the bulk PUT's
  // `custom_categories` map, keyed by category `key` — see applyBulk below.
  const [customCategories, setCustomCategories] = useState<{ key: string; label: string }[]>([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);

  const BUILTIN_CATEGORIES: { key: string; label: string }[] = [
    { key: 'casual_leave', label: 'Casual Leave' },
    { key: 'sick_leave', label: 'Sick Leave' },
    { key: 'leave_without_pay', label: 'Leave without Pay' }
  ];
  // What the bulk panel actually renders — fixed categories first, then
  // whatever custom ones exist (fetched) or were just added this session.
  const bulkCategories = [...BUILTIN_CATEGORIES, ...customCategories];

  const FIXED_LEAVE_TYPES: { key: string; label: string }[] = [
    { key: 'casual', label: 'Casual Leave' },
    { key: 'sick', label: 'Sick Leave' },
    { key: 'without_pay', label: 'Leave Without Pay' }
  ];
  // Custom category keys here already match leave_applications.leave_type
  // exactly (unlike BUILTIN_CATEGORIES/bulkCategories above, which use the
  // separate 'casual_leave'/'sick_leave'/'leave_without_pay' balance-column
  // naming) — see NewLeaveApplicationModal's leaveTypeOptions for the same
  // fixed-3-plus-custom-categories pattern this mirrors.
  const policyCategories = [...FIXED_LEAVE_TYPES, ...customCategories];

  const fetchCategories = async () => {
    try {
      const res = await fetch(apiUrl('/api/leave-categories'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave categories');
      const cats = Array.isArray(data) ? data.map((c: any) => ({ key: c.key, label: c.label })) : [];
      setCustomCategories(cats);
      setBulkDraft((prev) => {
        const next = { ...prev };
        for (const c of cats) if (!(c.key in next)) next[c.key] = '';
        return next;
      });
    } catch {
      // Non-fatal — the bulk panel still works with just the fixed 3
      // categories, and "Add Category" can still create new ones.
    }
  };

  const addCustomCategory = async () => {
    const label = newCategoryLabel.trim();
    if (!label) return;
    if (bulkCategories.some((c) => c.label.toLowerCase() === label.toLowerCase())) {
      setBulkError('This category already exists.');
      return;
    }
    setAddingCategory(true);
    setBulkError('');
    try {
      const res = await fetch(apiUrl('/api/leave-categories'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add category');
      if (!bulkCategories.some((c) => c.key === data.key)) {
        setCustomCategories((prev) => [...prev, { key: data.key, label: data.label }]);
      }
      setBulkDraft((prev) => ({ ...prev, [data.key]: prev[data.key] ?? '' }));
      setNewCategoryLabel('');
      setShowAddCategory(false);
    } catch (err: any) {
      setBulkError(err.message || 'Failed to add category');
    } finally {
      setAddingCategory(false);
    }
  };

  // Removes a category from THIS bulk panel's view only (so it's not applied
  // this time) — the category itself stays defined server-side for every
  // Leave Manager, since Add Category has no separate delete endpoint.
  const removeCustomCategory = (key: string) => {
    setCustomCategories((prev) => prev.filter((c) => c.key !== key));
    setBulkDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

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
    if (canManageAll) {
      fetchCategories();
      fetchPolicies();
      fetchYearSettings();
      fetchWorkflows();
    }
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
      // Server adjusts down for leave already taken this year, so reflect
      // its returned values, not the raw numbers typed in.
      setBalances((prev) =>
        prev.map((b) =>
          b.user_id === userId
            ? { ...b, casual_leave: data.casual_leave, sick_leave: data.sick_leave, leave_without_pay: data.leave_without_pay }
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
    // Only categories the admin actually typed a value for get applied —
    // this lets e.g. just "Maternity Leave" be bulk-set without being forced
    // to also re-enter Casual/Sick/LWP for accounts that shouldn't change.
    const fixedValues: { casual_leave?: number; sick_leave?: number; leave_without_pay?: number } = {};
    const customValues: Record<string, number> = {};
    for (const cat of bulkCategories) {
      const raw = (bulkDraft[cat.key] ?? '').trim();
      if (raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        setBulkSuccess('');
        setBulkError(`"${cat.label}" must be a non-negative number.`);
        return;
      }
      if (cat.key === 'casual_leave' || cat.key === 'sick_leave' || cat.key === 'leave_without_pay') {
        fixedValues[cat.key] = num;
      } else {
        customValues[cat.key] = num;
      }
    }
    if (Object.keys(fixedValues).length === 0 && Object.keys(customValues).length === 0) {
      setBulkSuccess('');
      setBulkError('Enter at least one leave balance to apply.');
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
          ...fixedValues,
          // Dynamic/custom categories, keyed by category `key` (the same
          // slug GET/POST /api/leave-categories uses) and stored in the
          // separate leave_categories/leave_category_balances tables since
          // there are no fixed columns for them.
          custom_categories: customValues
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update balances');
      setBulkSuccess(`Updated ${data.updated_count} account${data.updated_count === 1 ? '' : 's'}.`);
      setBulkDraft((prev) => {
        const cleared: Record<string, string> = {};
        Object.keys(prev).forEach((k) => (cleared[k] = ''));
        return cleared;
      });
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
            <ModulePath path={['Self Service', 'Leave Manage']} />
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
                <h1 className="text-lg font-semibold text-slate-800">Leave Manage</h1>
                <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                  Set the Casual Leave, Sick Leave and Leave without Pay balance for every account.
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
                    {bulkCategories.map((cat) => (
                      <div key={cat.key} className="relative">
                        <label className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 mb-1">
                          {cat.label}
                          {cat.key.startsWith('custom_') && (
                            <button
                              type="button"
                              onClick={() => removeCustomCategory(cat.key)}
                              title="Remove this category"
                              className="text-slate-300 hover:text-rose-500 transition-colors"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={bulkDraft[cat.key] ?? ''}
                          onChange={(e) => setBulkDraft((prev) => ({ ...prev, [cat.key]: e.target.value }))}
                          placeholder="0"
                          className="w-28 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}

                    {showAddCategory ? (
                      <div className="flex items-end gap-1.5">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">Category name</label>
                          <input
                            type="text"
                            autoFocus
                            disabled={addingCategory}
                            value={newCategoryLabel}
                            onChange={(e) => setNewCategoryLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') addCustomCategory();
                              if (e.key === 'Escape') {
                                setShowAddCategory(false);
                                setNewCategoryLabel('');
                              }
                            }}
                            placeholder="e.g. Maternity Leave"
                            className="w-40 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={addCustomCategory}
                          disabled={addingCategory}
                          className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50"
                        >
                          {addingCategory && <Spinner size={12} />}
                          {addingCategory ? 'Adding…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddCategory(false);
                            setNewCategoryLabel('');
                          }}
                          className="px-2.5 py-2 text-slate-400 hover:text-slate-600 text-xs"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAddCategory(true)}
                        className="flex items-center gap-1 px-3 py-2 text-xs font-semibold text-blue-600 border border-dashed border-blue-300 rounded-xl hover:bg-blue-50 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Category
                      </button>
                    )}

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

                    <div className="grid grid-cols-2 gap-2 mb-3">
                      {bulkCategories.map((cat) => (
                        <div key={cat.key} className="relative">
                          <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide leading-tight truncate">
                            {cat.label}
                            {cat.key.startsWith('custom_') && (
                              <button
                                type="button"
                                onClick={() => removeCustomCategory(cat.key)}
                                className="text-slate-300 shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </p>
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={bulkDraft[cat.key] ?? ''}
                            onChange={(e) => setBulkDraft((prev) => ({ ...prev, [cat.key]: e.target.value }))}
                            placeholder="0"
                            className="w-full mt-1 px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      ))}
                    </div>

                    {showAddCategory ? (
                      <div className="flex items-center gap-1.5 mb-3">
                        <input
                          type="text"
                          autoFocus
                          disabled={addingCategory}
                          value={newCategoryLabel}
                          onChange={(e) => setNewCategoryLabel(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') addCustomCategory();
                            if (e.key === 'Escape') {
                              setShowAddCategory(false);
                              setNewCategoryLabel('');
                            }
                          }}
                          placeholder="e.g. Maternity Leave"
                          className="flex-1 px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={addCustomCategory}
                          disabled={addingCategory}
                          className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50"
                        >
                          {addingCategory && <Spinner size={12} />}
                          {addingCategory ? 'Adding…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddCategory(false);
                            setNewCategoryLabel('');
                          }}
                          className="p-2 text-slate-400 shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAddCategory(true)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 mb-3 text-xs font-semibold text-blue-600 border border-dashed border-blue-300 rounded-lg"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Category
                      </button>
                    )}

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

          {canManageAll && (
            <div className="border-b border-slate-200 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowPoliciesPanel((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-6 py-3 text-left hover:bg-slate-100/70 transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <ShieldCheck className="w-3.5 h-3.5 text-blue-600" /> Leave Policies
                </span>
                {showPoliciesPanel ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {showPoliciesPanel && (
                <div className="px-6 pb-5">
                  <p className="text-[11px] text-slate-500 mb-3 max-w-2xl">
                    Set the rules for each Leave Type — how many days ahead it must be applied, whether a Reliever is
                    required, the longest single application allowed, and (for a type like Leave Without Pay) whether
                    Casual/Sick must be exhausted first. Enforced automatically when anyone submits a Leave Application.
                  </p>

                  <div className="space-y-3">
                    {policyCategories.map((cat) => {
                      const draft = draftFor(cat.key);
                      const isSaving = savingPolicyFor === cat.key;
                      return (
                        <div key={cat.key} className="rounded-xl border border-slate-200 bg-white p-3.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
                            <span className="text-xs font-bold text-slate-800">{cat.label}</span>
                            <button
                              type="button"
                              onClick={() => savePolicy(cat.key)}
                              disabled={isSaving}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors"
                            >
                              {isSaving ? <Spinner size={12} className="text-white" /> : <Save className="w-3 h-3" />}
                              Save
                            </button>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            <div>
                              <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                                Advance Notice (days)
                              </label>
                              <input
                                type="number"
                                min={0}
                                value={draft.min_advance_notice_days}
                                onChange={(e) =>
                                  setPolicyDraft((prev) => ({ ...prev, [cat.key]: { ...draftFor(cat.key), min_advance_notice_days: e.target.value } }))
                                }
                                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-[10px] text-slate-400 mt-0.5">0 = same-day apply allowed</p>
                            </div>

                            <div>
                              <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                                Max Consecutive Days
                              </label>
                              <input
                                type="number"
                                min={1}
                                placeholder="No cap"
                                value={draft.max_consecutive_days}
                                onChange={(e) =>
                                  setPolicyDraft((prev) => ({ ...prev, [cat.key]: { ...draftFor(cat.key), max_consecutive_days: e.target.value } }))
                                }
                                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-[10px] text-slate-400 mt-0.5">Blank = no cap</p>
                            </div>

                            <label className="flex items-center gap-2 text-xs text-slate-700 mt-1 sm:mt-5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={draft.reliever_required}
                                onChange={(e) =>
                                  setPolicyDraft((prev) => ({ ...prev, [cat.key]: { ...draftFor(cat.key), reliever_required: e.target.checked } }))
                                }
                                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              />
                              Reliever required
                            </label>

                            <label className="flex items-center gap-2 text-xs text-slate-700 mt-1 sm:mt-5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={draft.require_paid_leave_exhausted}
                                onChange={(e) =>
                                  setPolicyDraft((prev) => ({ ...prev, [cat.key]: { ...draftFor(cat.key), require_paid_leave_exhausted: e.target.checked } }))
                                }
                                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              />
                              Only after Casual + Sick exhausted
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {policyError && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {policyError}
                    </div>
                  )}
                  {policySuccess && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {policySuccess}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {canManageAll && (
            <div className="border-b border-slate-200 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowYearSettingsPanel((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-6 py-3 text-left hover:bg-slate-100/70 transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <CalendarClock className="w-3.5 h-3.5 text-blue-600" /> Year Settings
                </span>
                {showYearSettingsPanel ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {showYearSettingsPanel && (
                <div className="px-6 pb-5">
                  <p className="text-[11px] text-slate-500 mb-3 max-w-2xl">
                    When the HR Leave Year closes and the next one starts. Start Date is suggested as the day right after
                    Close Date, but can be changed. Tick "Start next year automatically" to have every active Leave
                    Balance Workflow below applied on its own once the Start Date arrives each year — leave it unticked to
                    trigger that by hand instead, from "Apply Now" in Leave Balance Workflows.
                  </p>

                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Year Close Date</label>
                      <input
                        type="date"
                        value={`2024-${yearSettingsDraft.close_month_day}`}
                        onChange={(e) => {
                          const parts = e.target.value.split('-');
                          if (parts.length === 3) handleCloseDateChange(`${parts[1]}-${parts[2]}`);
                        }}
                        className="w-40 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Year Start Date (suggested)</label>
                      <input
                        type="date"
                        value={`2024-${yearSettingsDraft.start_month_day}`}
                        onChange={(e) => {
                          const parts = e.target.value.split('-');
                          if (parts.length === 3) setYearSettingsDraft((prev) => ({ ...prev, start_month_day: `${parts[1]}-${parts[2]}` }));
                        }}
                        className="w-40 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-slate-700 mb-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={yearSettingsDraft.auto_rollover}
                        onChange={(e) => setYearSettingsDraft((prev) => ({ ...prev, auto_rollover: e.target.checked }))}
                        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      Start next year automatically
                    </label>

                    <button
                      type="button"
                      onClick={saveYearSettings}
                      disabled={savingYearSettings}
                      className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50 mb-0.5"
                    >
                      {savingYearSettings ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
                      {savingYearSettings ? 'Saving…' : 'Save'}
                    </button>
                  </div>

                  {yearSettings?.last_rollover_year && (
                    <p className="text-[11px] text-slate-400 mt-2">
                      Leave Year last auto-started for {yearSettings.last_rollover_year}.
                    </p>
                  )}

                  {yearSettingsError && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {yearSettingsError}
                    </div>
                  )}
                  {yearSettingsSuccess && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {yearSettingsSuccess}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {canManageAll && (
            <div className="border-b border-slate-200 bg-slate-50/60">
              <button
                type="button"
                onClick={() => setShowWorkflowsPanel((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-6 py-3 text-left hover:bg-slate-100/70 transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <GitBranch className="w-3.5 h-3.5 text-blue-600" /> Leave Balance Workflows
                </span>
                {showWorkflowsPanel ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {showWorkflowsPanel && (
                <div className="px-6 pb-5">
                  <p className="text-[11px] text-slate-500 mb-3 max-w-2xl">
                    Dynamic, Designation-wise annual leave balances. "General" applies to every account; a Designation
                    workflow (e.g. Manager, GM) overrides General's balance for just its own categories, for just accounts
                    with that Designation (from the Employee Directory). Apply Now sets balances right away, same as Set
                    Balance in Bulk above.
                  </p>

                  <div className="space-y-3">
                    {workflows.map((wf) => {
                      const draft = workflowDrafts[wf.id] || {};
                      const isSaving = savingWorkflowId === wf.id;
                      const isApplying = applyingWorkflowId === wf.id;
                      const isDeleting = deletingWorkflowId === wf.id;
                      return (
                        <div
                          key={wf.id}
                          className={`rounded-xl border p-3.5 ${wf.is_active ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50/60 opacity-70'}`}
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">{wf.name}</span>
                              {wf.scope_type === 'designation' && (
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  {wf.designation}
                                </span>
                              )}
                              {wf.scope_type === 'general' && (
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                                  Everyone
                                </span>
                              )}
                              {!wf.is_active && (
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                                  Inactive
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleWorkflowActive(wf)}
                                title={wf.is_active ? 'Deactivate' : 'Activate'}
                                className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                                  wf.is_active ? 'text-slate-500 border-slate-200 hover:bg-slate-100' : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                                }`}
                              >
                                <Power className="w-3 h-3" /> {wf.is_active ? 'Deactivate' : 'Activate'}
                              </button>
                              <button
                                type="button"
                                onClick={() => saveWorkflow(wf.id)}
                                disabled={isSaving}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors"
                              >
                                {isSaving ? <Spinner size={12} className="text-white" /> : <Save className="w-3 h-3" />}
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => applyWorkflow(wf.id)}
                                disabled={isApplying || !wf.is_active}
                                title={!wf.is_active ? 'Activate this workflow first' : 'Apply this workflow now'}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors"
                              >
                                {isApplying ? <Spinner size={12} className="text-white" /> : <PlayCircle className="w-3 h-3" />}
                                Apply Now
                              </button>
                              {wf.scope_type === 'designation' && (
                                <button
                                  type="button"
                                  onClick={() => deleteWorkflow(wf.id)}
                                  disabled={isDeleting}
                                  title="Delete this Workflow"
                                  className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg text-rose-600 border border-rose-200 hover:bg-rose-50 disabled:opacity-50 transition-colors"
                                >
                                  {isDeleting ? <Spinner size={12} /> : <Trash2 className="w-3 h-3" />}
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-3">
                            {bulkCategories.map((cat) => (
                              <div key={cat.key}>
                                <label className="block text-[10px] font-semibold text-slate-500 mb-1">{cat.label}</label>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.5}
                                  value={draft[cat.key] ?? ''}
                                  onChange={(e) =>
                                    setWorkflowDrafts((prev) => ({ ...prev, [wf.id]: { ...prev[wf.id], [cat.key]: e.target.value } }))
                                  }
                                  placeholder="0"
                                  className="w-24 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {showAddWorkflow ? (
                    <div className="mt-3 rounded-xl border border-dashed border-blue-300 p-3.5">
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">Workflow name</label>
                          <input
                            type="text"
                            autoFocus
                            disabled={addingWorkflow}
                            value={newWorkflowName}
                            onChange={(e) => setNewWorkflowName(e.target.value)}
                            placeholder="e.g. Manager Leave Policy"
                            className="w-48 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">Designation</label>
                          <input
                            type="text"
                            list="leave-workflow-designation-options"
                            disabled={addingWorkflow}
                            value={newWorkflowDesignation}
                            onChange={(e) => setNewWorkflowDesignation(e.target.value)}
                            placeholder="e.g. Manager"
                            className="w-40 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <datalist id="leave-workflow-designation-options">
                            {workflowDesignationOptions.map((d) => (
                              <option key={d} value={d} />
                            ))}
                          </datalist>
                        </div>
                        <button
                          type="button"
                          onClick={addWorkflow}
                          disabled={addingWorkflow}
                          className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50"
                        >
                          {addingWorkflow && <Spinner size={12} />}
                          {addingWorkflow ? 'Adding…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddWorkflow(false);
                            setNewWorkflowName('');
                            setNewWorkflowDesignation('');
                          }}
                          className="px-2.5 py-2 text-slate-400 hover:text-slate-600 text-xs"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {DESIGNATION_QUICK_PICKS.map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => {
                              setNewWorkflowDesignation(d);
                              if (!newWorkflowName.trim()) setNewWorkflowName(`${d} Leave Policy`);
                            }}
                            className="text-[10px] font-semibold px-2 py-1 rounded-full border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 transition-colors"
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowAddWorkflow(true)}
                      className="mt-3 flex items-center gap-1 px-3 py-2 text-xs font-semibold text-blue-600 border border-dashed border-blue-300 rounded-xl hover:bg-blue-50 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Designation Workflow
                    </button>
                  )}

                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => applyWorkflow(null)}
                      disabled={applyingWorkflowId === 'all'}
                      className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50"
                    >
                      {applyingWorkflowId === 'all' ? <Spinner size={14} /> : <PlayCircle className="w-3.5 h-3.5" />}
                      {applyingWorkflowId === 'all' ? 'Applying…' : 'Apply All Active Workflows Now'}
                    </button>
                  </div>

                  {workflowError && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {workflowError}
                    </div>
                  )}
                  {workflowSuccess && (
                    <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {workflowSuccess}
                    </div>
                  )}
                </div>
              )}
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

                      {/* Custom Leave Categories a Leave Manager added via
                          "Set Balance in Bulk" -> Add Category. GET
                          /api/leave-balances already returns these per-user
                          under custom_leaves — shown here read-only (Set
                          Balance in Bulk is the only place that writes them
                          today, same as the fixed three used to be before
                          per-row Edit existed). */}
                      {!!b.custom_leaves?.length && (
                        <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-100">
                          {b.custom_leaves.map((c) => (
                            <div key={c.key}>
                              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide leading-tight truncate" title={c.label}>
                                {c.label}
                              </p>
                              <p className="text-sm text-slate-700 font-medium mt-0.5">{c.balance}</p>
                            </div>
                          ))}
                        </div>
                      )}
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
                    {/* One column per custom Leave Category defined so far
                        (fetchCategories -> customCategories) — same list the
                        bulk panel's "Add Category" grows, so a brand-new
                        category shows up as a column here immediately, even
                        for accounts that don't have a balance row for it yet
                        (falls back to 0 below). Read-only here — Set Balance
                        in Bulk is still the only way to write these. */}
                    {customCategories.map((cat) => (
                      <th key={cat.key} className="px-6 py-3 text-left">{cat.label}</th>
                    ))}
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
                        {customCategories.map((cat) => {
                          const bal = b.custom_leaves?.find((c) => c.key === cat.key)?.balance ?? 0;
                          return (
                            <td key={cat.key} className="px-6 py-4 whitespace-nowrap text-xs text-slate-700">
                              {bal}
                            </td>
                          );
                        })}
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
                      <td colSpan={6 + customCategories.length} className="px-6 py-10 text-center text-xs text-slate-400">
                        No accounts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            // canManageAll is false — shouldn't normally be reachable since
            // GlobalSidebar only shows the "Leave Manage" menu item to
            // canManageAll accounts (see the gate there), but a permission
            // revoked mid-session (or a stale nav request) could still land
            // here, so show this instead of silently rendering nothing.
            <p className="p-10 text-center text-xs text-slate-400">
              You don't have access to manage Leave balances.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};