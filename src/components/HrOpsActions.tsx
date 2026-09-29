/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Personnel Actions": every Promotion, Increment, Transfer,
// Confirmation… with its FROM -> TO change, approval progress (who it's
// waiting on) and history; a form to raise a new one; and "Letter" to issue
// the matching letter once it's approved.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, FileText, XCircle, ChevronDown, ChevronRight, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Spinner } from './Spinner';
import { LetterComposer, type ComposerInit } from './HrOpsLetters';
import {
  useHrApi,
  EmployeePicker,
  Modal,
  Notice,
  Badge,
  Field,
  fmtDate,
  taka,
  inputCls,
  labelCls,
  btnPrimary,
  btnGhost,
  SERVICE_STATUS_LABEL,
  type HrOpsEmployee,
  type HrOpsMeta
} from './HrOpsShared';

interface HrAction {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  action_type: string;
  action_label: string;
  effective_date: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  applied: boolean;
  current_step: number;
  total_steps: number;
  waiting_on: { label: string; names: string[] } | null;
  chain: { step_order: number; label: string; approver_ids: number[] }[];
  history: { action: string; by_name: string; at: string; step_label?: string | null; remarks?: string | null }[];
  from: Record<string, any>;
  to: Record<string, any>;
  summary: string;
  reason: string | null;
  batch_id: string | null;
  letter_id: number | null;
  letter_ref: string | null;
  created_by_name: string | null;
  created_at: string;
}

// Which "to" fields each action type asks for.
const FIELDS_FOR: Record<string, string[]> = {
  promotion: ['designation', 'grade', 'department_id', 'gross_salary'],
  increment: ['gross_salary'],
  salary_adjustment: ['gross_salary'],
  transfer: ['department_id', 'branch_id', 'supervisor_id'],
  confirmation: [],
  designation_change: ['designation'],
  grade_change: ['grade'],
  contract_renewal: ['contract_end_date'],
  probation_extension: ['probation_end_date'],
  suspension: [],
  resignation: [],
  termination: [],
  retirement: [],
  other: ['designation', 'grade', 'department_id', 'branch_id', 'gross_salary']
};
const EFFECTIVE_LABEL: Record<string, string> = {
  resignation: 'Last working day',
  termination: 'Last working day',
  retirement: 'Last working day',
  confirmation: 'Confirmed from'
};

export const NewActionModal: React.FC<{
  token: string;
  meta: HrOpsMeta;
  employees: HrOpsEmployee[];
  initialEmployeeId?: number | null;
  initialType?: string;
  onClose: () => void;
  onSaved: (status: string) => void;
}> = ({ token, meta, employees, initialEmployeeId, initialType, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [employeeId, setEmployeeId] = useState<number | null>(initialEmployeeId ?? null);
  const [type, setType] = useState(initialType || 'promotion');
  const [eff, setEff] = useState('');
  const [to, setTo] = useState<Record<string, string>>({});
  const [pct, setPct] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const emp = employees.find((e) => e.id === employeeId) || null;
  const fields = FIELDS_FOR[type] || [];
  const set = (k: string, v: string) => setTo((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    setTo({});
    setPct('');
  }, [type, employeeId]);

  const save = async () => {
    setErr('');
    if (!employeeId) return setErr('Pick an employee.');
    if (!eff) return setErr('Pick the effective date.');
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const k of fields) if (to[k] !== undefined && to[k] !== '') payload[k] = to[k];
      const r = await api.post<any>('/api/hr-ops/actions', { employee_id: employeeId, action_type: type, effective_date: eff, to: payload, reason });
      onSaved(r.status);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const current: Record<string, string> = emp
    ? {
        designation: emp.designation || '—',
        grade: emp.grade || '—',
        department_id: emp.department || '—',
        branch_id: emp.branch || '—',
        supervisor_id: emp.supervisor || '—',
        gross_salary: taka(emp.gross_salary),
        probation_end_date: fmtDate(emp.probation_end_date),
        contract_end_date: fmtDate(emp.contract_end_date)
      }
    : {};
  const LABEL: Record<string, string> = {
    designation: 'New designation',
    grade: 'New grade',
    department_id: 'New department',
    branch_id: 'New branch',
    supervisor_id: 'New supervisor',
    gross_salary: 'New gross salary (৳ / month)',
    probation_end_date: 'Probation extended until',
    contract_end_date: 'Contract extended until'
  };
  const chainNote = meta.action_types.find((a) => a.key === type)?.label;

  return (
    <Modal
      title="New HR Action"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Submit for Approval
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Notice msg={{ type: 'error', text: err }} />}
        <div>
          <label className={labelCls}>Employee</label>
          <EmployeePicker employees={employees} value={employeeId} onChange={setEmployeeId} />
        </div>
        {emp && (
          <div className="grid grid-cols-3 gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
            <Field label="Designation" value={emp.designation} />
            <Field label="Department" value={emp.department} />
            <Field label="Grade" value={emp.grade} />
            <Field label="Gross" value={taka(emp.gross_salary)} />
            <Field label="Joined" value={fmtDate(emp.joining_date)} />
            <Field label="Status" value={SERVICE_STATUS_LABEL[emp.service_status] || emp.service_status} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Action</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {meta.action_types.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>{EFFECTIVE_LABEL[type] || 'Effective date'}</label>
            <input type="date" value={eff} onChange={(e) => setEff(e.target.value)} className={inputCls} />
          </div>
        </div>
        {fields.map((k) => (
          <div key={k}>
            <label className={labelCls}>
              {LABEL[k]} {emp && <span className="font-normal text-slate-400">· now: {current[k]}</span>}
            </label>
            {k === 'department_id' ? (
              <select value={to[k] || ''} onChange={(e) => set(k, e.target.value)} className={inputCls}>
                <option value="">{type === 'transfer' ? 'Pick department…' : 'No change'}</option>
                {meta.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : k === 'branch_id' ? (
              <select value={to[k] || ''} onChange={(e) => set(k, e.target.value)} className={inputCls}>
                <option value="">No change</option>
                {meta.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : k === 'supervisor_id' ? (
              <EmployeePicker employees={employees.filter((e) => e.id !== employeeId)} value={to[k] ? Number(to[k]) : null} onChange={(id) => set(k, id ? String(id) : '')} placeholder="No change" />
            ) : k === 'gross_salary' ? (
              <div className="grid grid-cols-[1fr_110px] gap-2">
                <input
                  type="number"
                  min={0}
                  value={to[k] || ''}
                  onChange={(e) => {
                    set(k, e.target.value);
                    if (emp?.gross_salary && e.target.value) setPct((((Number(e.target.value) - emp.gross_salary) / emp.gross_salary) * 100).toFixed(2));
                  }}
                  placeholder={type === 'promotion' || type === 'other' ? 'Leave empty for no change' : 'e.g. 52000'}
                  className={inputCls}
                />
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    value={pct}
                    disabled={!emp?.gross_salary}
                    onChange={(e) => {
                      setPct(e.target.value);
                      if (emp?.gross_salary && e.target.value !== '') set(k, String(Math.round(emp.gross_salary * (1 + Number(e.target.value) / 100))));
                    }}
                    placeholder="%"
                    className={`${inputCls} pr-6`}
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                </div>
              </div>
            ) : k.endsWith('_date') ? (
              <input type="date" value={to[k] || ''} onChange={(e) => set(k, e.target.value)} className={inputCls} />
            ) : (
              <input value={to[k] || ''} onChange={(e) => set(k, e.target.value)} className={inputCls} />
            )}
          </div>
        ))}
        <div>
          <label className={labelCls}>Reason / justification</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={inputCls} placeholder="Visible to approvers and kept in the service book" />
        </div>
        <p className="text-[11px] text-slate-400">
          {chainNote} goes through the approval chain set in Settings → Approval Chains. Changes are applied to the employee on the effective date after final approval.
        </p>
      </div>
    </Modal>
  );
};

export const HrOpsActions: React.FC<{ token: string; meta: HrOpsMeta; employees: HrOpsEmployee[]; onChanged: () => void; refreshKey?: number }> = ({ token, meta, employees, onChanged, refreshKey }) => {
  const api = useHrApi(token);
  const [actions, setActions] = useState<HrAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [status, setStatus] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [composer, setComposer] = useState<ComposerInit | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setActions(await api.get<HrAction[]>('/api/hr-ops/actions'));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const list = useMemo(
    () =>
      actions.filter((a) => {
        if (status !== 'all' && a.status !== status) return false;
        if (type && a.action_type !== type) return false;
        const s = q.trim().toLowerCase();
        return !s || [a.employee_name, a.employee_code, a.summary, a.reason].some((v) => String(v || '').toLowerCase().includes(s));
      }),
    [actions, status, type, q]
  );
  const counts = { all: actions.length, pending: actions.filter((a) => a.status === 'pending').length, approved: actions.filter((a) => a.status === 'approved').length, rejected: actions.filter((a) => a.status === 'rejected').length };

  const cancel = async (a: HrAction) => {
    if (!window.confirm(`Cancel this ${a.action_label} for ${a.employee_name}?`)) return;
    try {
      await api.post(`/api/hr-ops/actions/${a.id}/cancel`);
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  const changeRows = (a: HrAction) => {
    const rows: [string, string, string][] = [];
    const add = (label: string, k: string, money = false, date = false) => {
      if (a.to[k] === undefined || a.to[k] === null || a.to[k] === '') return;
      const f = (v: any) => (v === undefined || v === null || v === '' ? '—' : money ? taka(Number(v)) : date ? fmtDate(v) : String(v));
      rows.push([label, f(a.from[k]), f(a.to[k])]);
    };
    add('Designation', 'designation');
    add('Department', 'department');
    add('Branch', 'branch');
    add('Supervisor', 'supervisor');
    add('Grade', 'grade');
    add('Gross Salary', 'gross_salary', true);
    add('Probation until', 'probation_end_date', false, true);
    add('Contract until', 'contract_end_date', false, true);
    return rows;
  };

  return (
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 flex-wrap">
          {(['all', 'pending', 'approved', 'rejected'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)} className={`text-xs font-semibold px-3 py-1.5 rounded-md capitalize ${status === s ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}>
              {s} <span className="text-slate-400">({counts[s]})</span>
            </button>
          ))}
        </div>
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus className="w-3.5 h-3.5" /> New HR Action
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee, change, reason…" className={`${inputCls} pl-8`} />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All actions</option>
          {meta.action_types.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner size={16} /> Loading…
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-12">No HR actions yet.</p>
      ) : (
        <div className="space-y-2">
          {list.map((a) => {
            const isOpen = open === a.id;
            const rows = changeRows(a);
            return (
              <div key={a.id} className={`rounded-xl border bg-white ${a.status === 'pending' ? 'border-amber-200' : 'border-slate-200'}`}>
                <button type="button" onClick={() => setOpen(isOpen ? null : a.id)} className="w-full text-left px-4 py-3 flex items-start gap-3">
                  {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800">{a.action_label}</span>
                      <span className="text-sm text-slate-600">— {a.employee_name}</span>
                      {a.employee_code && <span className="text-[11px] text-slate-400">{a.employee_code}</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Effective {fmtDate(a.effective_date)}
                      {rows.length > 0 && ` · ${rows.map((r) => `${r[0]}: ${r[1]} → ${r[2]}`).join(' · ')}`}
                    </div>
                    {a.status === 'pending' && a.waiting_on && (
                      <div className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Waiting on {a.waiting_on.label} ({a.waiting_on.names.join(' / ')}) — step {a.current_step} of {a.total_steps}
                      </div>
                    )}
                    {a.status === 'approved' && !a.applied && (
                      <div className="text-[11px] text-sky-700 mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Approved — takes effect on {fmtDate(a.effective_date)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge tone={a.status}>{a.status}</Badge>
                    {a.letter_ref && <span className="text-[10px] text-slate-400">{a.letter_ref}</span>}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 pl-11 space-y-3">
                    {rows.length > 0 && (
                      <div className="rounded-lg border border-slate-200 overflow-hidden text-xs max-w-xl">
                        <div className="grid grid-cols-3 bg-slate-50 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                          <span className="px-3 py-1.5">Field</span>
                          <span className="px-3 py-1.5">From</span>
                          <span className="px-3 py-1.5">To</span>
                        </div>
                        {rows.map((r) => (
                          <div key={r[0]} className="grid grid-cols-3 border-t border-slate-100">
                            <span className="px-3 py-1.5 text-slate-500">{r[0]}</span>
                            <span className="px-3 py-1.5 text-slate-500">{r[1]}</span>
                            <span className="px-3 py-1.5 font-semibold text-slate-900">{r[2]}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {a.reason && <p className="text-xs text-slate-600">Reason: {a.reason}</p>}
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Approval trail</div>
                      <ol className="space-y-1">
                        {a.history.map((h, i) => (
                          <li key={i} className="text-[11px] text-slate-600 flex items-start gap-1.5">
                            {h.action === 'approved' ? (
                              <CheckCircle2 className="w-3 h-3 text-emerald-600 mt-0.5" />
                            ) : h.action === 'rejected' || h.action === 'cancelled' ? (
                              <XCircle className="w-3 h-3 text-rose-500 mt-0.5" />
                            ) : (
                              <AlertTriangle className="w-3 h-3 text-slate-400 mt-0.5" />
                            )}
                            <span>
                              <span className="capitalize font-semibold">{h.action}</span>
                              {h.step_label ? ` (${h.step_label})` : ''} by {h.by_name} · {new Date(h.at).toLocaleString()}
                              {h.remarks ? ` — ${h.remarks}` : ''}
                            </span>
                          </li>
                        ))}
                        {a.status === 'pending' &&
                          a.chain
                            .filter((c) => c.step_order >= a.current_step)
                            .map((c) => (
                              <li key={`c${c.step_order}`} className="text-[11px] text-slate-400 flex items-center gap-1.5">
                                <Clock className="w-3 h-3" /> {c.label}
                                {c.step_order === a.current_step ? ' — now' : ''}
                              </li>
                            ))}
                      </ol>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {a.status === 'approved' && (
                        <button type="button" className={btnPrimary} onClick={() => setComposer({ employee_id: a.employee_id, hr_action_id: a.id })}>
                          <FileText className="w-3.5 h-3.5" /> {a.letter_ref ? 'Issue Another Letter' : 'Issue Letter'}
                        </button>
                      )}
                      {a.status === 'pending' && (
                        <button type="button" className={btnGhost} onClick={() => cancel(a)}>
                          <XCircle className="w-3.5 h-3.5" /> Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewActionModal
          token={token}
          meta={meta}
          employees={employees}
          onClose={() => setShowNew(false)}
          onSaved={(st) => {
            setShowNew(false);
            setMsg({ type: 'success', text: st === 'approved' ? 'Saved — no approval chain is set, so it was approved right away.' : 'Submitted — the first approver has been notified.' });
            load();
            onChanged();
          }}
        />
      )}
      {composer && (
        <LetterComposer
          token={token}
          meta={meta}
          employees={employees}
          init={composer}
          onClose={() => setComposer(null)}
          onIssued={(ref) => {
            setComposer(null);
            setMsg({ type: 'success', text: `Letter ${ref} issued — the employee has been notified.` });
            load();
          }}
        />
      )}
    </div>
  );
};
