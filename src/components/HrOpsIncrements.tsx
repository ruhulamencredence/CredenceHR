/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Increments": pick one of HR's own increment rules
// (Settings -> Increment Rules — joining anniversary or a fixed month,
// optionally for one Department/Grade/Job Base) and a date window, review
// who is due with their current gross, adjust each % or amount, and turn the
// ticked rows into Increment actions in one go (each still goes through the
// approval chain).

import React, { useEffect, useState } from 'react';
import { TrendingUp, Send } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Notice, Badge, fmtDate, taka, inputCls, labelCls, btnPrimary, type HrOpsMeta } from './HrOpsShared';

interface Policy {
  id: number;
  name: string;
  basis: 'anniversary' | 'fixed_month';
  fixed_month: number | null;
  min_service_months: number;
  default_percent: number;
  is_active: number;
}
interface DueRow {
  employee_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  grade: string | null;
  joining_date: string;
  last_increment: string | null;
  due_date: string;
  overdue: boolean;
  current_gross: number | null;
  percent: number;
  new_gross: number | null;
  pending_action_id: number | null;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const HrOpsIncrements: React.FC<{ token: string; meta: HrOpsMeta; onGoSettings: () => void; onCreated: () => void }> = ({ token, onGoSettings, onCreated }) => {
  const api = useHrApi(token);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState<number | ''>('');
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(() => {
    const d = new Date(now.getFullYear(), now.getMonth() + 3, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [rows, setRows] = useState<(DueRow & { selected: boolean; pct: string; gross: string; eff: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState('Annual increment');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api
      .get<Policy[]>('/api/hr-ops/increment-policies')
      .then((p) => {
        setPolicies(p);
        const active = p.find((x) => Number(x.is_active));
        if (active) setPolicyId(active.id);
      })
      .catch(() => setPolicies([]));
  }, [api]);

  const load = async () => {
    if (!policyId) return;
    setLoading(true);
    try {
      const r = await api.get<{ rows: DueRow[] }>(`/api/hr-ops/increments/due?policy_id=${policyId}&from=${from}&to=${to}`);
      setRows(
        r.rows.map((x) => ({
          ...x,
          selected: !x.pending_action_id && !!x.current_gross,
          pct: String(x.percent),
          gross: x.new_gross != null ? String(x.new_gross) : '',
          eff: x.due_date < from ? from : x.due_date
        }))
      );
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyId, from, to]);

  const patch = (i: number, p: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const selected = rows.filter((r) => r.selected && r.gross);
  const totalIncrease = selected.reduce((s, r) => s + (Number(r.gross) - Number(r.current_gross || 0)), 0);

  const submit = async () => {
    if (selected.length === 0) return;
    setSaving(true);
    try {
      const r = await api.post<any>('/api/hr-ops/actions/bulk', {
        action_type: 'increment',
        reason,
        items: selected.map((x) => ({ employee_id: x.employee_id, effective_date: x.eff, new_gross: Number(x.gross) }))
      });
      setMsg({
        type: r.errors?.length ? 'error' : 'success',
        text: `${r.created} increment action(s) created and sent for approval.${r.errors?.length ? ' Some failed: ' + r.errors.map((e: any) => e.error).join('; ') : ''}`
      });
      onCreated();
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  if (policies.length === 0) {
    return (
      <div className="text-center py-14 text-sm text-slate-500 space-y-3">
        <TrendingUp className="w-9 h-9 mx-auto text-slate-300" />
        <p>No increment rule yet. Create one — e.g. "Annual increment on each employee's joining anniversary, 8%", or "Everyone in January".</p>
        <button type="button" className={btnPrimary} onClick={onGoSettings}>
          Create Increment Rule
        </button>
      </div>
    );
  }
  const pol = policies.find((p) => p.id === policyId);

  return (
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelCls}>Increment rule</label>
          <select value={policyId} onChange={(e) => setPolicyId(Number(e.target.value))} className={inputCls}>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {Number(p.is_active) ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Due from</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>to</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </div>
        {pol && (
          <p className="text-[11px] text-slate-500 pb-2">
            {pol.basis === 'anniversary' ? 'On each joining anniversary' : `Every ${MONTH_NAMES[(pol.fixed_month || 1) - 1]}`} · after {pol.min_service_months} months of service · suggested {pol.default_percent}%
          </p>
        )}
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner size={16} /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-12">Nobody is due under this rule in this window.</p>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2">
                    <input type="checkbox" checked={rows.every((r) => r.selected || r.pending_action_id)} onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, selected: !r.pending_action_id && e.target.checked })))} />
                  </th>
                  {['Employee', 'Joined', 'Last Increment', 'Due', 'Current Gross', '%', 'New Gross', 'Effective'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={r.employee_id} className={r.pending_action_id ? 'opacity-60' : ''}>
                    <td className="px-3 py-2">
                      <input type="checkbox" disabled={!!r.pending_action_id || !r.current_gross} checked={r.selected} onChange={(e) => patch(i, { selected: e.target.checked })} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{r.name}</div>
                      <div className="text-[11px] text-slate-400">{[r.employee_code, r.designation, r.grade].filter(Boolean).join(' · ')}</div>
                      {r.pending_action_id && <Badge tone="pending">Increment already pending</Badge>}
                      {!r.current_gross && <span className="text-[10px] text-rose-500">No salary set in Payroll</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.joining_date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.last_increment)}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${r.overdue ? 'text-rose-600 font-semibold' : ''}`}>{fmtDate(r.due_date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{taka(r.current_gross)}</td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.1"
                        value={r.pct}
                        disabled={!r.current_gross}
                        onChange={(e) => patch(i, { pct: e.target.value, gross: r.current_gross ? String(Math.round(r.current_gross * (1 + Number(e.target.value || 0) / 100))) : r.gross })}
                        className="w-16 text-xs px-2 py-1 border border-slate-200 rounded-md"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={r.gross}
                        disabled={!r.current_gross}
                        onChange={(e) => patch(i, { gross: e.target.value, pct: r.current_gross ? (((Number(e.target.value) - r.current_gross) / r.current_gross) * 100).toFixed(2) : r.pct })}
                        className="w-24 text-xs px-2 py-1 border border-slate-200 rounded-md"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input type="date" value={r.eff} onChange={(e) => patch(i, { eff: e.target.value })} className="text-xs px-2 py-1 border border-slate-200 rounded-md" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex-1 min-w-[240px] max-w-md">
              <label className={labelCls}>Reason (shown to approvers)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500">
                {selected.length} selected · adds {taka(totalIncrease)} / month
              </div>
              <button type="button" className={`${btnPrimary} mt-1`} disabled={saving || selected.length === 0} onClick={submit}>
                {saving ? <Spinner size={14} /> : <Send className="w-3.5 h-3.5" />} Create {selected.length} Increment Action(s)
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
