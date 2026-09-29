/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Settings": company & letter numbering, approval chains
// (one default chain plus an optional own chain per action type — e.g.
// Promotion: HR Head -> MD), letter templates (edit / save as new / set
// default, with the list of {{placeholders}}), the onboarding checklist, and
// increment rules.

import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, Copy, Star, ArrowUp, ArrowDown, X } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Notice, Badge, inputCls, labelCls, btnPrimary, btnGhost, type HrOpsMeta } from './HrOpsShared';

type Section = 'company' | 'approvals' | 'templates' | 'onboarding' | 'increments';

// ---------------- Company ----------------
const CompanySettings: React.FC<{ token: string; meta: HrOpsMeta; onSaved: () => void }> = ({ token, meta, onSaved }) => {
  const api = useHrApi(token);
  const [s, setS] = useState<Record<string, string>>(meta.settings);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const year = new Date().getFullYear();
  const sample = (s.ref_format || '')
    .replace(/\{CODE\}/g, s.company_code || '')
    .replace(/\{TYPE\}/g, 'PRM')
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year).slice(2))
    .replace(/\{MM\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ\}/g, '0001');
  const f = (k: string, label: string, ph?: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input value={s[k] || ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} placeholder={ph} className={inputCls} />
    </div>
  );
  return (
    <div className="space-y-4 max-w-2xl">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="grid sm:grid-cols-2 gap-3">
        {f('company_name', 'Company name (letterhead)')}
        {f('company_code', 'Company code', 'CHL')}
        <div className="sm:col-span-2">{f('company_address', 'Company address (letterhead)')}</div>
        {f('signatory_name', 'Signatory name', 'e.g. Md. Karim, Head of HR')}
        {f('signatory_designation', 'Signatory designation')}
        {f('default_probation_months', 'Default probation (months)', '6')}
      </div>
      <div>
        <label className={labelCls}>Letter reference number format</label>
        <input value={s.ref_format || ''} onChange={(e) => setS({ ...s, ref_format: e.target.value })} className={inputCls} />
        <p className="text-[11px] text-slate-500 mt-1">
          Use {'{CODE}'} company code, {'{TYPE}'} letter code (APT, PRM, INC, TRF…), {'{YYYY}'} / {'{YY}'} year, {'{MM}'} month, {'{SEQ}'} running number (per letter type per year). Example: <span className="font-semibold text-slate-800">{sample}</span>
        </p>
      </div>
      <button
        type="button"
        className={btnPrimary}
        onClick={async () => {
          try {
            await api.put('/api/hr-ops/settings', s);
            setMsg({ type: 'success', text: 'Saved.' });
            onSaved();
          } catch (e: any) {
            setMsg({ type: 'error', text: e.message });
          }
        }}
      >
        <Save className="w-3.5 h-3.5" /> Save
      </button>
    </div>
  );
};

// ---------------- Approval chains ----------------
interface Step {
  label: string;
  approver_user_ids: number[];
}
const ApprovalChains: React.FC<{ token: string; meta: HrOpsMeta }> = ({ token, meta }) => {
  const api = useHrApi(token);
  const [chains, setChains] = useState<Record<string, Step[]>>({});
  const [type, setType] = useState('default');
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const c = await api.get<Record<string, Step[]>>('/api/hr-ops/approval-steps');
      setChains(c);
      setSteps(c[type] || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setSteps(chains[type] || []), [type, chains]);
  const userName = (id: number) => meta.users.find((u) => u.id === id)?.name || `#${id}`;
  const save = async () => {
    try {
      await api.put(`/api/hr-ops/approval-steps/${type}`, { steps });
      setMsg({ type: 'success', text: 'Approval chain saved. New actions use it; ones already in progress keep their own chain.' });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const types = [{ key: 'default', label: 'Default (all actions without their own chain)' }, ...meta.action_types];
  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-5">
      <div className="space-y-1">
        {types.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setType(t.key)}
            className={`w-full text-left text-xs px-3 py-2 rounded-lg flex items-center justify-between gap-2 ${type === t.key ? 'bg-blue-50 text-blue-700 font-semibold' : 'hover:bg-slate-50 text-slate-700'}`}
          >
            <span>{t.label}</span>
            {chains[t.key]?.length ? <span className="text-[10px] text-slate-400">{chains[t.key].length} step(s)</span> : t.key !== 'default' ? <span className="text-[10px] text-slate-300">default</span> : null}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        {loading ? (
          <Spinner size={16} />
        ) : (
          <>
            <p className="text-xs text-slate-500">
              {type === 'default'
                ? 'Used for every action type that has no chain of its own. With no steps at all, actions are approved as soon as they are submitted.'
                : `Leave empty to use the Default chain for ${types.find((t) => t.key === type)?.label}.`}{' '}
              Any one approver in a step can clear it; steps run top to bottom.
            </p>
            {steps.map((st, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <input
                    value={st.label}
                    onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    placeholder="Step name, e.g. HR Head"
                    className={`${inputCls} py-1.5`}
                  />
                  <button type="button" disabled={i === 0} onClick={() => setSteps(steps.map((x, j) => (j === i - 1 ? steps[i] : j === i ? steps[i - 1] : x)))} className="p-1 text-slate-400 disabled:opacity-30">
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={i === steps.length - 1}
                    onClick={() => setSteps(steps.map((x, j) => (j === i + 1 ? steps[i] : j === i ? steps[i + 1] : x)))}
                    className="p-1 text-slate-400 disabled:opacity-30"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => setSteps(steps.filter((_, j) => j !== i))} className="p-1 text-rose-500">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 pl-8">
                  {st.approver_user_ids.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-slate-100 text-slate-700 rounded-full pl-2.5 pr-1 py-0.5">
                      {userName(id)}
                      <button type="button" onClick={() => setSteps(steps.map((x, j) => (j === i ? { ...x, approver_user_ids: x.approver_user_ids.filter((u) => u !== id) } : x)))}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <select
                    value=""
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      if (id) setSteps(steps.map((x, j) => (j === i && !x.approver_user_ids.includes(id) ? { ...x, approver_user_ids: [...x.approver_user_ids, id] } : x)));
                    }}
                    className="text-[11px] px-2 py-1 border border-dashed border-slate-300 rounded-full bg-white"
                  >
                    <option value="">+ Add approver</option>
                    {meta.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <button type="button" className={btnGhost} onClick={() => setSteps([...steps, { label: `Step ${steps.length + 1}`, approver_user_ids: [] }])}>
                <Plus className="w-3.5 h-3.5" /> Add Step
              </button>
              <button type="button" className={btnPrimary} onClick={save}>
                <Save className="w-3.5 h-3.5" /> Save Chain
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------- Templates ----------------
interface Template {
  id: number;
  letter_type: string;
  name: string;
  subject: string;
  body: string;
  is_default: number | boolean;
  is_active: number | boolean;
}
const Templates: React.FC<{ token: string; meta: HrOpsMeta }> = ({ token, meta }) => {
  const api = useHrApi(token);
  const [list, setList] = useState<Template[]>([]);
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = () => api.get<Template[]>('/api/hr-ops/letter-templates').then(setList);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const label = (k: string) => meta.letter_types.find((l) => l.key === k)?.label || k;
  const save = async (asNew: boolean) => {
    if (!edit) return;
    try {
      const body = { ...edit, is_default: !!edit.is_default, is_active: edit.is_active !== 0 && edit.is_active !== false };
      if (asNew || !edit.id) await api.post('/api/hr-ops/letter-templates', { ...body, name: asNew && edit.id ? `${edit.name} (copy)` : edit.name });
      else await api.put(`/api/hr-ops/letter-templates/${edit.id}`, body);
      setMsg({ type: 'success', text: 'Template saved.' });
      setEdit(null);
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const insert = (key: string) => {
    const el = document.getElementById('hrops-template-body') as HTMLTextAreaElement | null;
    if (!el || !edit) return;
    const pos = el.selectionStart ?? (edit.body || '').length;
    const text = edit.body || '';
    setEdit({ ...edit, body: text.slice(0, pos) + `{{${key}}}` + text.slice(el.selectionEnd ?? pos) });
  };

  if (edit) {
    return (
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="grid md:grid-cols-[1fr_240px] gap-5">
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Letter type</label>
                <select value={edit.letter_type || ''} onChange={(e) => setEdit({ ...edit, letter_type: e.target.value })} className={inputCls}>
                  {meta.letter_types.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Template name</label>
                <input value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Subject</label>
              <input value={edit.subject || ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Body — leave a blank line between paragraphs</label>
              <textarea id="hrops-template-body" value={edit.body || ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={20} className={`${inputCls} font-mono text-[12px] leading-relaxed`} />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={!!Number(edit.is_default)} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked ? 1 : 0 })} /> Default for this letter type
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={edit.is_active !== 0 && edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked ? 1 : 0 })} /> Active
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnGhost} onClick={() => setEdit(null)}>
                Cancel
              </button>
              {edit.id && (
                <button type="button" className={btnGhost} onClick={() => save(true)}>
                  <Copy className="w-3.5 h-3.5" /> Save as New Template
                </button>
              )}
              <button type="button" className={btnPrimary} onClick={() => save(false)}>
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            </div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-600 mb-1.5">Placeholders — click to insert</div>
            <div className="space-y-0.5 max-h-[560px] overflow-y-auto pr-1">
              {meta.placeholders.map((p) => (
                <button key={p.key} type="button" onClick={() => insert(p.key)} className="w-full text-left text-[11px] px-2 py-1 rounded hover:bg-blue-50">
                  <span className="font-mono text-blue-700">{`{{${p.key}}}`}</span> <span className="text-slate-400">{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  const types = Array.from(new Set(list.map((t) => t.letter_type)));
  return (
    <div className="space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex justify-between items-center gap-2">
        <p className="text-xs text-slate-500">Standard templates are ready to use. Edit any of them or save your own versions — the default one is used unless another is picked while issuing.</p>
        <button type="button" className={btnPrimary} onClick={() => setEdit({ letter_type: 'general', name: '', subject: '', body: '', is_active: 1 })}>
          <Plus className="w-3.5 h-3.5" /> New Template
        </button>
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {types.flatMap((ty) =>
          list
            .filter((t) => t.letter_type === ty)
            .map((t) => (
              <div key={t.id} className={`rounded-xl border bg-white p-3.5 ${Number(t.is_active) ? 'border-slate-200' : 'border-slate-100 opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label(t.letter_type)}</div>
                    <div className="text-sm font-semibold text-slate-800">{t.name}</div>
                  </div>
                  {Number(t.is_default) ? (
                    <Badge tone="approved">
                      <Star className="w-3 h-3" /> Default
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] text-slate-500 mt-1.5 line-clamp-3 whitespace-pre-line">{t.body}</p>
                <div className="flex gap-2 mt-3">
                  <button type="button" className={btnGhost} onClick={() => setEdit(t)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-rose-500 hover:text-rose-700 px-2"
                    onClick={async () => {
                      if (!window.confirm(`Delete template "${t.name}"? Letters already issued are not affected.`)) return;
                      await api.del(`/api/hr-ops/letter-templates/${t.id}`);
                      load();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
};

// ---------------- Onboarding tasks ----------------
interface Task {
  id?: number;
  task_key?: string;
  label: string;
  category: string;
  due_days: number;
  is_active: number | boolean;
}
const OnboardingTasks: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    api.get<Task[]>('/api/hr-ops/onboarding-tasks').then(setTasks);
  }, [api]);
  const set = (i: number, p: Partial<Task>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <div className="space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <p className="text-xs text-slate-500">These items are copied into each new joiner's checklist when onboarding is started. "Due" counts days from the joining date (negative = before joining).</p>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              {['', 'Item', 'Group', 'Due (days)', 'Active', ''].map((h, i) => (
                <th key={i} className="px-3 py-2 text-left font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tasks.map((t, i) => (
              <tr key={t.id ?? `n${i}`}>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <button type="button" disabled={i === 0} className="p-0.5 text-slate-400 disabled:opacity-30" onClick={() => setTasks(tasks.map((x, j) => (j === i - 1 ? tasks[i] : j === i ? tasks[i - 1] : x)))}>
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={i === tasks.length - 1}
                    className="p-0.5 text-slate-400 disabled:opacity-30"
                    onClick={() => setTasks(tasks.map((x, j) => (j === i + 1 ? tasks[i] : j === i ? tasks[i + 1] : x)))}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </td>
                <td className="px-2 py-1.5 min-w-[260px]">
                  <input value={t.label} onChange={(e) => set(i, { label: e.target.value })} className={`${inputCls} py-1 text-xs`} />
                </td>
                <td className="px-2 py-1.5">
                  <input value={t.category} onChange={(e) => set(i, { category: e.target.value })} className={`${inputCls} py-1 text-xs w-36`} />
                </td>
                <td className="px-2 py-1.5">
                  <input type="number" value={t.due_days} onChange={(e) => set(i, { due_days: Number(e.target.value) })} className={`${inputCls} py-1 text-xs w-20`} />
                </td>
                <td className="px-2 py-1.5">
                  <input type="checkbox" checked={!!Number(t.is_active)} onChange={(e) => set(i, { is_active: e.target.checked ? 1 : 0 })} />
                </td>
                <td className="px-2 py-1.5">
                  <button type="button" className="p-1 text-rose-500" onClick={() => setTasks(tasks.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <button type="button" className={btnGhost} onClick={() => setTasks([...tasks, { label: '', category: 'Other', due_days: 7, is_active: 1 }])}>
          <Plus className="w-3.5 h-3.5" /> Add Item
        </button>
        <button
          type="button"
          className={btnPrimary}
          onClick={async () => {
            try {
              await api.put('/api/hr-ops/onboarding-tasks', { tasks: tasks.map((t) => ({ ...t, is_active: !!Number(t.is_active) })) });
              setTasks(await api.get<Task[]>('/api/hr-ops/onboarding-tasks'));
              setMsg({ type: 'success', text: 'Checklist saved. It applies to onboarding started from now on.' });
            } catch (e: any) {
              setMsg({ type: 'error', text: e.message });
            }
          }}
        >
          <Save className="w-3.5 h-3.5" /> Save Checklist
        </button>
      </div>
    </div>
  );
};

// ---------------- Increment rules ----------------
interface Policy {
  id?: number;
  name: string;
  basis: 'anniversary' | 'fixed_month';
  fixed_month: number | null;
  min_service_months: number;
  default_percent: number;
  department_id: number | null;
  grade: string | null;
  job_base: string | null;
  is_active: number | boolean;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const IncrementRules: React.FC<{ token: string; meta: HrOpsMeta }> = ({ token, meta }) => {
  const api = useHrApi(token);
  const [list, setList] = useState<Policy[]>([]);
  const [edit, setEdit] = useState<Policy | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = () => api.get<Policy[]>('/api/hr-ops/increment-policies').then(setList);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = async () => {
    if (!edit) return;
    try {
      const body = { ...edit, is_active: !!Number(edit.is_active) };
      if (edit.id) await api.put(`/api/hr-ops/increment-policies/${edit.id}`, body);
      else await api.post('/api/hr-ops/increment-policies', body);
      setEdit(null);
      setMsg({ type: 'success', text: 'Rule saved.' });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  return (
    <div className="space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex justify-between items-center gap-2">
        <p className="text-xs text-slate-500">Set up as many rules as your company uses. The Increments tab lists who each rule makes due.</p>
        <button
          type="button"
          className={btnPrimary}
          onClick={() => setEdit({ name: '', basis: 'anniversary', fixed_month: 1, min_service_months: 12, default_percent: 5, department_id: null, grade: null, job_base: null, is_active: 1 })}
        >
          <Plus className="w-3.5 h-3.5" /> New Rule
        </button>
      </div>
      {edit && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="sm:col-span-3">
              <label className={labelCls}>Rule name</label>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Annual increment — joining anniversary" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>When</label>
              <select value={edit.basis} onChange={(e) => setEdit({ ...edit, basis: e.target.value as Policy['basis'] })} className={inputCls}>
                <option value="anniversary">Each employee's joining anniversary</option>
                <option value="fixed_month">Same month for everyone</option>
              </select>
            </div>
            {edit.basis === 'fixed_month' && (
              <div>
                <label className={labelCls}>Month</label>
                <select value={edit.fixed_month || 1} onChange={(e) => setEdit({ ...edit, fixed_month: Number(e.target.value) })} className={inputCls}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelCls}>Minimum service (months)</label>
              <input type="number" value={edit.min_service_months} onChange={(e) => setEdit({ ...edit, min_service_months: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Suggested increment %</label>
              <input type="number" step="0.1" value={edit.default_percent} onChange={(e) => setEdit({ ...edit, default_percent: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Only department</label>
              <select value={edit.department_id || ''} onChange={(e) => setEdit({ ...edit, department_id: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                <option value="">All departments</option>
                {meta.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Only grade</label>
              <input value={edit.grade || ''} onChange={(e) => setEdit({ ...edit, grade: e.target.value || null })} placeholder="All grades" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Only job base</label>
              <select value={edit.job_base || ''} onChange={(e) => setEdit({ ...edit, job_base: e.target.value || null })} className={inputCls}>
                <option value="">Any</option>
                {['Permanent', 'Probation', 'Contractual', 'Intern'].map((j) => (
                  <option key={j} value={j}>
                    {j}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={!!Number(edit.is_active)} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked ? 1 : 0 })} /> Active
          </label>
          <div className="flex gap-2">
            <button type="button" className={btnGhost} onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button type="button" className={btnPrimary} onClick={save}>
              <Save className="w-3.5 h-3.5" /> Save Rule
            </button>
          </div>
        </div>
      )}
      {list.length === 0 && !edit ? (
        <p className="text-sm text-slate-400 text-center py-10">No rules yet.</p>
      ) : (
        <div className="space-y-2">
          {list.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {p.name} {!Number(p.is_active) && <span className="text-[11px] text-slate-400">(inactive)</span>}
                </div>
                <div className="text-[11px] text-slate-500">
                  {p.basis === 'anniversary' ? 'Joining anniversary' : `Every ${MONTHS[(p.fixed_month || 1) - 1]}`} · after {p.min_service_months} months · {p.default_percent}%
                  {p.department_id ? ` · ${meta.departments.find((d) => d.id === Number(p.department_id))?.name || 'Department'}` : ''}
                  {p.grade ? ` · Grade ${p.grade}` : ''}
                  {p.job_base ? ` · ${p.job_base}` : ''}
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" className={btnGhost} onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="text-[11px] text-rose-500 px-2"
                  onClick={async () => {
                    if (!window.confirm(`Delete rule "${p.name}"?`)) return;
                    await api.del(`/api/hr-ops/increment-policies/${p.id}`);
                    load();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const HrOpsSettings: React.FC<{ token: string; meta: HrOpsMeta; initialSection?: Section; onMetaChanged: () => void }> = ({ token, meta, initialSection, onMetaChanged }) => {
  const [section, setSection] = useState<Section>(initialSection || 'approvals');
  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'approvals', label: 'Approval Chains' },
    { key: 'templates', label: 'Letter Templates' },
    { key: 'onboarding', label: 'Onboarding Checklist' },
    { key: 'increments', label: 'Increment Rules' },
    { key: 'company', label: 'Company & Letter No.' }
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${section === s.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'company' && <CompanySettings token={token} meta={meta} onSaved={onMetaChanged} />}
      {section === 'approvals' && <ApprovalChains token={token} meta={meta} />}
      {section === 'templates' && <Templates token={token} meta={meta} />}
      {section === 'onboarding' && <OnboardingTasks token={token} />}
      {section === 'increments' && <IncrementRules token={token} meta={meta} />}
    </div>
  );
};
