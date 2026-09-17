/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Clock, Plus, Trash2, Save } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { DeliveryDateCondition, DeliveryConditionType, Project, Budget } from '../types';
import { Spinner } from './Spinner';

interface DeliveryDateConditionsPanelProps {
  token: string;
}

interface GlobalFormState {
  enabled: boolean;
  min_lead_days: string;
  apply_to_admins: boolean;
}

const emptyGlobalForm: GlobalFormState = { enabled: false, min_lead_days: '0', apply_to_admins: false };

interface OverrideFormState {
  scope: 'project' | 'budget';
  scope_id: string;
  min_lead_days: string;
  apply_to_admins: boolean;
}

const emptyOverrideForm: OverrideFormState = { scope: 'project', scope_id: '', min_lead_days: '0', apply_to_admins: false };

// One condition_type's worth of UI (Global settings + Project/Budget override
// list) — rendered twice below, once for 'entry' and once for 'job_edit',
// since Condition Set's two rule sets are fully independent of each other.
const ConditionTypeSection: React.FC<{
  token: string;
  conditionType: DeliveryConditionType;
  title: string;
  description: string;
  rows: DeliveryDateCondition[];
  projects: Project[];
  budgets: Budget[];
  onChanged: () => void;
}> = ({ token, conditionType, title, description, rows, projects, budgets, onChanged }) => {
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const globalRow = rows.find((r) => r.scope === 'global');
  const overrideRows = rows.filter((r) => r.scope !== 'global');

  const [globalForm, setGlobalForm] = useState<GlobalFormState>(emptyGlobalForm);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [globalError, setGlobalError] = useState('');

  useEffect(() => {
    if (globalRow) {
      setGlobalForm({
        enabled: !!globalRow.enabled,
        min_lead_days: String(globalRow.min_lead_days),
        apply_to_admins: !!globalRow.apply_to_admins
      });
    }
  }, [globalRow?.enabled, globalRow?.min_lead_days, globalRow?.apply_to_admins]);

  const saveGlobal = async () => {
    const days = Number(globalForm.min_lead_days);
    if (!Number.isInteger(days) || days < 0) {
      setGlobalError('Enter a whole number of days (0 or more).');
      return;
    }
    setSavingGlobal(true);
    setGlobalError('');
    try {
      const res = await fetch(apiUrl('/api/delivery-date-conditions/global'), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          condition_type: conditionType,
          enabled: globalForm.enabled,
          min_lead_days: days,
          apply_to_admins: globalForm.apply_to_admins
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      onChanged();
    } catch (err: any) {
      setGlobalError(err.message || 'Failed to save');
    } finally {
      setSavingGlobal(false);
    }
  };

  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideForm, setOverrideForm] = useState<OverrideFormState>(emptyOverrideForm);
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const saveOverride = async () => {
    if (!overrideForm.scope_id) {
      setOverrideError(`Select a ${overrideForm.scope === 'project' ? 'Project' : 'Budget'}.`);
      return;
    }
    const days = Number(overrideForm.min_lead_days);
    if (!Number.isInteger(days) || days < 0) {
      setOverrideError('Enter a whole number of days (0 or more).');
      return;
    }
    setSavingOverride(true);
    setOverrideError('');
    try {
      const res = await fetch(apiUrl('/api/delivery-date-conditions/override'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          condition_type: conditionType,
          scope: overrideForm.scope,
          scope_id: Number(overrideForm.scope_id),
          min_lead_days: days,
          apply_to_admins: overrideForm.apply_to_admins,
          enabled: true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setShowOverrideForm(false);
      setOverrideForm(emptyOverrideForm);
      onChanged();
    } catch (err: any) {
      setOverrideError(err.message || 'Failed to save');
    } finally {
      setSavingOverride(false);
    }
  };

  const deleteOverride = async (row: DeliveryDateCondition) => {
    if (!window.confirm(`Remove this ${row.scope === 'project' ? 'Project' : 'Budget'} override? It will fall back to the Global setting above.`)) return;
    setDeletingId(row.id);
    try {
      const res = await fetch(apiUrl(`/api/delivery-date-conditions/${row.id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to remove');
      onChanged();
    } catch {
      // best-effort — the list simply won't refresh; the row stays visible so the
      // admin can retry rather than losing track of it silently.
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-5">
      <div>
        <h4 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-600" /> {title}
        </h4>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">{description}</p>
      </div>

      {/* Global */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={globalForm.enabled}
            onChange={(e) => setGlobalForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          Enable Global condition
        </label>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Minimum days notice</label>
          <input
            type="text"
            inputMode="numeric"
            value={globalForm.min_lead_days}
            onChange={(e) => setGlobalForm((f) => ({ ...f, min_lead_days: e.target.value.replace(/\D/g, '') }))}
            className="w-24 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={globalForm.apply_to_admins}
            onChange={(e) => setGlobalForm((f) => ({ ...f, apply_to_admins: e.target.checked }))}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          Also apply to Admin/Superadmin
        </label>
        <button
          type="button"
          onClick={saveGlobal}
          disabled={savingGlobal}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {savingGlobal && <Spinner size={12} />} <Save className="w-3.5 h-3.5" /> Save
        </button>
        {globalError && <p className="w-full text-xs text-rose-600">{globalError}</p>}
      </div>

      {/* Overrides */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Project / Budget overrides</p>
          {!showOverrideForm && (
            <button
              type="button"
              onClick={() => { setShowOverrideForm(true); setOverrideForm(emptyOverrideForm); setOverrideError(''); }}
              className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
            >
              <Plus className="w-3.5 h-3.5" /> Add override
            </button>
          )}
        </div>

        {showOverrideForm && (
          <div className="border border-blue-200 bg-blue-50/50 rounded-xl p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-end gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Applies to</label>
                <select
                  value={overrideForm.scope}
                  onChange={(e) => setOverrideForm((f) => ({ ...f, scope: e.target.value as 'project' | 'budget', scope_id: '' }))}
                  className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none"
                >
                  <option value="project">Project</option>
                  <option value="budget">Budget</option>
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-[11px] text-slate-500 mb-1">
                  {overrideForm.scope === 'project' ? 'Project' : 'Budget'}
                </label>
                <select
                  value={overrideForm.scope_id}
                  onChange={(e) => setOverrideForm((f) => ({ ...f, scope_id: e.target.value }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none"
                >
                  <option value="">Select…</option>
                  {overrideForm.scope === 'project'
                    ? projects.map((p) => <option key={p.id} value={p.id}>{p.project_name}</option>)
                    : budgets.map((b) => <option key={b.id} value={b.id}>{b.budget_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Minimum days notice</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={overrideForm.min_lead_days}
                  onChange={(e) => setOverrideForm((f) => ({ ...f, min_lead_days: e.target.value.replace(/\D/g, '') }))}
                  className="w-24 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 pb-1.5">
                <input
                  type="checkbox"
                  checked={overrideForm.apply_to_admins}
                  onChange={(e) => setOverrideForm((f) => ({ ...f, apply_to_admins: e.target.checked }))}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Also apply to Admin/Superadmin
              </label>
            </div>
            {overrideError && <p className="text-xs text-rose-600">{overrideError}</p>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveOverride}
                disabled={savingOverride}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {savingOverride && <Spinner size={12} />} Save override
              </button>
              <button
                type="button"
                onClick={() => setShowOverrideForm(false)}
                disabled={savingOverride}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {overrideRows.length === 0 ? (
          <p className="text-xs text-slate-400">No Project/Budget overrides — the Global setting above applies everywhere.</p>
        ) : (
          <div className="space-y-1.5">
            {overrideRows.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-2 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-slate-800">
                    {row.scope === 'project' ? 'Project' : 'Budget'}: {row.scope_name || `#${row.scope_id}`}
                  </span>
                  <span className="text-slate-400 ml-2">
                    {row.enabled ? `${row.min_lead_days} day(s) notice` : 'disabled'}
                    {!!row.apply_to_admins && ' · applies to Admins'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => deleteOverride(row)}
                  disabled={deletingId === row.id}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 shrink-0"
                  title="Remove override"
                >
                  {deletingId === row.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Admin Panel -> PEPM Manage -> Data Import -> "Condition Set". Lets an Admin
// require a minimum number of days' notice before a Delivery Date can be
// picked/changed — independently for "New Job Entry / Add MPR" (condition_type
// 'entry') and "changing an existing entry's Delivery Date" (condition_type
// 'job_edit') — each with one Global setting plus optional per-Project/
// per-Budget overrides. See deliveryDateConditions.ts for the resolver this
// drives, and EntriesRoutes.ts for where it's actually enforced.
export const DeliveryDateConditionsPanel: React.FC<DeliveryDateConditionsPanelProps> = ({ token }) => {
  const [rows, setRows] = useState<DeliveryDateCondition[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    try {
      const [condRes, projRes, budgRes] = await Promise.all([
        fetch(apiUrl('/api/delivery-date-conditions'), { headers: authHeaders }),
        fetch(apiUrl('/api/projects'), { headers: authHeaders }),
        fetch(apiUrl('/api/budgets'), { headers: authHeaders })
      ]);
      if (condRes.ok) setRows(await condRes.json());
      if (projRes.ok) setProjects(await projRes.json());
      if (budgRes.ok) setBudgets(await budgRes.json());
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-900">Condition Set</h3>
        <p className="text-xs text-slate-500 mt-1">
          Require a minimum number of days' notice before a Delivery Date can be picked or changed — prevents, for
          example, someone editing today with a delivery date set for tomorrow. Entry and Job Edit each have their own
          independent setting.
        </p>
      </div>
      <ConditionTypeSection
        token={token}
        conditionType="entry"
        title="New Job Entry / Add MPR"
        description="Applies when a Delivery Date is first set — New Job Entry and Add MPR to an existing Job."
        rows={rows.filter((r) => r.condition_type === 'entry')}
        projects={projects}
        budgets={budgets}
        onChanged={fetchAll}
      />
      <ConditionTypeSection
        token={token}
        conditionType="job_edit"
        title="Job Edit (changing an existing Delivery Date)"
        description="Applies when an already-saved entry's Delivery Date is being changed — Job Edit / Job Entry Details."
        rows={rows.filter((r) => r.condition_type === 'job_edit')}
        projects={projects}
        budgets={budgets}
        onChanged={fetchAll}
      />
    </div>
  );
};

export default DeliveryDateConditionsPanel;
