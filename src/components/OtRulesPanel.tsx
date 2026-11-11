/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> OT Rules (OvertimeRoutes.ts, layer "ot_rules"): how overtime is
// paid and who approves it — all set here, nothing fixed in the code:
//   - how the hourly rate is worked out (labour law, fixed ৳ an hour, gross)
//   - the 30-minute rules, daily / monthly limits, office hours
//   - who approves OT (Team Supervisor / Roster manager / either / both in turn)
//   - a designation's or one person's own rate
//   - who gets OT at all
// Amounts in ৳ need "See salary amounts" to see or change.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Save, Search, Timer, Trash2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';
import { LoadingBlock } from './LoadingBlock';
import { APPROVER_MODE_LABEL } from '../lib/overtime';

type RateType = 'labour_law' | 'fixed' | 'gross';
interface Rules {
  rate_type: RateType;
  divisor: number;
  multiplier: number;
  off_multiplier: number;
  fixed_rate: number | string;
  fixed_off_rate: number | string;
  min_minutes: number;
  round_minutes: number;
  daily_max_minutes: number;
  monthly_max_minutes: number;
  only_approved: boolean;
  planned_counts_approved: boolean;
  approver_mode: string;
  office_start: string;
  office_end: string;
}
interface RateRow {
  id: number;
  designation: string | null;
  employee_id: number | null;
  employee_name: string | null;
  employee_code: string | null;
  rate_type: RateType;
  rate: number | string | null;
  off_rate: number | string | null;
}
interface Person {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  gets_ot: boolean;
}
interface Data {
  can_see_amounts: boolean;
  rules: Rules;
  rates: RateRow[];
  designations: string[];
  people: Person[];
}

const RATE_LABEL: Record<RateType, { title: string; hint: string }> = {
  labour_law: { title: 'Labour law', hint: 'Basic ÷ 208 × 2 an hour' },
  fixed: { title: 'Fixed an hour', hint: '৳ an hour, by designation or person' },
  gross: { title: 'Gross based', hint: 'Gross ÷ 208 × multiplier' }
};
const card = 'rounded-2xl bg-white border border-slate-200 p-4 sm:p-5';
const label = 'block text-[11px] font-semibold text-slate-600 mb-1';
const input = 'w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-200';
const sectionTitle = 'text-[11px] font-bold tracking-wider text-slate-500 uppercase mb-2';

async function api<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = ({ on, onChange, label: text, disabled }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={text} disabled={disabled} onClick={() => onChange(!on)} className="flex items-center gap-3 text-left disabled:opacity-50">
    <span className={`w-10 h-6 rounded-full relative shrink-0 transition ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}>
      <span className={`absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all ${on ? 'left-[19px]' : 'left-[3px]'}`} />
    </span>
    <span className="text-sm text-slate-700">{text}</span>
  </button>
);

export const OtRulesPanel: React.FC<{ token: string }> = ({ token }) => {
  const [data, setData] = useState<Data | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [exampleBasic, setExampleBasic] = useState('12000');

  const load = useCallback(async () => {
    try {
      setError('');
      const d = await api<Data>(token, '/api/ot/settings');
      setData(d);
      setRules(d.rules);
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setRules((r) => (r ? { ...r, [k]: v } : r));
  const amounts = !!data?.can_see_amounts;

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setError('');
    try {
      await api(token, '/api/ot/settings', {
        method: 'PUT',
        body: {
          ...rules,
          ...(amounts ? {} : { fixed_rate: undefined, fixed_off_rate: undefined })
        }
      });
      setNotice('OT rules saved.');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ---- own rates ----
  const [rateFor, setRateFor] = useState<'designation' | 'person'>('designation');
  const [rateTarget, setRateTarget] = useState('');
  const [rateType, setRateType] = useState<RateType>('fixed');
  const [rate, setRate] = useState('');
  const [offRate, setOffRate] = useState('');
  const addRate = async () => {
    setError('');
    try {
      await api(token, '/api/ot/rates', {
        method: 'POST',
        body: {
          ...(rateFor === 'person' ? { employee_id: Number(rateTarget) } : { designation: rateTarget }),
          rate_type: rateType,
          rate,
          off_rate: offRate
        }
      });
      setRateTarget('');
      setRate('');
      setOffRate('');
      setNotice('Rate saved.');
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const removeRate = async (r: RateRow) => {
    if (!(await confirmDialog(`Remove the own rate for ${r.designation || r.employee_name}? They go back to the rule above.`, { confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(token, `/api/ot/rates/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ---- who gets OT ----
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [desig, setDesig] = useState('');
  const people = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.people || []).filter((p) => (!onlyOn || p.gets_ot) && (!t || [p.name, p.employee_code, p.designation, p.department].some((x) => (x || '').toLowerCase().includes(t))));
  }, [data, q, onlyOn]);
  const onCount = (data?.people || []).filter((p) => p.gets_ot).length;
  const setGetsOt = async (body: any, msg: string) => {
    setError('');
    try {
      const r = await api<{ changed: number }>(token, '/api/ot/gets-ot', { method: 'PUT', body });
      setNotice(`${msg} (${r.changed}).`);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!data || !rules) return error ? <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div> : <LoadingBlock />;

  const basic = Number(exampleBasic) || 0;
  const perHour = rules.divisor > 0 ? basic / rules.divisor : 0;
  const exRate = rules.rate_type === 'fixed' ? Number(rules.fixed_rate) || 0 : perHour * rules.multiplier;
  const money = (n: number) => `৳ ${n.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const hoursField = (k: 'min_minutes' | 'round_minutes' | 'daily_max_minutes' | 'monthly_max_minutes', text: string, unit: 'min' | 'h') => (
    <div>
      <label className={label} htmlFor={`ot-${k}`}>{text}</label>
      <div className="relative">
        <input
          id={`ot-${k}`}
          type="number"
          min={0}
          className={`${input} pr-10`}
          value={unit === 'h' ? Math.round((rules[k] / 60) * 100) / 100 : rules[k]}
          onChange={(e) => set(k, Math.round((Number(e.target.value) || 0) * (unit === 'h' ? 60 : 1)))}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem] gap-4 items-start">
        <section className={card}>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 mb-1">
            <Timer className="w-5 h-5 text-orange-600" /> Overtime rules
          </h3>
          <p className="text-xs text-slate-500 mb-4">Used for everyone who gets OT. A designation or a person can have its own rate (below).</p>

          <div className={sectionTitle}>How the hourly rate is worked out</div>
          <div className="grid sm:grid-cols-3 gap-2 mb-4" role="radiogroup" aria-label="Rate type">
            {(Object.keys(RATE_LABEL) as RateType[]).map((t) => (
              <label key={t} className={`rounded-2xl px-3 py-2.5 cursor-pointer border ${rules.rate_type === t ? 'border-orange-500 bg-orange-50 border-2' : 'border-slate-200'}`}>
                <span className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <input type="radio" name="ot-rate-type" className="accent-orange-600" checked={rules.rate_type === t} onChange={() => set('rate_type', t)} />
                  {RATE_LABEL[t].title}
                </span>
                <span className="block text-[11px] text-slate-500 mt-0.5 pl-5">{RATE_LABEL[t].hint}</span>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            {rules.rate_type !== 'fixed' ? (
              <>
                <div>
                  <label className={label} htmlFor="ot-divisor">Divide by (hours a month)</label>
                  <input id="ot-divisor" type="number" min={1} className={input} value={rules.divisor} onChange={(e) => set('divisor', Number(e.target.value))} />
                </div>
                <div>
                  <label className={label} htmlFor="ot-mult">Working-day multiplier</label>
                  <input id="ot-mult" type="number" step="0.25" min={0} className={input} value={rules.multiplier} onChange={(e) => set('multiplier', Number(e.target.value))} />
                </div>
                <div>
                  <label className={label} htmlFor="ot-offmult">Off day / holiday multiplier</label>
                  <input id="ot-offmult" type="number" step="0.25" min={0} className={input} value={rules.off_multiplier} onChange={(e) => set('off_multiplier', Number(e.target.value))} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className={label} htmlFor="ot-fixed">৳ an hour</label>
                  <input id="ot-fixed" className={input} disabled={!amounts} value={String(rules.fixed_rate)} onChange={(e) => set('fixed_rate', e.target.value)} />
                </div>
                <div>
                  <label className={label} htmlFor="ot-fixedoff">৳ an hour on an Off day</label>
                  <input id="ot-fixedoff" className={input} disabled={!amounts} value={String(rules.fixed_off_rate)} onChange={(e) => set('fixed_off_rate', e.target.value)} placeholder="Same" />
                </div>
                {!amounts && <p className="text-[11px] text-slate-500 self-end">Amounts need "See salary amounts".</p>}
              </>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {hoursField('min_minutes', 'Counts after', 'min')}
            {hoursField('round_minutes', 'Round down to', 'min')}
            {hoursField('daily_max_minutes', 'Most a working day', 'h')}
            {hoursField('monthly_max_minutes', 'Most a month (0 = no limit)', 'h')}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className={label} htmlFor="ot-start">Office day starts (no shift rostered)</label>
              <input id="ot-start" type="time" className={input} value={rules.office_start} onChange={(e) => set('office_start', e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="ot-end">Office day ends</label>
              <input id="ot-end" type="time" className={input} value={rules.office_end} onChange={(e) => set('office_end', e.target.value)} />
            </div>
          </div>
          <div className="space-y-2.5 mb-5">
            <Switch on={rules.only_approved} onChange={(v) => set('only_approved', v)} label="Only approved OT is paid (who approves: below)" />
            <Switch on={rules.planned_counts_approved} onChange={(v) => set('planned_counts_approved', v)} label="OT built into a shift or set in the roster in advance counts as approved" />
          </div>

          <div className={sectionTitle}>Who approves OT</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2" role="radiogroup" aria-label="Who approves OT">
            {Object.entries(APPROVER_MODE_LABEL).map(([k, text]) => (
              <label key={k} className={`rounded-2xl px-3 py-2.5 cursor-pointer border text-sm font-semibold flex items-center gap-2 ${rules.approver_mode === k ? 'border-orange-500 bg-orange-50 border-2' : 'border-slate-200'}`}>
                <input type="radio" name="ot-approver" className="accent-orange-600" checked={rules.approver_mode === k} onChange={() => set('approver_mode', k)} />
                {text}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mb-5">
            Team Supervisor = the person's Direct Supervisor (Employees → Supervisor) or their Site Attendance team's supervisor — only their own team. Roster manager = someone with Duty Roster → OT Approval for that department.
            Someone with no Team Supervisor goes to the Roster manager.
          </p>

          <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-orange-600 text-white text-sm font-bold hover:bg-orange-700 disabled:opacity-60">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save rules
          </button>
        </section>

        <aside className="space-y-4">
          <section className={card}>
            <div className="text-[11px] font-bold tracking-wider text-orange-700 uppercase mb-2">Worked example</div>
            {rules.rate_type === 'fixed' ? (
              <p className="text-sm text-slate-700">{amounts ? `Every hour pays ${money(Number(rules.fixed_rate) || 0)}.` : 'Fixed amount — shown with "See salary amounts".'}</p>
            ) : (
              <div className="space-y-1.5 text-sm">
                <label className="flex items-center justify-between gap-2">
                  <span className="text-slate-600">{rules.rate_type === 'gross' ? 'Gross' : 'Basic'} salary</span>
                  <input aria-label="Example salary" className="w-28 h-8 px-2 rounded-lg border border-slate-200 text-right" value={exampleBasic} onChange={(e) => setExampleBasic(e.target.value)} />
                </label>
                <div className="flex justify-between"><span className="text-slate-600">Per hour (÷ {rules.divisor})</span><b>{money(perHour)}</b></div>
                <div className="flex justify-between"><span className="text-slate-600">OT an hour (× {rules.multiplier})</span><b className="text-orange-700">{money(exRate)}</b></div>
                <div className="flex justify-between"><span className="text-slate-600">Off day an hour (× {rules.off_multiplier})</span><b>{money(perHour * rules.off_multiplier)}</b></div>
              </div>
            )}
          </section>
          <section className={card}>
            <div className="text-[11px] font-bold tracking-wider text-slate-500 uppercase mb-2">How a day is counted</div>
            <ol className="list-decimal pl-4 space-y-1 text-xs text-slate-600">
              <li>Worked time = first In to last Out (app check-in, office device or Site Attendance muster).</li>
              <li>Working day: time after the shift ends, plus a shift's built-in OT (Duty Roster → Shifts). Off day / holiday: all of it, at the Off day rate.</li>
              <li>Under {rules.min_minutes} min doesn't count; rounded down to {rules.round_minutes || 1} min.</li>
              <li>OT set in the roster in advance is approved by itself; the rest waits for approval.</li>
              <li>A night shift that ends next morning counts on the day it started.</li>
            </ol>
          </section>
        </aside>
      </div>

      <section className={card}>
        <div className={sectionTitle}>Own rate for a designation or a person — overrides the rule</div>
        {data.rates.length > 0 && (
          <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 mb-3">
            {data.rates.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1 min-w-0 truncate">
                  {r.designation ? <>Designation: <b>{r.designation}</b></> : <>Person: <b>{r.employee_name}</b>{r.employee_code ? ` · ${r.employee_code}` : ''}</>}
                </span>
                <span className="text-slate-700 whitespace-nowrap">
                  {r.rate_type === 'fixed' ? `৳ ${r.rate} / h · Off day ${r.off_rate ?? r.rate}` : RATE_LABEL[r.rate_type].title}
                </span>
                <button type="button" onClick={() => void removeRate(r)} className="p-1.5 rounded-lg hover:bg-rose-50 text-rose-600" aria-label={`Remove rate for ${r.designation || r.employee_name}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="grid sm:grid-cols-[8rem_minmax(0,1fr)_9rem_7rem_7rem_auto] gap-2 items-end">
          <div>
            <label className={label} htmlFor="ot-rate-for">For</label>
            <select id="ot-rate-for" className={input} value={rateFor} onChange={(e) => { setRateFor(e.target.value as any); setRateTarget(''); }}>
              <option value="designation">Designation</option>
              <option value="person">Person</option>
            </select>
          </div>
          <div>
            <label className={label}>{rateFor === 'designation' ? 'Designation' : 'Person'}</label>
            <SearchSelect className={input} value={rateTarget} onChange={(e) => setRateTarget(e.target.value)} aria-label={rateFor === 'designation' ? 'Designation' : 'Person'}>
              <option value="">{rateFor === 'designation' ? '— Select designation —' : '— Select employee —'}</option>
              {rateFor === 'designation'
                ? data.designations.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))
                : data.people.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {[p.name, p.employee_code, p.designation, p.department].filter(Boolean).join(' · ')}
                    </option>
                  ))}
            </SearchSelect>
          </div>
          <div>
            <label className={label} htmlFor="ot-rate-type">Rate</label>
            <select id="ot-rate-type" className={input} value={rateType} onChange={(e) => setRateType(e.target.value as RateType)}>
              <option value="fixed">Fixed ৳ an hour</option>
              <option value="labour_law">Labour law</option>
              <option value="gross">Gross based</option>
            </select>
          </div>
          {rateType === 'fixed' ? (
            <>
              <div>
                <label className={label} htmlFor="ot-rate">৳ / h</label>
                <input id="ot-rate" className={input} value={rate} onChange={(e) => setRate(e.target.value)} disabled={!amounts} />
              </div>
              <div>
                <label className={label} htmlFor="ot-offrate">Off day ৳ / h</label>
                <input id="ot-offrate" className={input} value={offRate} onChange={(e) => setOffRate(e.target.value)} disabled={!amounts} placeholder="Same" />
              </div>
            </>
          ) : (
            <div className="sm:col-span-2" />
          )}
          <button type="button" disabled={!rateTarget || (rateType === 'fixed' && (!amounts || !rate))} onClick={() => void addRate()} className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-40">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">A person's own rate wins over their designation's, which wins over the rule.</p>
      </section>

      <section className={card}>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div className={sectionTitle + ' mb-0'}>Who gets OT — {onCount} of {data.people.length}</div>
          <div className="flex items-center gap-2 flex-wrap">
            <SearchSelect className={`${input} w-56`} value={desig} onChange={(e) => setDesig(e.target.value)} aria-label="Designation">
              <option value="">— Select designation —</option>
              {data.designations.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </SearchSelect>
            <button type="button" disabled={!desig} onClick={() => void setGetsOt({ designation: desig, on: true }, `OT turned on for ${desig}`)} className="h-10 px-3 rounded-xl bg-emerald-600 text-white text-xs font-semibold disabled:opacity-40">
              Turn on for all
            </button>
            <button type="button" disabled={!desig} onClick={() => void setGetsOt({ designation: desig, on: false }, `OT turned off for ${desig}`)} className="h-10 px-3 rounded-xl bg-white border border-slate-200 text-xs font-semibold disabled:opacity-40">
              Turn off for all
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <div className="relative flex-1 min-w-[12rem] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Employee ID, designation, department…" aria-label="Search people" className={`${input} pl-9`} />
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" className="accent-orange-600" checked={onlyOn} onChange={(e) => setOnlyOn(e.target.checked)} /> Only those who get OT
          </label>
        </div>
        <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-[26rem] overflow-y-auto">
          {people.slice(0, 300).map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-slate-800 truncate">{p.name}</span>
                <span className="block text-[11px] text-slate-500 truncate">{[p.employee_code, p.designation, p.department].filter(Boolean).join(' · ')}</span>
              </span>
              <Switch on={p.gets_ot} onChange={(v) => void setGetsOt({ employee_ids: [p.id], on: v }, `${p.name}: OT ${v ? 'on' : 'off'}`)} label={`Gets OT: ${p.name}`} />
            </div>
          ))}
          {!people.length && <div className="px-3 py-6 text-center text-sm text-slate-500">Nobody matches.</div>}
          {people.length > 300 && <div className="px-3 py-2 text-center text-[11px] text-slate-500">Showing 300 of {people.length} — search to narrow.</div>}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">Someone without "Gets OT" still has extra time in reports, but it is never paid.</p>
      </section>
    </div>
  );
};
