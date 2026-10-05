/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Save, Plus, Edit2, Trash2, X, Check, AlertTriangle, CalendarClock, Banknote, Receipt, History, Lock, ShieldAlert } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { BillClaimCategory, BillClaimPolicyDef, BillClaimPolicyValues } from '../types';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';

// Admin Panel -> HRM -> Claims/Bill/Disbursement -> Bill Claim Policy.
// The rules list is drawn from what the server sends (GET /api/bill-claim-policy
// -> defs), so a rule added in BillClaimPolicy.ts appears here by itself. The
// Superadmin changes values and categories; Bill Claim module holders see them.

const GROUPS: { key: BillClaimPolicyDef['group']; title: string; icon: React.ElementType }[] = [
  { key: 'dates', title: 'Bill dates', icon: CalendarClock },
  { key: 'amounts', title: 'Amounts & receipts', icon: Banknote },
  { key: 'claim', title: 'Claim', icon: Receipt }
];

interface CategoryDraft {
  name: string;
  description: string;
  max_per_bill: string;
  monthly_limit: string;
  receipt_required: boolean;
  is_active: boolean;
  sort_order: string;
}
const emptyDraft: CategoryDraft = { name: '', description: '', max_per_bill: '', monthly_limit: '', receipt_required: false, is_active: true, sort_order: '' };
const toDraft = (c: BillClaimCategory): CategoryDraft => ({
  name: c.name,
  description: c.description || '',
  max_per_bill: c.max_per_bill != null ? String(c.max_per_bill) : '',
  monthly_limit: c.monthly_limit != null ? String(c.monthly_limit) : '',
  receipt_required: c.receipt_required,
  is_active: c.is_active,
  sort_order: String(c.sort_order)
});
// ---- Change History (read only; see bill_claim_policy_history in BillClaimPolicy.ts) ----
interface HistoryRow {
  id: number;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  target_name: string | null;
  before: any;
  after: any;
  ip: string | null;
  created_at: string;
  hash: string;
}
const ACTION_LABEL: Record<string, string> = {
  rules_changed: 'Rules changed',
  category_added: 'Category added',
  category_changed: 'Category changed',
  category_deleted: 'Category deleted',
  categories_seeded: 'Starting categories created',
  denied: 'Refused (no permission)'
};
const ACTION_TONE: Record<string, string> = {
  rules_changed: 'bg-blue-50 text-blue-700',
  category_added: 'bg-emerald-50 text-emerald-700',
  category_changed: 'bg-amber-50 text-amber-700',
  category_deleted: 'bg-rose-50 text-rose-700',
  categories_seeded: 'bg-slate-100 text-slate-600',
  denied: 'bg-rose-100 text-rose-800'
};
const CATEGORY_FIELDS: [string, string][] = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['max_per_bill', 'Max per bill'],
  ['monthly_limit', 'Monthly limit'],
  ['receipt_required', 'Receipt'],
  ['is_active', 'Active'],
  ['sort_order', 'Order']
];
const show = (v: any) => (v === true ? 'On' : v === false ? 'Off' : v == null || v === '' ? '—' : String(v));

// "field: old → new" lines for one history row.
function historyChanges(r: HistoryRow, defs: BillClaimPolicyDef[]): string[] {
  if (r.action === 'rules_changed') {
    return Object.keys(r.after || {}).map((k) => `${defs.find((d) => d.key === k)?.label || k}: ${show(r.before?.[k])} → ${show(r.after?.[k])}`);
  }
  if (r.action === 'category_changed') {
    const out = CATEGORY_FIELDS.filter(([k]) => show(r.before?.[k]) !== show(r.after?.[k])).map(([k, l]) => `${l}: ${show(r.before?.[k])} → ${show(r.after?.[k])}`);
    return out.length ? out : ['Saved without changes'];
  }
  if (r.action === 'category_added') {
    return CATEGORY_FIELDS.filter(([k]) => k !== 'name' && r.after?.[k] != null && r.after?.[k] !== '').map(([k, l]) => `${l}: ${show(r.after[k])}`);
  }
  if (r.action === 'categories_seeded') return [(Array.isArray(r.after) ? r.after.map((c: any) => c.name) : []).join(', ')];
  if (r.action === 'denied' && r.after) {
    const v = r.after.values;
    if (v) return Object.keys(v).map((k) => `Tried ${defs.find((d) => d.key === k)?.label || k}: ${show(v[k])}`);
    if (r.after.name) return [`Tried name: ${r.after.name}`];
  }
  return [];
}

const ChangeHistory: React.FC<{ token: string; defs: BillClaimPolicyDef[]; refreshKey: number }> = ({ token, defs, refreshKey }) => {
  const headers = { Authorization: `Bearer ${token}` };
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [check, setCheck] = useState<{ ok: boolean; checked: number; broken_at: number | null; db_guard: boolean } | null>(null);
  const [err, setErr] = useState('');

  const loadPage = async (beforeId?: number) => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/bill-claim-policy/history?limit=50${beforeId ? `&before_id=${beforeId}` : ''}`), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the history.');
      setRows((prev) => (beforeId ? [...prev, ...data.rows] : data.rows));
      setHasMore(!!data.has_more);
      if (!beforeId) {
        const v = await fetch(apiUrl('/api/bill-claim-policy/history/verify'), { headers });
        if (v.ok) setCheck(await v.json());
      }
      setErr('');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    loadPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshKey]);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <History className="w-4 h-4 text-blue-600" /> Change History
          </h3>
          <p className="text-[11px] text-slate-500">Every change and every refused attempt, by anyone. Nobody can edit or delete this history.</p>
        </div>
        {check &&
          (check.ok ? (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700"
              title={check.db_guard ? 'The database refuses any edit or delete of history rows.' : 'Database lock not installed — see the server log. The chain check still catches tampering.'}
            >
              <Lock className="w-3.5 h-3.5" /> Verified · {check.checked} entries{check.db_guard ? ' · database lock on' : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-rose-100 text-rose-800">
              <ShieldAlert className="w-3.5 h-3.5" /> History was altered outside the app at entry #{check.broken_at}
            </span>
          ))}
      </div>
      {check && !check.ok && (
        <div className="px-5 py-2.5 text-xs bg-rose-50 text-rose-800 border-b border-rose-100">
          Entry #{check.broken_at} (or the one before it) was changed or removed directly in the database. Entries from there on can't be trusted as shown.
        </div>
      )}
      {err && <div className="px-5 py-2.5 text-xs text-rose-700">{err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <thead className="bg-blue-50 text-slate-700">
            <tr>
              <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-12">#</th>
              <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-36">When</th>
              <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-40">Who</th>
              <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-44">What</th>
              <th className="px-2 py-2 border border-slate-200 text-left font-semibold">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-400 border border-slate-200">
                  No changes yet.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const lines = historyChanges(r, defs);
              const broken = check && !check.ok && check.broken_at != null && r.id >= check.broken_at;
              return (
                <tr key={r.id} className={`odd:bg-white even:bg-slate-50/70 align-top ${broken ? 'bg-rose-50/60' : ''}`}>
                  <td className="px-2 py-1.5 border border-slate-200 text-slate-400 tabular-nums" title={`Hash ${r.hash}…`}>
                    {r.id}
                  </td>
                  <td className="px-2 py-1.5 border border-slate-200 whitespace-nowrap text-slate-700">
                    {new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-2 py-1.5 border border-slate-200">
                    <div className="font-medium text-slate-800">{r.actor_name || '—'}</div>
                    <div className="text-[10px] text-slate-400 capitalize">
                      {r.actor_role || ''}
                      {r.ip ? ` · ${r.ip}` : ''}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 border border-slate-200">
                    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${ACTION_TONE[r.action] || 'bg-slate-100 text-slate-600'}`}>
                      {ACTION_LABEL[r.action] || r.action}
                    </span>
                    {r.target_name && <div className="text-[11px] text-slate-700 mt-1 break-words">{r.target_name}</div>}
                  </td>
                  <td className="px-2 py-1.5 border border-slate-200 text-slate-600">
                    {lines.length ? (
                      <ul className="space-y-0.5">
                        {lines.map((l, i) => (
                          <li key={i} className="break-words">
                            {l}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-5 py-2.5 flex items-center justify-between text-xs text-slate-500">
        <span>{rows.length} shown</span>
        {loading ? (
          <Spinner size={14} />
        ) : (
          hasMore && (
            <button type="button" onClick={() => loadPage(rows[rows.length - 1]?.id)} className="font-semibold text-blue-600 hover:text-blue-800">
              Show older
            </button>
          )
        )}
      </div>
    </div>
  );
};

const money = (n: number | null) => (n == null ? '—' : `৳${n.toLocaleString('en-BD', { maximumFractionDigits: 2 })}`);
const inputCls =
  'w-full text-xs px-2 py-1.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';

export const BillClaimPolicyPanel: React.FC<{ token: string }> = ({ token }) => {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [defs, setDefs] = useState<BillClaimPolicyDef[]>([]);
  const [saved, setSaved] = useState<BillClaimPolicyValues>({});
  const [values, setValues] = useState<BillClaimPolicyValues>({});
  const [categories, setCategories] = useState<BillClaimCategory[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  // Category being edited: an id, 'new', or null.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(emptyDraft);
  const [savingCategory, setSavingCategory] = useState(false);

  const load = async () => {
    try {
      const res = await fetch(apiUrl('/api/bill-claim-policy'), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the Bill Claim Policy.');
      setDefs(data.defs);
      setSaved(data.values);
      setValues(data.values);
      setCategories(data.categories);
      setCanEdit(!!data.can_edit);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dirty = useMemo(() => defs.some((d) => values[d.key] !== saved[d.key]), [defs, values, saved]);
  const [historyKey, setHistoryKey] = useState(0);
  const flash = (msg: string) => {
    setHistoryKey((k) => k + 1);
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

  const saveRules = async () => {
    setSavingRules(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/bill-claim-policy'), { method: 'PUT', headers, body: JSON.stringify({ values }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');
      setSaved(data.values);
      setValues(data.values);
      flash('Rules saved — they apply to every claim filed from now on.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingRules(false);
    }
  };

  const startEdit = (target: number | 'new') => {
    setEditing(target);
    setError('');
    const c = typeof target === 'number' ? categories.find((x) => x.id === target) : undefined;
    setDraft(c ? toDraft(c) : emptyDraft);
  };

  const saveCategory = async () => {
    if (!draft.name.trim()) {
      setError('Enter the category name.');
      return;
    }
    setSavingCategory(true);
    setError('');
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        max_per_bill: draft.max_per_bill === '' ? null : Number(draft.max_per_bill),
        monthly_limit: draft.monthly_limit === '' ? null : Number(draft.monthly_limit),
        receipt_required: draft.receipt_required,
        is_active: draft.is_active,
        ...(draft.sort_order !== '' ? { sort_order: Number(draft.sort_order) } : {})
      };
      const isNew = editing === 'new';
      const res = await fetch(apiUrl(isNew ? '/api/bill-claim-categories' : `/api/bill-claim-categories/${editing}`), {
        method: isNew ? 'POST' : 'PUT',
        headers,
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the category.');
      setEditing(null);
      await load();
      flash(isNew ? 'Category added.' : 'Category saved. Claims already filed keep the name they were filed under.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingCategory(false);
    }
  };

  const deleteCategory = async (c: BillClaimCategory) => {
    if (!(await confirmDialog(`Delete "${c.name}"?\n\nIt won't be offered on new claims. Claims already filed keep it as it is.`))) return;
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/bill-claim-categories/${c.id}`), { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete the category.');
      await load();
      flash(`"${c.name}" deleted.`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 p-10 justify-center">
        <Spinner size={16} /> Loading Bill Claim Policy…
      </div>
    );
  }

  const categoryRow = (
    <tr className="bg-blue-50/40">
      <td className="px-2 py-1.5 border border-slate-200">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Food" aria-label="Category name" className={inputCls} autoFocus />
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Description (optional)"
          aria-label="Category description"
          className={`${inputCls} mt-1`}
        />
      </td>
      <td className="px-2 py-1.5 border border-slate-200">
        <input type="number" min="0" step="0.01" value={draft.max_per_bill} onChange={(e) => setDraft({ ...draft, max_per_bill: e.target.value })} placeholder="No limit" aria-label="Max per bill" className={inputCls} />
      </td>
      <td className="px-2 py-1.5 border border-slate-200">
        <input type="number" min="0" step="0.01" value={draft.monthly_limit} onChange={(e) => setDraft({ ...draft, monthly_limit: e.target.value })} placeholder="No limit" aria-label="Monthly limit" className={inputCls} />
      </td>
      <td className="px-2 py-1.5 border border-slate-200 text-center">
        <input type="checkbox" checked={draft.receipt_required} onChange={(e) => setDraft({ ...draft, receipt_required: e.target.checked })} aria-label="Receipt required" className="w-4 h-4 accent-blue-600" />
      </td>
      <td className="px-2 py-1.5 border border-slate-200 text-center">
        <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} aria-label="Active" className="w-4 h-4 accent-blue-600" />
      </td>
      <td className="px-2 py-1.5 border border-slate-200">
        <input type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} placeholder="Last" aria-label="Order" className={inputCls} />
      </td>
      <td className="px-2 py-1.5 border border-slate-200">
        <div className="flex items-center justify-center gap-1">
          <button type="button" onClick={saveCategory} disabled={savingCategory} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg disabled:opacity-50" aria-label="Save category">
            {savingCategory ? <Spinner size={14} /> : <Check className="w-4 h-4" />}
          </button>
          <button type="button" onClick={() => setEditing(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg" aria-label="Cancel">
            <X className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">Bill Claim Policy</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Rules every Conveyance Bill Claim is checked against when it's filed, and the bill categories employees choose from.
            {!canEdit && ' Only the Superadmin can change them.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}
      {notice && <div className="text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}

      {/* Rules */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">Rules</h3>
          {canEdit && (
            <button
              type="button"
              onClick={saveRules}
              disabled={!dirty || savingRules}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-40"
            >
              {savingRules ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />} Save rules
            </button>
          )}
        </div>
        <div className="divide-y divide-slate-100">
          {GROUPS.map((g) => {
            const list = defs.filter((d) => d.group === g.key);
            if (!list.length) return null;
            const Icon = g.icon;
            return (
              <div key={g.key} className="px-5 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2 flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" /> {g.title}
                </div>
                <div className="space-y-3">
                  {list.map((d) => (
                    <div key={d.key} className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800">{d.label}</div>
                        <p className="text-[11px] text-slate-500 mt-0.5">{d.help}</p>
                      </div>
                      {d.type === 'boolean' ? (
                        <label className="inline-flex items-center gap-2 shrink-0 mt-0.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!values[d.key]}
                            disabled={!canEdit}
                            onChange={(e) => setValues({ ...values, [d.key]: e.target.checked })}
                            aria-label={d.label}
                            className="w-4 h-4 accent-blue-600"
                          />
                          <span className="text-xs text-slate-600 w-6">{values[d.key] ? 'On' : 'Off'}</span>
                        </label>
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <input
                            type="number"
                            value={String(values[d.key] ?? '')}
                            min={d.min}
                            max={d.max}
                            disabled={!canEdit}
                            onChange={(e) => setValues({ ...values, [d.key]: e.target.value === '' ? '' as any : Number(e.target.value) })}
                            aria-label={d.label}
                            className="w-24 text-sm px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-right focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:bg-slate-50"
                          />
                          {d.unit && <span className="text-xs text-slate-500 w-10">{d.unit}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Categories */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Bill categories</h3>
            <p className="text-[11px] text-slate-500">Renaming or deleting a category never changes claims already filed.</p>
          </div>
          {canEdit && editing === null && (
            <button
              type="button"
              onClick={() => startEdit('new')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" /> Add category
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead className="bg-blue-50 text-slate-700">
              <tr>
                <th className="px-2 py-2 border border-slate-200 text-left font-semibold">Category</th>
                <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-28">Max per bill</th>
                <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-28">Monthly limit</th>
                <th className="px-2 py-2 border border-slate-200 text-center font-semibold w-20">Receipt</th>
                <th className="px-2 py-2 border border-slate-200 text-center font-semibold w-16">Active</th>
                <th className="px-2 py-2 border border-slate-200 text-left font-semibold w-16">Order</th>
                <th className="px-2 py-2 border border-slate-200 text-center font-semibold w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) =>
                editing === c.id ? (
                  <React.Fragment key={c.id}>{categoryRow}</React.Fragment>
                ) : (
                  <tr key={c.id} className={`odd:bg-white even:bg-slate-50/70 ${c.is_active ? '' : 'text-slate-400'}`}>
                    <td className="px-2 py-1.5 border border-slate-200">
                      <div className={`font-medium ${c.is_active ? 'text-slate-900' : ''}`}>{c.name}</div>
                      {c.description && <div className="text-[11px] text-slate-500">{c.description}</div>}
                    </td>
                    <td className="px-2 py-1.5 border border-slate-200 tabular-nums">{money(c.max_per_bill)}</td>
                    <td className="px-2 py-1.5 border border-slate-200 tabular-nums">{money(c.monthly_limit)}</td>
                    <td className="px-2 py-1.5 border border-slate-200 text-center">{c.receipt_required ? 'Needed' : '—'}</td>
                    <td className="px-2 py-1.5 border border-slate-200 text-center">{c.is_active ? 'Yes' : 'No'}</td>
                    <td className="px-2 py-1.5 border border-slate-200 tabular-nums">{c.sort_order}</td>
                    <td className="px-2 py-1.5 border border-slate-200">
                      {canEdit && editing === null && (
                        <div className="flex items-center justify-center gap-1">
                          <button type="button" onClick={() => startEdit(c.id)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg" aria-label={`Edit ${c.name}`}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => deleteCategory(c)} className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg" aria-label={`Delete ${c.name}`}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              )}
              {editing === 'new' && categoryRow}
            </tbody>
          </table>
        </div>
      </div>

      <ChangeHistory token={token} defs={defs} refreshKey={historyKey} />
    </div>
  );
};
