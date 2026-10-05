/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Allowance & Adjustment (PayrollItemsRoutes.ts). Two parts:
//   * Monthly Allowance / Deduction — a fixed line for chosen employees
//     from a start month (optionally to an end month): Food Allowance taken
//     from salary, Bike Maintenance paid with it, and so on. Named after a
//     Salary Component (Salary Setup) or typed in.
//   * Salary Adjustment — an earlier month paid wrong: Arrear (paid too
//     little, paid back) or Recovery (paid too much, taken back), settled
//     from a chosen month in one go or in equal installments.
// Every payroll run generated afterwards picks these up by itself and shows
// each on the payslip under its own name.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Ban, Pencil, Plus, RefreshCw, Scale, Search, Trash2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';

interface EmployeeLite {
  id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  designation: string | null;
}
interface Component {
  id: number;
  name: string;
  component_type: 'earning' | 'deduction';
  is_active: number | boolean;
}
interface PayItem {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  name: string;
  kind: 'earning' | 'deduction';
  amount: number;
  start_month: string;
  end_month: string | null;
  remarks: string | null;
  is_active: boolean;
  runs: number;
}
interface Adjustment {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  kind: 'arrear' | 'recovery';
  for_month: string;
  label: string;
  total_amount: number;
  installment_amount: number;
  start_month: string;
  reason: string | null;
  status: 'active' | 'settled' | 'cancelled';
  applied_amount: number;
  remaining_amount: number;
  applications: { month_year: string; amount: number; payment_status: string }[];
  created_by_name: string | null;
}

const money = (n: number | null | undefined) =>
  `৳${(Number(n) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (ym: string | null) => {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }) : ym;
};
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const nextMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const inputCls = 'w-full text-sm px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';
const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';
const btnPrimary = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';
const btnGhost = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50';

const KindBadge: React.FC<{ kind: 'earning' | 'deduction' }> = ({ kind }) =>
  kind === 'earning' ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700">
      <ArrowUpCircle className="w-3 h-3" /> Paid with salary
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-700">
      <ArrowDownCircle className="w-3 h-3" /> Taken from salary
    </span>
  );

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }> = ({ title, onClose, children, footer }) => (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
        <h4 className="text-sm font-bold text-slate-900">{title}</h4>
        <button type="button" onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-5 py-4 overflow-y-auto space-y-3">{children}</div>
      <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">{footer}</div>
    </div>
  </div>
);

export const PayrollAdjustmentsPanel: React.FC<{ token: string }> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [subTab, setSubTab] = useState<'items' | 'adjustments'>('items');
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [items, setItems] = useState<PayItem[] | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[] | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [q, setQ] = useState('');
  const [itemForm, setItemForm] = useState<'new' | PayItem | null>(null);
  const [adjForm, setAdjForm] = useState(false);

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(apiUrl(path), {
        ...init,
        headers: { ...authHeaders, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      return data;
    },
    [authHeaders]
  );

  const load = useCallback(() => {
    call('/api/payroll/pay-items')
      .then(setItems)
      .catch((e) => {
        setItems([]);
        setMsg({ type: 'error', text: e.message });
      });
    call('/api/payroll/adjustments')
      .then(setAdjustments)
      .catch(() => setAdjustments([]));
  }, [call]);

  useEffect(() => {
    load();
    call('/api/payroll/employees').then(setEmployees).catch(() => setEmployees([]));
    call('/api/payroll/salary-components?active_only=1').then(setComponents).catch(() => setComponents([]));
  }, [load, call]);

  const run = async (fn: () => Promise<any>, text: string) => {
    try {
      await fn();
      setMsg({ type: 'success', text });
      load();
      return true;
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
      return false;
    }
  };

  const needle = q.trim().toLowerCase();
  const match = (r: { employee_name: string; employee_code: string | null; department: string | null }, extra: string) =>
    !needle || [r.employee_name, r.employee_code, r.department, extra].some((v) => String(v || '').toLowerCase().includes(needle));

  const month = thisMonth();
  const itemStatus = (it: PayItem) =>
    !it.is_active ? 'Stopped' : it.end_month && it.end_month < month ? 'Ended' : it.start_month > month ? 'Upcoming' : 'Running';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Scale className="w-5 h-5 text-blue-600" /> Allowance & Adjustment
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
              Money added to or taken from salary on top of the Salary Structure — a monthly Food deduction, a Bike Maintenance payment, or fixing a
              month that was paid wrong. Every payroll run generated afterwards applies these by itself and shows each on the payslip under its own name.
            </p>
          </div>
          <button type="button" className={btnGhost} onClick={load}>
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <div className="inline-flex p-0.5 rounded-lg bg-slate-100">
            {(
              [
                ['items', 'Monthly Allowance / Deduction'],
                ['adjustments', 'Salary Adjustment (Arrear / Recovery)'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSubTab(key)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md ${subTab === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search employee or item"
              className="w-full pl-7 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <div className="flex-1" />
          {subTab === 'items' ? (
            <button type="button" className={btnPrimary} onClick={() => setItemForm('new')}>
              <Plus className="w-3.5 h-3.5" /> Add allowance / deduction
            </button>
          ) : (
            <button type="button" className={btnPrimary} onClick={() => setAdjForm(true)}>
              <Plus className="w-3.5 h-3.5" /> New adjustment
            </button>
          )}
        </div>

        {msg && (
          <div
            className={`mt-3 text-xs rounded-lg px-3 py-2 flex items-start justify-between gap-2 ${
              msg.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
            }`}
          >
            <span>{msg.text}</span>
            <button type="button" onClick={() => setMsg(null)} aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {subTab === 'items' ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {!items ? (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          ) : items.filter((r) => match(r, r.name)).length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">No monthly allowance or deduction yet. Add one — for example Food Allowance taken from salary.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Employee</th>
                    <th className="px-3 py-2 font-semibold">Item</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Per month</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">From</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">To</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items
                    .filter((r) => match(r, r.name))
                    .map((it) => {
                      const st = itemStatus(it);
                      return (
                        <tr key={it.id} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2.5">
                            <div className="font-semibold text-slate-800">{it.employee_name}</div>
                            <div className="text-slate-500">{[it.employee_code, it.department].filter(Boolean).join(' · ')}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="font-semibold text-slate-800">{it.name}</div>
                            <div className="mt-0.5">
                              <KindBadge kind={it.kind} />
                            </div>
                            {it.remarks && <div className="text-[10px] text-slate-400 mt-0.5">{it.remarks}</div>}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap ${it.kind === 'earning' ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {it.kind === 'earning' ? '+' : '−'}
                            {money(it.amount)}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{monthName(it.start_month)}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{it.end_month ? monthName(it.end_month) : 'Until stopped'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                                st === 'Running'
                                  ? 'bg-blue-50 text-blue-700'
                                  : st === 'Upcoming'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {st}
                            </span>
                            {it.runs > 0 && <div className="text-[10px] text-slate-400 mt-0.5">on {it.runs} payroll run{it.runs === 1 ? '' : 's'}</div>}
                          </td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap">
                            <button
                              type="button"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-blue-700 hover:bg-blue-50"
                              title="Edit"
                              aria-label={`Edit ${it.name} for ${it.employee_name}`}
                              onClick={() => setItemForm(it)}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-rose-700 hover:bg-rose-50"
                              title="Delete"
                              aria-label={`Delete ${it.name} for ${it.employee_name}`}
                              onClick={async () => {
                                if (
                                  (await confirmDialog(
                                    `Delete ${it.name} for ${it.employee_name}? Payroll runs already generated keep it; new runs won't add it. To stop it from a month on, edit it and set an end month instead.`
                                  ))
                                )
                                  run(() => call(`/api/payroll/pay-items/${it.id}`, { method: 'DELETE' }), `${it.name} removed for ${it.employee_name}.`);
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {!adjustments ? (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          ) : adjustments.filter((r) => match(r, r.label)).length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">No salary adjustment yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Employee</th>
                    <th className="px-3 py-2 font-semibold">Adjustment</th>
                    <th className="px-3 py-2 font-semibold text-right">Total</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Per month</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">From</th>
                    <th className="px-3 py-2 font-semibold">Settled so far</th>
                    <th className="px-3 py-2 font-semibold text-right">Left</th>
                    <th className="px-3 py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments
                    .filter((r) => match(r, r.label))
                    .map((a) => (
                      <tr key={a.id} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-slate-800">{a.employee_name}</div>
                          <div className="text-slate-500">{[a.employee_code, a.department].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="px-3 py-2.5 max-w-[260px]">
                          <div className="font-semibold text-slate-800">{a.label}</div>
                          <div className="mt-0.5">
                            <KindBadge kind={a.kind === 'arrear' ? 'earning' : 'deduction'} />
                          </div>
                          {a.reason && <div className="text-[10px] text-slate-500 mt-0.5">{a.reason}</div>}
                          {a.created_by_name && <div className="text-[10px] text-slate-400">by {a.created_by_name}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">{money(a.total_amount)}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">{money(a.installment_amount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{monthName(a.start_month)}</td>
                        <td className="px-3 py-2.5">
                          {a.applications.length === 0 ? (
                            <span className="text-slate-400">Not yet</span>
                          ) : (
                            a.applications.map((ap) => (
                              <div key={ap.month_year} className="whitespace-nowrap">
                                {monthName(ap.month_year)}: {money(ap.amount)}{' '}
                                <span className="text-[10px] text-slate-400">({ap.payment_status})</span>
                              </div>
                            ))
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="font-semibold">{money(a.remaining_amount)}</div>
                          {(() => {
                            // Fully placed on payroll runs, but Settled only once every one of them is Paid.
                            const allPaid = a.applications.every((ap) => ap.payment_status === 'paid');
                            const [label, tone] =
                              a.status === 'cancelled'
                                ? ['Cancelled', 'bg-slate-100 text-slate-500']
                                : a.status === 'active'
                                ? ['Running', 'bg-blue-50 text-blue-700']
                                : allPaid
                                ? ['Settled', 'bg-emerald-50 text-emerald-700']
                                : ['In payroll', 'bg-amber-50 text-amber-700'];
                            return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${tone}`}>{label}</span>;
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {a.status === 'active' && a.applied_amount > 0 && (
                            <button
                              type="button"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-700 hover:bg-amber-50"
                              title="Cancel what's left"
                              aria-label={`Cancel ${a.label} for ${a.employee_name}`}
                              onClick={async () => {
                                if ((await confirmDialog(`Stop ${a.label} for ${a.employee_name}? ${money(a.remaining_amount)} left will not be applied. What runs already carried stays.`)))
                                  run(() => call(`/api/payroll/adjustments/${a.id}/cancel`, { method: 'POST' }), `${a.label} stopped.`);
                              }}
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {a.applied_amount === 0 && a.status !== 'cancelled' && (
                            <button
                              type="button"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-rose-700 hover:bg-rose-50"
                              title="Delete"
                              aria-label={`Delete ${a.label} for ${a.employee_name}`}
                              onClick={async () => {
                                if ((await confirmDialog(`Delete ${a.label} for ${a.employee_name}? No payroll run has carried it yet.`)))
                                  run(() => call(`/api/payroll/adjustments/${a.id}`, { method: 'DELETE' }), `${a.label} deleted.`);
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {itemForm && (
        <PayItemForm
          editing={itemForm === 'new' ? null : itemForm}
          employees={employees}
          components={components}
          onClose={() => setItemForm(null)}
          onSave={async (body, editingId) => {
            const ok = await run(
              () =>
                editingId
                  ? call(`/api/payroll/pay-items/${editingId}`, { method: 'PUT', body: JSON.stringify(body) })
                  : call('/api/payroll/pay-items', { method: 'POST', body: JSON.stringify(body) }),
              editingId ? 'Saved.' : `${body.employee_ids?.length || 1} employee(s) will get this from ${monthName(body.start_month)}.`
            );
            if (ok) setItemForm(null);
          }}
        />
      )}
      {adjForm && (
        <AdjustmentForm
          employees={employees}
          call={call}
          onClose={() => setAdjForm(false)}
          onSave={async (body) => {
            const ok = await run(() => call('/api/payroll/adjustments', { method: 'POST', body: JSON.stringify(body) }), 'Adjustment saved. It applies when that month\'s payroll is generated.');
            if (ok) setAdjForm(false);
          }}
        />
      )}
    </div>
  );
};

const PayItemForm: React.FC<{
  editing: PayItem | null;
  employees: EmployeeLite[];
  components: Component[];
  onClose: () => void;
  onSave: (body: any, editingId?: number) => void;
}> = ({ editing, employees, components, onClose, onSave }) => {
  const [componentId, setComponentId] = useState<string>(() => (components[0] ? String(components[0].id) : 'other'));
  const [name, setName] = useState(editing?.name || '');
  const [kind, setKind] = useState<'earning' | 'deduction'>(editing?.kind || 'deduction');
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  const [start, setStart] = useState(editing?.start_month || thisMonth());
  const [end, setEnd] = useState(editing?.end_month || '');
  const [remarks, setRemarks] = useState(editing?.remarks || '');
  const [active, setActive] = useState(editing ? editing.is_active : true);
  const [dept, setDept] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const departments = useMemo(() => Array.from(new Set(employees.map((e) => e.department).filter(Boolean) as string[])).sort(), [employees]);
  const shown = employees.filter(
    (e) =>
      (!dept || e.department === dept) &&
      (!search.trim() || [e.name, e.employee_code].some((v) => String(v || '').toLowerCase().includes(search.trim().toLowerCase())))
  );
  const comp = components.find((c) => String(c.id) === componentId);
  const allShownPicked = shown.length > 0 && shown.every((e) => picked.has(e.id));

  const submit = () => {
    if (editing) {
      onSave({ name, amount: Number(amount), start_month: start, end_month: end || null, remarks, is_active: active }, editing.id);
      return;
    }
    onSave({
      employee_ids: Array.from(picked),
      component_id: comp ? comp.id : null,
      name: comp ? undefined : name,
      kind: comp ? undefined : kind,
      amount: Number(amount),
      start_month: start,
      end_month: end || null,
      remarks
    });
  };

  return (
    <Modal
      title={editing ? `Edit ${editing.name} — ${editing.employee_name}` : 'Add monthly allowance / deduction'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} onClick={submit} disabled={!editing && picked.size === 0}>
            {editing ? 'Save' : `Add for ${picked.size} employee${picked.size === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {editing ? (
        <div>
          <label className={labelCls}>Name on payslip</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="mt-1">
            <KindBadge kind={editing.kind} />
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className={labelCls}>Item</label>
            <select className={inputCls} value={componentId} onChange={(e) => setComponentId(e.target.value)}>
              {components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.component_type === 'earning' ? 'paid with salary' : 'taken from salary'}
                </option>
              ))}
              <option value="other">Other — type a name</option>
            </select>
            <p className="text-[10px] text-slate-400 mt-1">The list comes from Salary Setup → Salary Components.</p>
          </div>
          {!comp && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Name on payslip</label>
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Food Allowance" />
              </div>
              <div>
                <label className={labelCls}>This money is</label>
                <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as any)}>
                  <option value="deduction">Taken from salary</option>
                  <option value="earning">Paid with salary</option>
                </select>
              </div>
            </div>
          )}
        </>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Amount per month (৳)</label>
          <input className={inputCls} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>From month</label>
          <input className={inputCls} type="month" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>To month (optional)</label>
          <input className={inputCls} type="month" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Note (optional)</label>
        <input className={inputCls} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Office lunch, per policy HR-12" />
      </div>
      {editing ? (
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (untick to stop it from the next payroll run)
        </label>
      ) : (
        <div>
          <label className={labelCls}>Employees ({picked.size} chosen)</label>
          <div className="flex gap-2 mb-2">
            <select className={inputCls} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <input className={inputCls} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID" />
          </div>
          <div className="border border-slate-200 rounded-lg max-h-56 overflow-y-auto">
            <label className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-50 border-b border-slate-100 sticky top-0">
              <input
                type="checkbox"
                checked={allShownPicked}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    shown.forEach((x) => (e.target.checked ? next.add(x.id) : next.delete(x.id)));
                    return next;
                  })
                }
              />
              Select all shown ({shown.length})
            </label>
            {shown.map((e) => (
              <label key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={picked.has(e.id)}
                  onChange={(ev) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (ev.target.checked) next.add(e.id);
                      else next.delete(e.id);
                      return next;
                    })
                  }
                />
                <span className="font-medium">{e.name}</span>
                <span className="text-slate-400">{[e.employee_code, e.department].filter(Boolean).join(' · ')}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
};

const AdjustmentForm: React.FC<{
  employees: EmployeeLite[];
  call: (path: string, init?: RequestInit) => Promise<any>;
  onClose: () => void;
  onSave: (body: any) => void;
}> = ({ employees, call, onClose, onSave }) => {
  const [employeeId, setEmployeeId] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'arrear' | 'recovery'>('recovery');
  const [forMonth, setForMonth] = useState(prevMonth(thisMonth()));
  const [total, setTotal] = useState('');
  const [start, setStart] = useState(thisMonth());
  const [installments, setInstallments] = useState('1');
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState<{ gross_earned: number; total_deduction: number; net_salary: number; payment_status: string } | null | undefined>(undefined);

  useEffect(() => {
    if (!employeeId || !forMonth) {
      setRef(undefined);
      return;
    }
    call(`/api/payroll/adjustments/reference?employee_id=${employeeId}&month_year=${forMonth}`)
      .then(setRef)
      .catch(() => setRef(null));
  }, [employeeId, forMonth, call]);

  const shown = employees.filter(
    (e) => !search.trim() || [e.name, e.employee_code, e.department].some((v) => String(v || '').toLowerCase().includes(search.trim().toLowerCase()))
  );
  const n = Math.max(1, Math.min(24, Math.round(Number(installments) || 1)));
  const per = Number(total) > 0 ? Math.ceil((Number(total) / n) * 100) / 100 : 0;

  return (
    <Modal
      title="New salary adjustment"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!employeeId}
            onClick={() =>
              onSave({ employee_id: Number(employeeId), kind, for_month: forMonth, total_amount: Number(total), start_month: start, installments: n, reason })
            }
          >
            Save adjustment
          </button>
        </>
      }
    >
      <div>
        <label className={labelCls}>Employee</label>
        <input className={`${inputCls} mb-1.5`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, ID or department" />
        <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} size={Math.min(6, Math.max(2, shown.length + 1))}>
          <option value="">— choose —</option>
          {shown.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.employee_code ? ` (${e.employee_code})` : ''}
              {e.department ? ` — ${e.department}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['recovery', 'Paid too much', 'Take the extra back (Recovery)'],
            ['arrear', 'Paid too little', 'Pay the difference (Arrear)'],
          ] as const
        ).map(([key, title, sub]) => (
          <button
            key={key}
            type="button"
            onClick={() => setKind(key)}
            className={`text-left rounded-xl border px-3 py-2.5 ${
              kind === key ? (key === 'recovery' ? 'border-rose-300 bg-rose-50' : 'border-emerald-300 bg-emerald-50') : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <div className="text-xs font-bold text-slate-800">{title}</div>
            <div className="text-[11px] text-slate-500">{sub}</div>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Month that was paid wrong</label>
          <input className={inputCls} type="month" value={forMonth} onChange={(e) => setForMonth(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Difference (৳)</label>
          <input className={inputCls} type="number" min={0} value={total} onChange={(e) => setTotal(e.target.value)} />
        </div>
      </div>
      {employeeId && ref !== undefined && (
        <div className="text-[11px] rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-slate-600">
          {ref ? (
            <>
              {monthName(forMonth)} payroll: Gross {money(ref.gross_earned)} · Deduction {money(ref.total_deduction)} · Net{' '}
              <span className="font-semibold text-slate-800">{money(ref.net_salary)}</span> ({ref.payment_status})
            </>
          ) : (
            <>No payroll found for {monthName(forMonth)}.</>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Settle from month</label>
          <input className={inputCls} type="month" value={start} min={nextMonth(forMonth)} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>In how many months</label>
          <input className={inputCls} type="number" min={1} max={24} value={installments} onChange={(e) => setInstallments(e.target.value)} />
        </div>
      </div>
      {per > 0 && (
        <p className="text-[11px] text-slate-600">
          {kind === 'recovery' ? 'Taken from' : 'Added to'} salary: <span className="font-semibold">{money(per)}</span> a month for {n} month{n === 1 ? '' : 's'}, from{' '}
          {monthName(start)}. On the payslip as "{kind === 'recovery' ? 'Recovery' : 'Arrear'} ({monthName(forMonth)})".
        </p>
      )}
      <div>
        <label className={labelCls}>Reason</label>
        <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. August paid 3,000 extra because of a wrong attendance count" />
      </div>
    </Modal>
  );
};
