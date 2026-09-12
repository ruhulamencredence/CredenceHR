/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Salary Setup — "বেতন কাঠামো সেটআপ".
//
// Two sub-panels sharing one tab, backed by PayrollRoutes.ts's
// salary_components / pay_grades / pay_grade_components tables:
//   * Salary Components — the reusable catalogue of Earning line items
//     (Basic, House Rent, Conveyance, Medical, Special Allowance...) and
//     Deduction line items (Provident Fund, Tax, Advance Salary,
//     Fine/Penalty...) that a Pay Grade is built from.
//   * Pay Grades — "Grade 1", "Grade 2"... each with a Basic Salary plus a
//     chosen amount for any of the components above. "Assign to Employee"
//     turns a grade into that employee's actual Salary Structure.
//
// Same visual language as PayrollListPanel.tsx (card shell, filter bar,
// table styling) so this drops into the existing Payroll module untouched.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Settings2,
  LayoutGrid,
  Plus,
  Pencil,
  Trash2,
  X,
  UserPlus,
  User,
  Search,
  ChevronDown,
  TrendingUp,
  TrendingDown,
  RefreshCw
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface SalaryStructureSetupPanelProps {
  token: string;
}

interface SalaryComponent {
  id: number;
  name: string;
  component_type: 'earning' | 'deduction';
  description: string | null;
  is_active: 0 | 1;
}

interface GradeComponent {
  id: number;
  component_id: number;
  amount: number;
  name: string;
  component_type: 'earning' | 'deduction';
}

interface PayGrade {
  id: number;
  grade_name: string;
  grade_code: string | null;
  basic_salary: number;
  description: string | null;
  is_active: 0 | 1;
  components: GradeComponent[];
  gross_salary: number;
  total_deductions: number;
}

interface PayrollEmployeeLite {
  id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  designation: string | null;
}

interface SalaryStructureRow {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  designation: string | null;
  basic_salary: number;
  house_rent: number;
  medical_allowance: number;
  conveyance_allowance: number;
  other_allowance: number;
  gross_salary: number;
  tax_deduction: number;
  pf_deduction: number;
  effective_date: string;
}

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const SalaryStructureSetupPanel: React.FC<SalaryStructureSetupPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [subTab, setSubTab] = useState<'components' | 'grades' | 'individual'>('components');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 w-fit">
        <button
          onClick={() => setSubTab('components')}
          className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'components' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          <Settings2 className="w-3.5 h-3.5" /> Salary Components
        </button>
        <button
          onClick={() => setSubTab('grades')}
          className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'grades' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          <LayoutGrid className="w-3.5 h-3.5" /> Pay Grades
        </button>
        <button
          onClick={() => setSubTab('individual')}
          className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            subTab === 'individual' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-blue-600'
          }`}
        >
          <User className="w-3.5 h-3.5" /> Employee Salary
        </button>
      </div>

      {subTab === 'components' ? (
        <SalaryComponentsPanel authHeaders={authHeaders} />
      ) : subTab === 'grades' ? (
        <PayGradesPanel authHeaders={authHeaders} />
      ) : (
        <IndividualSalaryPanel authHeaders={authHeaders} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Salary Components
// ---------------------------------------------------------------------------
const SalaryComponentsPanel: React.FC<{ authHeaders: Record<string, string> }> = ({ authHeaders }) => {
  const [components, setComponents] = useState<SalaryComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<SalaryComponent | 'new' | null>(null);

  const fetchComponents = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/payroll/salary-components'), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Salary Setup." : 'Failed to load components.');
        return;
      }
      setComponents(await res.json());
    } catch {
      setError('Failed to load components.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchComponents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (c: SalaryComponent) => {
    if (!window.confirm(`Delete the "${c.name}" component?`)) return;
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/salary-components/${c.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to delete component.');
        return;
      }
      await fetchComponents();
    } catch {
      setActionError('Failed to delete component.');
    }
  };

  const earnings = components.filter((c) => c.component_type === 'earning');
  const deductions = components.filter((c) => c.component_type === 'deduction');

  const renderTable = (title: string, icon: React.ReactNode, rows: SalaryComponent[]) => (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <span className="text-[11px] text-slate-400">({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-10">No {title.toLowerCase()} yet.</p>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2.5 text-left">Name</th>
              <th className="px-4 py-2.5 text-left">Description</th>
              <th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs">
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">{c.name}</td>
                <td className="px-4 py-2.5 text-slate-500">{c.description || '—'}</td>
                <td className="px-4 py-2.5">
                  {c.is_active ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Active</span>
                  ) : (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Inactive</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => setEditing(c)}
                      className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(c)}
                      className="w-7 h-7 flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded-lg"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 max-w-md">
          Earning components (Basic, House Rent, Conveyance, Medical, Special Allowance...) and Deduction components
          (Provident Fund, Tax, Advance Salary, Fine/Penalty...) used to build Pay Grades.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchComponents}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Component
          </button>
        </div>
      </div>

      {actionError && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{actionError}</p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size={26} /></div>
      ) : error ? (
        <p className="text-xs text-rose-600 text-center py-16">{error}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {renderTable('Earning Components', <TrendingUp className="w-4 h-4 text-emerald-600" />, earnings)}
          {renderTable('Deduction Components', <TrendingDown className="w-4 h-4 text-rose-600" />, deductions)}
        </div>
      )}

      {editing && (
        <ComponentModal
          authHeaders={authHeaders}
          component={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            fetchComponents();
          }}
        />
      )}
    </div>
  );
};

const ComponentModal: React.FC<{
  authHeaders: Record<string, string>;
  component: SalaryComponent | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ authHeaders, component, onClose, onSaved }) => {
  const [name, setName] = useState(component?.name || '');
  const [componentType, setComponentType] = useState<'earning' | 'deduction'>(component?.component_type || 'earning');
  const [description, setDescription] = useState(component?.description || '');
  const [isActive, setIsActive] = useState(component ? !!component.is_active : true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) {
      setError('Component name is required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const url = component ? `/api/payroll/salary-components/${component.id}` : '/api/payroll/salary-components';
      const res = await fetch(apiUrl(url), {
        method: component ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), component_type: componentType, description: description.trim() || null, is_active: isActive })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save component.');
        return;
      }
      onSaved();
    } catch {
      setError('Failed to save component.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800">{component ? 'Edit Component' : 'Add Component'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. House Rent"
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setComponentType('earning')}
                className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  componentType === 'earning' ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-slate-200 text-slate-500'
                }`}
              >
                Earning
              </button>
              <button
                type="button"
                onClick={() => setComponentType('deduction')}
                className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  componentType === 'deduction' ? 'bg-rose-50 border-rose-300 text-rose-700' : 'border-slate-200 text-slate-500'
                }`}
              >
                Deduction
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          {component && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          )}
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
          >
            {submitting ? <Spinner size={14} /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Pay Grades
// ---------------------------------------------------------------------------
const PayGradesPanel: React.FC<{ authHeaders: Record<string, string> }> = ({ authHeaders }) => {
  const [grades, setGrades] = useState<PayGrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<PayGrade | 'new' | null>(null);
  const [assigning, setAssigning] = useState<PayGrade | null>(null);

  const fetchGrades = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/payroll/pay-grades'), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Salary Setup." : 'Failed to load Pay Grades.');
        return;
      }
      setGrades(await res.json());
    } catch {
      setError('Failed to load Pay Grades.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (g: PayGrade) => {
    if (!window.confirm(`Delete "${g.grade_name}"? This does not affect employees already assigned this grade's numbers.`)) return;
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/pay-grades/${g.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to delete Pay Grade.');
        return;
      }
      await fetchGrades();
    } catch {
      setActionError('Failed to delete Pay Grade.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 max-w-md">
          Configure a pay-scale per designation (Grade 1, Grade 2...) — a Basic Salary plus any Earning/Deduction
          components — then assign it to an employee to create their Salary Structure.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchGrades}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Pay Grade
          </button>
        </div>
      </div>

      {actionError && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{actionError}</p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size={26} /></div>
      ) : error ? (
        <p className="text-xs text-rose-600 text-center py-16">{error}</p>
      ) : grades.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 text-center">
          <p className="text-xs text-slate-400">No Pay Grades set up yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {grades.map((g) => (
            <div key={g.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{g.grade_name}</h3>
                  {g.grade_code && <p className="text-[10px] text-slate-400">{g.grade_code}</p>}
                </div>
                {!g.is_active && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">Inactive</span>
                )}
              </div>
              <div className="p-4 space-y-1.5 flex-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Basic Salary</span>
                  <span className="font-medium text-slate-800">{money(g.basic_salary)}</span>
                </div>
                {g.components.map((c) => (
                  <div key={c.id} className="flex justify-between text-xs">
                    <span className="text-slate-500">{c.name}</span>
                    <span className={c.component_type === 'deduction' ? 'text-rose-600' : 'text-slate-700'}>
                      {c.component_type === 'deduction' ? '− ' : ''}{money(c.amount)}
                    </span>
                  </div>
                ))}
                <div className="border-t border-slate-100 mt-2 pt-2 flex justify-between text-xs font-semibold">
                  <span className="text-slate-700">Gross Salary</span>
                  <span className="text-slate-900">{money(g.gross_salary)}</span>
                </div>
                {g.description && <p className="text-[11px] text-slate-400 pt-1">{g.description}</p>}
              </div>
              <div className="p-3 border-t border-slate-100 flex items-center justify-between gap-1.5">
                <button
                  onClick={() => setAssigning(g)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg"
                >
                  <UserPlus className="w-3.5 h-3.5" /> Assign
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing(g)}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => remove(g)}
                    className="w-7 h-7 flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded-lg"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <GradeModal
          authHeaders={authHeaders}
          grade={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            fetchGrades();
          }}
        />
      )}
      {assigning && (
        <AssignGradeModal authHeaders={authHeaders} grade={assigning} onClose={() => setAssigning(null)} />
      )}
    </div>
  );
};

const GradeModal: React.FC<{
  authHeaders: Record<string, string>;
  grade: PayGrade | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ authHeaders, grade, onClose, onSaved }) => {
  const [gradeName, setGradeName] = useState(grade?.grade_name || '');
  const [gradeCode, setGradeCode] = useState(grade?.grade_code || '');
  const [basicSalary, setBasicSalary] = useState(String(grade?.basic_salary ?? ''));
  const [description, setDescription] = useState(grade?.description || '');
  const [allComponents, setAllComponents] = useState<SalaryComponent[]>([]);
  const [amounts, setAmounts] = useState<Record<number, string>>(() => {
    const initial: Record<number, string> = {};
    (grade?.components || []).forEach((c) => { initial[c.component_id] = String(c.amount); });
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/payroll/salary-components?active_only=1'), { headers: authHeaders });
        if (res.ok) setAllComponents(await res.json());
      } catch {
        // Component picker just stays empty — not fatal.
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const setAmount = (componentId: number, value: string) => setAmounts((a) => ({ ...a, [componentId]: value }));

  const submit = async () => {
    if (!gradeName.trim()) {
      setError('Grade name is required.');
      return;
    }
    const basic = Number(basicSalary);
    if (!basic || basic <= 0) {
      setError('Basic Salary must be a positive number.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const components = Object.entries(amounts)
        .map(([componentId, amount]) => ({ component_id: Number(componentId), amount: Number(amount) }))
        .filter((c) => c.amount > 0);
      const url = grade ? `/api/payroll/pay-grades/${grade.id}` : '/api/payroll/pay-grades';
      const res = await fetch(apiUrl(url), {
        method: grade ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grade_name: gradeName.trim(),
          grade_code: gradeCode.trim() || null,
          basic_salary: basic,
          description: description.trim() || null,
          components
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save Pay Grade.');
        return;
      }
      onSaved();
    } catch {
      setError('Failed to save Pay Grade.');
    } finally {
      setSubmitting(false);
    }
  };

  const earnings = allComponents.filter((c) => c.component_type === 'earning');
  const deductions = allComponents.filter((c) => c.component_type === 'deduction');

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800">{grade ? 'Edit Pay Grade' : 'Add Pay Grade'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Grade Name</label>
              <input
                type="text"
                value={gradeName}
                onChange={(e) => setGradeName(e.target.value)}
                placeholder="e.g. Grade 1"
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Grade Code (optional)</label>
              <input
                type="text"
                value={gradeCode}
                onChange={(e) => setGradeCode(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Basic Salary</label>
            <input
              type="number"
              value={basicSalary}
              onChange={(e) => setBasicSalary(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          {earnings.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-emerald-700 mb-1.5">Earning Components</p>
              <div className="space-y-1.5">
                {earnings.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 flex-1">{c.name}</span>
                    <input
                      type="number"
                      value={amounts[c.id] || ''}
                      onChange={(e) => setAmount(c.id, e.target.value)}
                      placeholder="0.00"
                      className="w-28 px-2.5 py-1 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {deductions.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-rose-700 mb-1.5">Deduction Components</p>
              <div className="space-y-1.5">
                {deductions.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 flex-1">{c.name}</span>
                    <input
                      type="number"
                      value={amounts[c.id] || ''}
                      onChange={(e) => setAmount(c.id, e.target.value)}
                      placeholder="0.00"
                      className="w-28 px-2.5 py-1 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {allComponents.length === 0 && (
            <p className="text-[11px] text-slate-400">No components yet — add some under Salary Components first.</p>
          )}

          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
          >
            {submitting ? <Spinner size={14} /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

const AssignGradeModal: React.FC<{
  authHeaders: Record<string, string>;
  grade: PayGrade;
  onClose: () => void;
}> = ({ authHeaders, grade, onClose }) => {
  const [employees, setEmployees] = useState<PayrollEmployeeLite[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ unmapped_deductions: Array<{ name: string; amount: number }> } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/payroll/employees'), { headers: authHeaders });
        if (res.ok) setEmployees(await res.json());
      } catch {
        // Dropdown stays empty — error surfaces on submit instead.
      } finally {
        setLoadingEmployees(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const submit = async () => {
    if (!employeeId) {
      setError('Please select an employee.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/pay-grades/${grade.id}/assign`), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: Number(employeeId), effective_date: effectiveDate })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to assign Pay Grade.');
        return;
      }
      setResult({ unmapped_deductions: data.unmapped_deductions || [] });
    } catch {
      setError('Failed to assign Pay Grade.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-800">Assign "{grade.grade_name}"</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        {result ? (
          <div className="p-5 space-y-3">
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              Salary Structure created from "{grade.grade_name}".
            </p>
            {result.unmapped_deductions.length > 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                Note: {result.unmapped_deductions.map((d) => `${d.name} (${money(d.amount)})`).join(', ')} — this
                deduction isn't part of the Salary Structure and should be applied per payroll run instead (e.g.
                Advance Salary under Employee Advances, or Other Deduction on the payroll run).
              </p>
            )}
            <button
              onClick={onClose}
              className="w-full px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Employee</label>
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  disabled={loadingEmployees}
                  className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">{loadingEmployees ? 'Loading employees…' : 'Select an employee'}</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}{e.employee_code ? ` (${e.employee_code})` : ''}{e.department ? ` — ${e.department}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Effective Date</label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              {error && <p className="text-xs text-rose-600">{error}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
              <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
              >
                {submitting ? <Spinner size={14} /> : 'Assign'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Employee Salary — direct, no-Grade-required Salary Structure entry/edit
// per employee. Backed by the salary_structures CRUD endpoints
// (GET/POST/PUT/DELETE /api/payroll/salary-structures) which existed on the
// server but previously had no UI wired to them (Pay Grades' "Assign" was
// the only way to create a row). This panel is for when an employee's
// numbers don't fit any Grade template, or you just want to set one
// employee's salary directly.
// ---------------------------------------------------------------------------
const IndividualSalaryPanel: React.FC<{ authHeaders: Record<string, string> }> = ({ authHeaders }) => {
  const [rows, setRows] = useState<SalaryStructureRow[]>([]);
  const [employees, setEmployees] = useState<PayrollEmployeeLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<SalaryStructureRow | 'new' | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [structRes, empRes] = await Promise.all([
        fetch(apiUrl('/api/payroll/salary-structures'), { headers: authHeaders }),
        fetch(apiUrl('/api/payroll/employees'), { headers: authHeaders })
      ]);
      if (!structRes.ok) {
        setError(structRes.status === 403 ? "You don't have access to Salary Setup." : 'Failed to load salary structures.');
        return;
      }
      setRows(await structRes.json());
      if (empRes.ok) setEmployees(await empRes.json());
    } catch {
      setError('Failed to load salary structures.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (r: SalaryStructureRow) => {
    if (!window.confirm(`Delete this ${money(r.gross_salary)} salary structure for ${r.employee_name} (effective ${r.effective_date})? Payroll runs already generated from it are not affected.`)) return;
    setActionError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll/salary-structures/${r.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Failed to delete salary structure.');
        return;
      }
      await fetchAll();
    } catch {
      setActionError('Failed to delete salary structure.');
    }
  };

  // Rows arrive grouped by employee_id (then newest effective_date first) —
  // group them here just for the "Current" badge and a visual header per
  // employee, without re-sorting anything the server already ordered.
  const groups = useMemo(() => {
    const map = new Map<number, SalaryStructureRow[]>();
    for (const r of rows) {
      if (!map.has(r.employee_id)) map.set(r.employee_id, []);
      map.get(r.employee_id)!.push(r);
    }
    return Array.from(map.values());
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500 max-w-md">
          Set or correct one employee's Basic Salary and allowances/deductions directly — no Pay Grade required. The
          most recent Effective Date on or before a payroll run's month is what that run uses.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={fetchAll}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Salary
          </button>
        </div>
      </div>

      {actionError && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{actionError}</p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size={26} /></div>
      ) : error ? (
        <p className="text-xs text-rose-600 text-center py-16">{error}</p>
      ) : groups.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 text-center">
          <p className="text-xs text-slate-400">No employee has a salary structure yet — click "Add Salary" to set one.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-left">
                <th className="px-4 py-2.5 font-semibold">Employee</th>
                <th className="px-4 py-2.5 font-semibold">Effective Date</th>
                <th className="px-4 py-2.5 font-semibold text-right">Basic</th>
                <th className="px-4 py-2.5 font-semibold text-right">Gross</th>
                <th className="px-4 py-2.5 font-semibold text-right">Tax</th>
                <th className="px-4 py-2.5 font-semibold text-right">PF</th>
                <th className="px-4 py-2.5 font-semibold text-right w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <React.Fragment key={group[0].employee_id}>
                  {group.map((r, idx) => (
                    <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="px-4 py-2.5">
                        {idx === 0 ? (
                          <div>
                            <p className="font-medium text-slate-800">{r.employee_name}</p>
                            <p className="text-[10px] text-slate-400">
                              {[r.employee_code, r.designation, r.department].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                        ) : (
                          <p className="text-slate-300 pl-2">↳ earlier</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {r.effective_date}
                        {idx === 0 && (
                          <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                            Current
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-700">{money(r.basic_salary)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-900">{money(r.gross_salary)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500">{money(r.tax_deduction)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500">{money(r.pf_deduction)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setEditing(r)}
                            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => remove(r)}
                            className="w-7 h-7 flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded-lg"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <IndividualSalaryModal
          authHeaders={authHeaders}
          structure={editing === 'new' ? null : editing}
          employees={employees}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            fetchAll();
          }}
        />
      )}
    </div>
  );
};

// Type-to-search employee picker — a plain <select> makes you scroll through
// every employee to find one; this lets you type a few letters of the name,
// code, or department and pick from the narrowed list, while still working
// like a normal dropdown (click to open, click an option, click away to
// close) if you'd rather just browse.
const EmployeeCombobox: React.FC<{
  employees: PayrollEmployeeLite[];
  value: string;
  onChange: (employeeId: string) => void;
}> = ({ employees, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = employees.find((e) => String(e.id) === value) || null;
  const label = (e: PayrollEmployeeLite) =>
    `${e.name}${e.employee_code ? ` (${e.employee_code})` : ''}${e.department ? ` — ${e.department}` : ''}`;

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.name, e.employee_code, e.department, e.designation].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }, [employees, query]);

  return (
    <div className="relative" ref={wrapRef}>
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={open ? query : selected ? label(selected) : ''}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          placeholder="Type a name, code or department…"
          className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-52 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-slate-400">No employee matches "{query}".</p>
          ) : (
            filtered.map((e) => (
              <button
                type="button"
                key={e.id}
                onClick={() => {
                  onChange(String(e.id));
                  setOpen(false);
                  setQuery('');
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-blue-50 transition-colors ${
                  String(e.id) === value ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-700'
                }`}
              >
                {label(e)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const IndividualSalaryModal: React.FC<{
  authHeaders: Record<string, string>;
  structure: SalaryStructureRow | null; // null = creating a new row
  employees: PayrollEmployeeLite[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ authHeaders, structure, employees, onClose, onSaved }) => {
  const isEdit = structure !== null;
  const [employeeId, setEmployeeId] = useState(structure ? String(structure.employee_id) : '');
  const [basicSalary, setBasicSalary] = useState(structure ? String(structure.basic_salary) : '');
  const [houseRent, setHouseRent] = useState(structure ? String(structure.house_rent) : '0');
  const [medical, setMedical] = useState(structure ? String(structure.medical_allowance) : '0');
  const [conveyance, setConveyance] = useState(structure ? String(structure.conveyance_allowance) : '0');
  const [otherAllowance, setOtherAllowance] = useState(structure ? String(structure.other_allowance) : '0');
  const [tax, setTax] = useState(structure ? String(structure.tax_deduction) : '0');
  const [pf, setPf] = useState(structure ? String(structure.pf_deduction) : '0');
  const [effectiveDate, setEffectiveDate] = useState(structure ? structure.effective_date.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const grossPreview = useMemo(() => {
    const n = (v: string) => Number(v) || 0;
    return n(basicSalary) + n(houseRent) + n(medical) + n(conveyance) + n(otherAllowance);
  }, [basicSalary, houseRent, medical, conveyance, otherAllowance]);

  const submit = async () => {
    setError('');
    if (!isEdit && !employeeId) {
      setError('Please select an employee.');
      return;
    }
    if (!(Number(basicSalary) > 0)) {
      setError('Basic Salary must be a positive number.');
      return;
    }
    if (!effectiveDate) {
      setError('Effective Date is required.');
      return;
    }
    setSubmitting(true);
    const body = {
      employee_id: Number(employeeId),
      basic_salary: Number(basicSalary),
      house_rent: Number(houseRent) || 0,
      medical_allowance: Number(medical) || 0,
      conveyance_allowance: Number(conveyance) || 0,
      other_allowance: Number(otherAllowance) || 0,
      tax_deduction: Number(tax) || 0,
      pf_deduction: Number(pf) || 0,
      effective_date: effectiveDate
    };
    try {
      const res = await fetch(
        apiUrl(isEdit ? `/api/payroll/salary-structures/${structure!.id}` : '/api/payroll/salary-structures'),
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save salary structure.');
        return;
      }
      onSaved();
    } catch {
      setError('Failed to save salary structure.');
    } finally {
      setSubmitting(false);
    }
  };

  const numField = (label: string, value: string, setValue: (v: string) => void, negative?: boolean) => (
    <div>
      <label className="block text-[11px] text-slate-500 mb-1">{label}</label>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`w-full px-2.5 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 ${
          negative ? 'border-rose-100 focus:ring-rose-300' : 'border-slate-200 focus:ring-blue-400'
        }`}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-slate-800">
            {isEdit ? `Edit Salary — ${structure!.employee_name}` : 'Add Employee Salary'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!isEdit && (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Employee</label>
              <EmployeeCombobox employees={employees} value={employeeId} onChange={setEmployeeId} />
            </div>
          )}

          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Effective Date</label>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {!isEdit && (
              <p className="text-[10px] text-slate-400 mt-1">
                A new date here creates a new history row (e.g. a raise) — it never overwrites the old one.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {numField('Basic Salary *', basicSalary, setBasicSalary)}
            {numField('House Rent', houseRent, setHouseRent)}
            {numField('Medical Allowance', medical, setMedical)}
            {numField('Conveyance Allowance', conveyance, setConveyance)}
            {numField('Other Allowance', otherAllowance, setOtherAllowance)}
            <div />
            {numField('Tax Deduction', tax, setTax, true)}
            {numField('Provident Fund (PF)', pf, setPf, true)}
          </div>

          <div className="border-t border-slate-100 pt-3 flex justify-between text-xs font-semibold">
            <span className="text-slate-600">Gross Salary (auto)</span>
            <span className="text-slate-900">{money(grossPreview)}</span>
          </div>

          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
          >
            {submitting ? <Spinner size={14} /> : isEdit ? 'Save Changes' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};