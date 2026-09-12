/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Bonus & Incentive — "বোনাস ও ইনসেন্টিভ".
//
// Batch-calculates a Festival Bonus / Performance Bonus / Commission across
// many employees at once and writes each amount into that employee's
// bonus_amount for an ALREADY-GENERATED payroll run for the chosen month —
// via the existing PUT /api/payroll/:id (same endpoint the "Attendance & OT"
// panel uses), so net_salary is always recomputed server-side and this page
// never does that math itself.
//
// Employees with no run yet for the selected month can instead have their
// bonus STAGED (POST /api/payroll/pending-bonuses) — Run Payroll's Step 3
// (Adjustments) then reads it back automatically as that employee's Bonus
// field, and it's consumed (deleted) the moment that run is generated, so
// it's never double-applied.
//
// Reuses:
//   GET    /api/payroll?month_year=...            (existing runs for the month)
//   GET    /api/payroll/salary-structures          (basic/gross, for % calc)
//   GET    /api/payroll/employees                  (roster, for staging names)
//   GET    /api/payroll/pending-bonuses?month_year= (already-staged bonuses)
//   POST   /api/payroll/pending-bonuses            (stage a bonus)
//   DELETE /api/payroll/pending-bonuses/:id        (un-stage a bonus)
//   PUT    /api/payroll/:id                        (writes bonus_amount)

import React, { useEffect, useMemo, useState } from 'react';
import { Gift, RefreshCw, AlertTriangle, CheckCircle2, Sparkles, Clock3, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface BonusIncentiveManagementPanelProps {
  token: string;
}

interface PayrollRunLite {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  bonus_amount: number;
  net_salary: number;
  overtime_amount: number;
  other_deduction: number;
  total_working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  overtime_hours: number;
  remarks: string | null;
  payment_status: 'unpaid' | 'processed' | 'paid';
}

interface SalaryStructureLite {
  employee_id: number;
  basic_salary: number;
  gross_salary: number;
}

interface Department {
  id: number;
  name: string;
}

interface EmployeeLite {
  id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  designation: string | null;
}

interface PendingBonus {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  month_year: string;
  amount: number;
  reason: string | null;
}

interface BonusRow extends PayrollRunLite {
  included: boolean;
  computed_bonus: number;
}

type BonusType = 'festival' | 'performance' | 'commission';
type BasisType = 'flat' | 'pct_basic' | 'pct_gross';
type ApplyMode = 'replace' | 'add';

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

const monthLabel = (my: string) => {
  const [y, m] = my.split('-').map(Number);
  if (!y || !m) return my;
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
};

const BONUS_LABELS: Record<BonusType, string> = {
  festival: 'Festival Bonus (Eid / Puja / etc.)',
  performance: 'Performance Bonus',
  commission: 'Commission'
};

export const BonusIncentiveManagementPanel: React.FC<BonusIncentiveManagementPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [bonusType, setBonusType] = useState<BonusType>('festival');
  const [basis, setBasis] = useState<BasisType>('flat');
  const [applyMode, setApplyMode] = useState<ApplyMode>('replace');
  const [flatAmount, setFlatAmount] = useState('');
  const [percentage, setPercentage] = useState('');
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);

  const [runs, setRuns] = useState<PayrollRunLite[]>([]);
  const [structures, setStructures] = useState<Map<number, SalaryStructureLite>>(new Map());
  const [rows, setRows] = useState<BonusRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [pendingBonuses, setPendingBonuses] = useState<PendingBonus[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [applying, setApplying] = useState(false);
  const [stagingId, setStagingId] = useState<number | 'all' | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/departments'), { headers: authHeaders });
        if (res.ok) setDepartments(await res.json());
      } catch {
        // Department filter just stays "All" — not fatal.
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setLoadError('');
    setNotice(null);
    try {
      const [runsRes, structRes, empRes, pendingRes] = await Promise.all([
        fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders }),
        fetch(apiUrl('/api/payroll/salary-structures'), { headers: authHeaders }),
        fetch(apiUrl('/api/payroll/employees'), { headers: authHeaders }),
        fetch(apiUrl(`/api/payroll/pending-bonuses?month_year=${monthYear}`), { headers: authHeaders })
      ]);
      if (!runsRes.ok) {
        setLoadError(runsRes.status === 403 ? "You don't have access to Payroll." : 'Failed to load payroll runs for this month.');
        return;
      }
      const runsData: PayrollRunLite[] = await runsRes.json();
      setRuns(runsData);

      const structMap = new Map<number, SalaryStructureLite>();
      if (structRes.ok) {
        const structData = await structRes.json();
        // API returns every historical row per employee, most recent first —
        // keep only the first (latest) one seen per employee_id.
        for (const s of structData) {
          if (!structMap.has(s.employee_id)) {
            structMap.set(s.employee_id, { employee_id: s.employee_id, basic_salary: Number(s.basic_salary), gross_salary: Number(s.gross_salary) });
          }
        }
      }
      setStructures(structMap);

      if (empRes.ok) setEmployees(await empRes.json());
      if (pendingRes.ok) setPendingBonuses(await pendingRes.json());
    } catch {
      setLoadError('Failed to load payroll runs for this month.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthYear]);

  // Recompute the working row set whenever the source data, department
  // filter, or calculation inputs change — nothing here is written to the
  // server until "Apply Bonus" is clicked.
  useEffect(() => {
    const flat = Number(flatAmount) || 0;
    const pct = Number(percentage) || 0;
    const filtered = department ? runs.filter((r) => r.department === department) : runs;

    const next: BonusRow[] = filtered.map((r) => {
      const structure = structures.get(r.employee_id);
      let computed = 0;
      if (basis === 'flat') computed = flat;
      else if (basis === 'pct_basic') computed = structure ? (Number(structure.basic_salary) * pct) / 100 : 0;
      else if (basis === 'pct_gross') computed = structure ? (Number(structure.gross_salary) * pct) / 100 : 0;
      computed = Math.round(computed * 100) / 100;
      return { ...r, included: r.payment_status !== 'paid', computed_bonus: computed };
    });
    setRows(next);
  }, [runs, structures, department, basis, flatAmount, percentage]);

  const toggleRow = (employeeId: number, included: boolean) => {
    setRows((prev) => prev.map((r) => (r.employee_id === employeeId ? { ...r, included } : r)));
  };

  const includedRows = rows.filter((r) => r.included);
  const totalBonus = includedRows.reduce((s, r) => s + r.computed_bonus, 0);
  const paidLockedCount = rows.filter((r) => r.payment_status === 'paid').length;

  const applyBonus = async () => {
    if (includedRows.length === 0) return;
    setApplying(true);
    setNotice(null);
    let succeeded = 0;
    let failed = 0;
    for (const r of includedRows) {
      const finalBonus = applyMode === 'add' ? Number(r.bonus_amount || 0) + r.computed_bonus : r.computed_bonus;
      try {
        const res = await fetch(apiUrl(`/api/payroll/${r.id}`), {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            total_working_days: r.total_working_days,
            present_days: r.present_days,
            absent_days: r.absent_days,
            leave_days: r.leave_days,
            lwp_days: r.lwp_days,
            overtime_hours: r.overtime_hours,
            overtime_amount: r.overtime_amount,
            bonus_amount: finalBonus,
            other_deduction: r.other_deduction,
            remarks: r.remarks ? `${r.remarks} · ${BONUS_LABELS[bonusType]}` : BONUS_LABELS[bonusType]
          })
        });
        if (res.ok) succeeded += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    setNotice(
      failed === 0
        ? { type: 'success', text: `Applied ${BONUS_LABELS[bonusType]} to ${succeeded} employee${succeeded === 1 ? '' : 's'}.` }
        : { type: 'error', text: `Applied to ${succeeded}, failed for ${failed} — try refreshing and applying again for the rest.` }
    );
    setApplying(false);
    fetchData();
  };

  // Active employees on this month's salary structures list who have no
  // payroll run generated yet for the selected month — bonus can't attach
  // to a run that doesn't exist, so it's staged instead (below).
  const generatedIds = new Set(runs.map((r) => r.employee_id));
  const notYetGeneratedCount = Array.from(structures.keys()).filter((id) => !generatedIds.has(id)).length;

  // Same Calculation (bonusType/basis/flat/percentage/department) applied
  // to the not-yet-generated roster, so staging uses the identical numbers
  // shown for the already-generated table above.
  const stagedByEmployee = useMemo(() => {
    const map = new Map<number, PendingBonus[]>();
    for (const b of pendingBonuses) {
      if (!map.has(b.employee_id)) map.set(b.employee_id, []);
      map.get(b.employee_id)!.push(b);
    }
    return map;
  }, [pendingBonuses]);

  const stageRows = useMemo(() => {
    const flat = Number(flatAmount) || 0;
    const pct = Number(percentage) || 0;
    const candidates = employees.filter((e) => structures.has(e.id) && !generatedIds.has(e.id));
    const filtered = department ? candidates.filter((e) => e.department === department) : candidates;
    return filtered.map((e) => {
      const structure = structures.get(e.id);
      let computed = 0;
      if (basis === 'flat') computed = flat;
      else if (basis === 'pct_basic') computed = structure ? (Number(structure.basic_salary) * pct) / 100 : 0;
      else if (basis === 'pct_gross') computed = structure ? (Number(structure.gross_salary) * pct) / 100 : 0;
      computed = Math.round(computed * 100) / 100;
      const staged = stagedByEmployee.get(e.id) || [];
      const stagedTotal = staged.reduce((s, b) => s + Number(b.amount), 0);
      return { employee: e, computed_bonus: computed, staged, staged_total: stagedTotal };
    });
  }, [employees, structures, generatedIds, department, basis, flatAmount, percentage, stagedByEmployee]);

  const stageBonus = async (employeeId: number, amount: number) => {
    if (amount <= 0) return;
    setStagingId(employeeId);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/payroll/pending-bonuses'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: employeeId, month_year: monthYear, amount, reason: BONUS_LABELS[bonusType] })
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error || 'Failed to stage bonus.' });
        return;
      }
      await fetchData();
    } catch {
      setNotice({ type: 'error', text: 'Failed to stage bonus.' });
    } finally {
      setStagingId(null);
    }
  };

  const stageAllBonuses = async () => {
    const toStage = stageRows.filter((r) => r.computed_bonus > 0);
    if (toStage.length === 0) return;
    setStagingId('all');
    setNotice(null);
    let succeeded = 0;
    let failed = 0;
    for (const r of toStage) {
      try {
        const res = await fetch(apiUrl('/api/payroll/pending-bonuses'), {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee_id: r.employee.id, month_year: monthYear, amount: r.computed_bonus, reason: BONUS_LABELS[bonusType] })
        });
        if (res.ok) succeeded += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    setNotice(
      failed === 0
        ? { type: 'success', text: `Staged ${BONUS_LABELS[bonusType]} for ${succeeded} employee${succeeded === 1 ? '' : 's'} — it'll be picked up automatically in Run Payroll's Step 3.` }
        : { type: 'error', text: `Staged for ${succeeded}, failed for ${failed} — try again for the rest.` }
    );
    setStagingId(null);
    fetchData();
  };

  const removeStagedBonus = async (id: number) => {
    setStagingId(id);
    setNotice(null);
    try {
      const res = await fetch(apiUrl(`/api/payroll/pending-bonuses/${id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error || 'Failed to remove staged bonus.' });
        return;
      }
      await fetchData();
    } catch {
      setNotice({ type: 'error', text: 'Failed to remove staged bonus.' });
    } finally {
      setStagingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
            <Gift className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Bonus &amp; Incentive Management</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
              Calculate and distribute a Festival Bonus, Performance Bonus, or Commission across employees for {monthLabel(monthYear)}.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={monthYear}
            onChange={(e) => setMonthYear(e.target.value)}
            className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={fetchData}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Calculation setup */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-700">Calculation</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Bonus Type</label>
            <select
              value={bonusType}
              onChange={(e) => setBonusType(e.target.value as BonusType)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="festival">Festival Bonus</option>
              <option value="performance">Performance Bonus</option>
              <option value="commission">Commission</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Basis</label>
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value as BasisType)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="flat">Flat Amount (same for everyone)</option>
              <option value="pct_basic">% of Basic Salary</option>
              <option value="pct_gross">% of Gross Salary</option>
            </select>
          </div>
          {basis === 'flat' ? (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Amount per Employee</label>
              <input
                type="number"
                value={flatAmount}
                onChange={(e) => setFlatAmount(e.target.value)}
                placeholder="e.g. 5000"
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Percentage</label>
              <input
                type="number"
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
                placeholder="e.g. 100 for a full-month bonus"
                className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          )}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Department</label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-4 pt-1">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="radio" checked={applyMode === 'replace'} onChange={() => setApplyMode('replace')} />
            Replace existing bonus on each run
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="radio" checked={applyMode === 'add'} onChange={() => setApplyMode('add')} />
            Add on top of existing bonus
          </label>
        </div>
      </div>

      {notYetGeneratedCount > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 space-y-3">
          <p className="text-xs text-amber-700 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {notYetGeneratedCount} employee{notYetGeneratedCount === 1 ? '' : 's'} with a Salary Structure {notYetGeneratedCount === 1 ? "hasn't" : "haven't"} had payroll generated for {monthLabel(monthYear)} yet — stage their bonus below and it'll be picked up automatically as the Bonus field in Run Payroll's Step 3 (Adjustments) once their run is generated.
          </p>
          <div className="bg-white rounded-xl border border-amber-100 overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-right">Already Staged</th>
                  <th className="px-3 py-2 text-right">Calculated Bonus</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {stageRows.map((r) => (
                  <tr key={r.employee.id}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <p className="font-medium text-slate-800">{r.employee.name}</p>
                      <p className="text-[10px] text-slate-400">{r.employee.employee_code || '—'} · {r.employee.department || '—'}</p>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.staged.length === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <div className="space-y-1">
                          {r.staged.map((b) => (
                            <div key={b.id} className="flex items-center justify-end gap-1.5">
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                <Clock3 className="w-2.5 h-2.5" /> {money(b.amount)}
                              </span>
                              <button
                                onClick={() => removeStagedBonus(b.id)}
                                disabled={stagingId === b.id}
                                className="w-5 h-5 flex items-center justify-center text-rose-400 hover:bg-rose-50 rounded"
                                title="Remove staged bonus"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-amber-700 font-medium">{money(r.computed_bonus)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => stageBonus(r.employee.id, r.computed_bonus)}
                        disabled={stagingId !== null || r.computed_bonus <= 0}
                        className="flex items-center gap-1 px-2.5 py-1 bg-amber-100 hover:bg-amber-200 text-amber-800 text-[11px] font-semibold rounded-lg ml-auto disabled:opacity-50"
                      >
                        {stagingId === r.employee.id ? <Spinner size={12} /> : <Clock3 className="w-3 h-3" />} Stage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button
              onClick={stageAllBonuses}
              disabled={stagingId !== null || stageRows.every((r) => r.computed_bonus <= 0)}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
            >
              {stagingId === 'all' ? <Spinner size={14} /> : <Clock3 className="w-3.5 h-3.5" />} Stage {BONUS_LABELS[bonusType]} for All Above
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p
          className={`text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 ${
            notice.type === 'success' ? 'text-emerald-700 bg-emerald-50 border border-emerald-100' : 'text-rose-600 bg-rose-50 border border-rose-100'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
          {notice.text}
        </p>
      )}

      {/* Preview & apply */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size={26} /></div>
        ) : loadError ? (
          <p className="text-xs text-rose-600 text-center py-16">{loadError}</p>
        ) : rows.length === 0 ? (
          <div className="text-center py-16">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto mb-2" />
            <p className="text-xs text-slate-400">No payroll runs generated for {monthLabel(monthYear)} yet — use "Run Payroll" first.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-2.5 text-left">Include</th>
                    <th className="px-3 py-2.5 text-left">Employee</th>
                    <th className="px-3 py-2.5 text-right">Existing Bonus</th>
                    <th className="px-3 py-2.5 text-right">Calculated Bonus</th>
                    <th className="px-3 py-2.5 text-right">New Bonus</th>
                    <th className="px-3 py-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {rows.map((r) => {
                    const finalBonus = applyMode === 'add' ? Number(r.bonus_amount || 0) + r.computed_bonus : r.computed_bonus;
                    const locked = r.payment_status === 'paid';
                    return (
                      <tr key={r.id} className={locked ? 'bg-slate-50/60' : ''}>
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={r.included}
                            disabled={locked}
                            onChange={(e) => toggleRow(r.employee_id, e.target.checked)}
                          />
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <p className="font-medium text-slate-800">{r.employee_name}</p>
                          <p className="text-[10px] text-slate-400">{r.employee_code || '—'} · {r.department || '—'}</p>
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-500">{money(r.bonus_amount)}</td>
                        <td className="px-3 py-2.5 text-right text-amber-700 font-medium">{money(r.computed_bonus)}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{money(finalBonus)}</td>
                        <td className="px-3 py-2.5">
                          {locked ? (
                            <span className="text-[10px] text-slate-400">Paid · locked</span>
                          ) : (
                            <span className="text-[10px] text-emerald-600">Editable</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold text-slate-700">
                    <td className="px-3 py-2.5" colSpan={3}>Total ({includedRows.length} employee{includedRows.length === 1 ? '' : 's'} included)</td>
                    <td className="px-3 py-2.5 text-right text-amber-700">{money(totalBonus)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end">
              <button
                onClick={applyBonus}
                disabled={applying || includedRows.length === 0}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {applying ? <Spinner size={16} /> : <Sparkles className="w-4 h-4" />} Apply {BONUS_LABELS[bonusType]}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
