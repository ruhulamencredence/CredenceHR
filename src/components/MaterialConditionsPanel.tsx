/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Condition Set -> "Material conditions" (MaterialConditionsRoutes.ts): name a
// group of materials (Description of Material — type to search, tick), give
// it its own minimum days' notice for the Delivery Date. "Auto-group"
// proposes groups from the material names; nothing is created until the
// Admin presses Create. The stricter of this and the Global / Project /
// Budget rule wins (deliveryDateConditions.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface Condition {
  id: number;
  name: string;
  min_lead_days: number;
  applies_entry: number;
  applies_job_edit: number;
  apply_to_admins: number;
  enabled: number;
  materials: string[];
}
interface MaterialHit {
  material: string;
  key: string;
  unit: string;
  budgets: number;
  condition: { id: number; name: string } | null;
}
interface Suggest {
  groups: { name: string; days: number; materials: MaterialHit[] }[];
  add_to_existing: { condition_id: number; name: string; materials: MaterialHit[] }[];
  ungrouped: MaterialHit[];
  free: number;
  total: number;
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] mr-1.5 mb-1.5';

export const MaterialConditionsPanel: React.FC<{ token: string }> = ({ token }) => {
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const [conds, setConds] = useState<Condition[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<Condition | 'new' | null>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(apiUrl(path), { ...init, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      return data;
    },
    [headers]
  );
  const load = useCallback(async () => {
    try {
      setConds(await call('/api/delivery-material-conditions'));
    } catch (e: any) {
      setConds([]);
      setMsg({ ok: false, text: e.message });
    }
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadSuggest = async () => {
    setSuggesting(true);
    try {
      setSuggest(await call('/api/delivery-material-conditions/suggest'));
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setSuggesting(false);
    }
  };

  const save = async (body: any, id?: number) => {
    await call(id ? `/api/delivery-material-conditions/${id}` : '/api/delivery-material-conditions', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    await load();
    if (suggest) await loadSuggest();
  };
  const toggle = async (c: Condition) => {
    try {
      await call(`/api/delivery-material-conditions/${c.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !c.enabled }) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };
  const remove = async (c: Condition) => {
    if (!(await confirmDialog(`Delete the material condition "${c.name}"? Its ${c.materials.length} material(s) go back to the general rule.`, { tone: 'danger' }))) return;
    try {
      await call(`/api/delivery-material-conditions/${c.id}`, { method: 'DELETE' });
      setMsg({ ok: true, text: `"${c.name}" deleted.` });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[220px]">
            <h4 className="text-sm font-bold text-slate-900">Material conditions</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Pick materials (Description of Material), name the group and give it its own minimum days' notice for the Delivery Date. Where the
              general rule also applies, the stricter one (more days) wins.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSuggest()}
            disabled={suggesting}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-[color:var(--g-accent-soft,#f3e8ff)] text-[color:var(--g-accent,#7F00FF)] disabled:opacity-60"
          >
            {suggesting ? <Spinner size={14} /> : <Sparkles className="w-4 h-4" />} Auto-group materials
          </button>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl text-white"
            style={{ background: 'var(--g-accent, #7F00FF)' }}
          >
            <Plus className="w-4 h-4" /> New condition
          </button>
        </div>

        {msg && <p className={`mt-3 text-xs px-3 py-2 rounded-xl ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</p>}

        <div className="mt-3 overflow-x-auto">
          {conds === null ? (
            <div className="py-6 flex justify-center">
              <Spinner size={18} />
            </div>
          ) : conds.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">No material conditions yet — add one, or let Auto-group suggest some.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50">
                <tr>
                  <th className="px-3 py-2">Condition</th>
                  <th className="px-3 py-2">Materials</th>
                  <th className="px-3 py-2">Min. notice</th>
                  <th className="px-3 py-2">Applies to</th>
                  <th className="px-3 py-2">Admins too</th>
                  <th className="px-3 py-2">On</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {conds.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2.5 font-semibold text-slate-900">{c.name}</td>
                    <td className="px-3 py-2.5 max-w-[460px]">
                      {c.materials.slice(0, 8).map((m) => (
                        <span key={m} className={`${chip} bg-slate-100 text-slate-700`}>
                          {m}
                        </span>
                      ))}
                      {c.materials.length > 8 && <span className="text-xs text-slate-500">+{c.materials.length - 8} more</span>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <b>{c.min_lead_days}</b> <span className="text-xs text-slate-500">days</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{[c.applies_entry ? 'New entry / Add MPR' : null, c.applies_job_edit ? 'Job edit' : null].filter(Boolean).join(' · ')}</td>
                    <td className="px-3 py-2.5 text-xs">{c.apply_to_admins ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!!c.enabled}
                        aria-label={`${c.name} on`}
                        onClick={() => void toggle(c)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${c.enabled ? '' : 'bg-slate-300'}`}
                        style={c.enabled ? { background: 'var(--g-accent, #7F00FF)' } : undefined}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${c.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <button type="button" onClick={() => setEditing(c)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100" aria-label={`Edit ${c.name}`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => void remove(c)} className="p-1.5 rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600" aria-label={`Delete ${c.name}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {suggest && (
        <SuggestCard
          data={suggest}
          onClose={() => setSuggest(null)}
          onCreate={async (g) => {
            try {
              await save({ name: g.name, min_lead_days: g.days, materials: g.materials, applies_entry: true, applies_job_edit: true, apply_to_admins: false, enabled: true });
              setMsg({ ok: true, text: `"${g.name}" created with ${g.materials.length} material(s).` });
            } catch (e: any) {
              setMsg({ ok: false, text: e.message });
            }
          }}
          onAddTo={async (h) => {
            const c = conds?.find((x) => x.id === h.condition_id);
            if (!c) return;
            try {
              await save({ ...c, applies_entry: !!c.applies_entry, applies_job_edit: !!c.applies_job_edit, apply_to_admins: !!c.apply_to_admins, enabled: !!c.enabled, materials: [...c.materials, ...h.materials] }, c.id);
              setMsg({ ok: true, text: `${h.materials.length} material(s) added to "${c.name}".` });
            } catch (e: any) {
              setMsg({ ok: false, text: e.message });
            }
          }}
        />
      )}

      <p className="text-[11px] text-slate-500 px-1">
        A material is in one condition only — picking it in another moves it there. New materials from a Budget import that look like a condition's are shown
        under Auto-group ("add to …"); they are never added by themselves.
      </p>

      {editing && (
        <ConditionEditor
          token={token}
          cond={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await save(body, editing === 'new' ? undefined : editing.id);
            setMsg({ ok: true, text: editing === 'new' ? `"${body.name}" created.` : `"${body.name}" saved.` });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

const SuggestCard: React.FC<{
  data: Suggest;
  onClose: () => void;
  onCreate: (g: { name: string; days: number; materials: string[] }) => Promise<void>;
  onAddTo: (h: { condition_id: number; materials: string[] }) => Promise<void>;
}> = ({ data, onClose, onCreate, onAddTo }) => {
  // Editable copy: names, days, and materials taken out with ✕.
  const [groups, setGroups] = useState(() => data.groups.map((g) => ({ name: g.name, days: String(g.days), materials: g.materials.map((m) => m.material) })));
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setGroups(data.groups.map((g) => ({ name: g.name, days: String(g.days), materials: g.materials.map((m) => m.material) })));
  }, [data]);
  const grouped = groups.reduce((n, g) => n + g.materials.length, 0);
  const createOne = async (i: number) => {
    const g = groups[i];
    if (!g.name.trim() || !g.materials.length) return;
    setBusy(`g${i}`);
    await onCreate({ name: g.name.trim(), days: Math.max(0, Math.round(Number(g.days) || 0)), materials: g.materials });
    setBusy(null);
  };
  const createAll = async () => {
    setBusy('all');
    for (const g of groups) if (g.name.trim() && g.materials.length) await onCreate({ name: g.name.trim(), days: Math.max(0, Math.round(Number(g.days) || 0)), materials: g.materials });
    setBusy(null);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[220px]">
          <h4 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--g-accent, #7F00FF)' }} /> Suggested groups
            <span className="font-normal text-slate-500 text-xs">
              — {grouped} of {data.free} materials not in a condition yet, in {groups.length} group(s)
            </span>
          </h4>
          <p className="text-xs text-slate-500 mt-0.5">Grouped from the material names. Rename, take a material out, set the days, then create.</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs font-semibold px-3 py-2 rounded-xl border border-slate-200 text-slate-600">
          Close
        </button>
        {groups.length > 0 && (
          <button
            type="button"
            onClick={() => void createAll()}
            disabled={!!busy}
            className="text-xs font-semibold px-3 py-2 rounded-xl text-white disabled:opacity-60"
            style={{ background: 'var(--g-accent, #7F00FF)' }}
          >
            {busy === 'all' ? 'Creating…' : 'Create all'}
          </button>
        )}
      </div>

      {data.add_to_existing.length > 0 && (
        <div className="mt-3 space-y-2">
          {data.add_to_existing.map((h) => (
            <div key={h.condition_id} className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
              <span>
                <b>{h.materials.length}</b> new material(s) look like <b>{h.name}</b>:
              </span>
              {h.materials.slice(0, 6).map((m) => (
                <span key={m.key} className={`${chip} bg-white text-amber-900 !mb-0`}>
                  {m.material}
                </span>
              ))}
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(`h${h.condition_id}`);
                  await onAddTo({ condition_id: h.condition_id, materials: h.materials.map((m) => m.material) });
                  setBusy(null);
                }}
                className="ml-auto font-semibold px-2.5 py-1 rounded-lg bg-white border border-amber-300"
              >
                Add to {h.name}
              </button>
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-xs text-slate-500 mt-3">Nothing new to group — every material that matches a group is already in a condition.</p>
      ) : (
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          {groups.map((g, i) => (
            <div key={i} className="border border-slate-200 rounded-xl p-3">
              <input
                value={g.name}
                onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                className="w-full text-sm font-bold px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200"
                aria-label="Group name"
              />
              <div className="mt-2">
                {g.materials.map((m) => (
                  <span key={m} className={`${chip} bg-[color:var(--g-accent-soft,#f3e8ff)] text-slate-800`}>
                    {m}
                    <button
                      type="button"
                      onClick={() => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, materials: x.materials.filter((y) => y !== m) } : x)))}
                      className="text-slate-400 hover:text-slate-700"
                      aria-label={`Take ${m} out`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-slate-500">Min. notice</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={g.days}
                  onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)))}
                  className="w-16 text-center text-sm font-bold px-2 py-1 rounded-lg border border-slate-200"
                  aria-label="Minimum days' notice"
                />
                <span className="text-xs text-slate-500">days</span>
                <button
                  type="button"
                  disabled={!!busy || !g.materials.length || !g.name.trim()}
                  onClick={() => void createOne(i)}
                  className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-50"
                  style={{ background: 'var(--g-accent, #7F00FF)' }}
                >
                  {busy === `g${i}` ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.ungrouped.length > 0 && (
        <div className="mt-3 rounded-xl border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600">
          <b>Not grouped ({data.ungrouped.length}):</b>{' '}
          {data.ungrouped.slice(0, 20).map((m) => (
            <span key={m.key} className={`${chip} bg-slate-100 !mb-0`}>
              {m.material}
            </span>
          ))}
          {data.ungrouped.length > 20 && <span>+{data.ungrouped.length - 20} more</span>}
          <span className="text-slate-500"> — add them with "New condition", or leave them on the general rule.</span>
        </div>
      )}
    </div>
  );
};

const ConditionEditor: React.FC<{ token: string; cond: Condition | null; onClose: () => void; onSave: (body: any) => Promise<void> }> = ({ token, cond, onClose, onSave }) => {
  const [name, setName] = useState(cond?.name || '');
  const [days, setDays] = useState(String(cond?.min_lead_days ?? 3));
  const [picked, setPicked] = useState<string[]>(cond?.materials || []);
  const [entry, setEntry] = useState(cond ? !!cond.applies_entry : true);
  const [jobEdit, setJobEdit] = useState(cond ? !!cond.applies_job_edit : true);
  const [admins, setAdmins] = useState(cond ? !!cond.apply_to_admins : false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MaterialHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useBackButtonClose(true, onClose);

  // Type to search (the list comes from the database and can be long).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(apiUrl(`/api/delivery-material-conditions/materials?q=${encodeURIComponent(q)}`), { headers: { Authorization: `Bearer ${token}` } });
        const d = await res.json();
        if (!alive) return;
        setHits(Array.isArray(d.materials) ? d.materials : []);
        setTotal(Number(d.total) || 0);
      } catch {
        if (alive) setHits([]);
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, token]);

  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const isPicked = (m: string) => picked.some((p) => key(p) === key(m));
  const toggle = (m: string) => setPicked((ps) => (isPicked(m) ? ps.filter((p) => key(p) !== key(m)) : [...ps, m]));

  const submit = async () => {
    const n = Number(days);
    if (!name.trim()) return setError('Give the condition a name.');
    if (!picked.length) return setError('Pick at least one material.');
    if (!Number.isInteger(n) || n < 0 || n > 365) return setError("Minimum days' notice must be a whole number from 0 to 365.");
    if (!entry && !jobEdit) return setError('Tick New Job Entry / Add MPR, Job Edit or both.');
    setSaving(true);
    setError('');
    try {
      await onSave({ name: name.trim(), min_lead_days: n, materials: picked, applies_entry: entry, applies_job_edit: jobEdit, apply_to_admins: admins, enabled: cond ? !!cond.enabled : true });
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={cond ? 'Edit material condition' : 'New material condition'}>
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-3 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-2xl">
          <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-slate-900">{cond ? 'Edit material condition' : 'New material condition'}</h3>
                <p className="text-xs text-slate-500">Search the materials, tick them, name the condition, set the days.</p>
              </div>
              <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            <label className="block text-xs font-semibold text-slate-600 mt-4 mb-1">Condition name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Sand" className="w-full text-sm px-3 py-2.5 rounded-xl border border-slate-200 bg-white" />

            <label className="block text-xs font-semibold text-slate-600 mt-4 mb-1">
              Materials (Description of Material) — {picked.length} selected
            </label>
            {picked.length > 0 && (
              <div className="mb-2">
                {picked.map((m) => (
                  <span key={m} className={`${chip} bg-[color:var(--g-accent-soft,#f3e8ff)] text-slate-800`}>
                    {m}
                    <button type="button" onClick={() => toggle(m)} className="text-slate-400 hover:text-slate-700" aria-label={`Remove ${m}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="liquid-glass-inset rounded-2xl overflow-hidden">
              <div className="p-2 relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-5 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search material — e.g. sand, tiles, pipe…" className="w-full text-sm pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 bg-white" aria-label="Search material" />
              </div>
              <div className="max-h-64 overflow-y-auto bg-white/70">
                {hits === null ? (
                  <div className="py-5 flex justify-center">
                    <Spinner size={16} />
                  </div>
                ) : hits.length === 0 ? (
                  <p className="text-xs text-slate-500 px-4 py-4">{total === 0 ? 'No materials yet — import a Budget first.' : 'No material matches.'}</p>
                ) : (
                  hits.map((m) => {
                    const other = m.condition && (!cond || m.condition.id !== cond.id) ? m.condition : null;
                    return (
                      <label key={m.key} className="flex items-center gap-3 px-4 py-2 border-t border-slate-100 cursor-pointer hover:bg-slate-50">
                        <input type="checkbox" checked={isPicked(m.material)} onChange={() => toggle(m.material)} className="w-4 h-4" />
                        <span className="flex-1 min-w-0 text-sm">
                          <span className="font-semibold text-slate-900">{m.material}</span>
                          <span className="text-xs text-slate-500">
                            {m.unit ? ` · ${m.unit}` : ''} · in {m.budgets} budget{m.budgets === 1 ? '' : 's'}
                          </span>
                        </span>
                        {other && <span className="text-[11px] rounded-full px-2 py-0.5 bg-amber-50 text-amber-800 whitespace-nowrap">in "{other.name}"</span>}
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-4 mt-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Minimum days' notice</label>
                <input type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-24 text-center text-sm font-bold px-3 py-2.5 rounded-xl border border-slate-200 bg-white" />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700 pb-2">
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={entry} onChange={(e) => setEntry(e.target.checked)} /> New Job Entry / Add MPR
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={jobEdit} onChange={(e) => setJobEdit(e.target.checked)} /> Job Edit
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={admins} onChange={(e) => setAdmins(e.target.checked)} /> Admins too
                </label>
              </div>
            </div>
            {picked.some((m) => hits?.find((h) => key(h.material) === key(m) && h.condition && (!cond || h.condition.id !== cond.id))) && (
              <p className="text-xs text-amber-800 bg-amber-50 rounded-xl px-3 py-2 mt-3">A material already in another condition moves to this one when you save.</p>
            )}
            {error && <p className="text-xs text-rose-700 bg-rose-50 rounded-xl px-3 py-2 mt-3">{error}</p>}

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold">
                Cancel
              </button>
              <button type="button" onClick={() => void submit()} disabled={saving} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-bold disabled:opacity-60">
                {saving ? 'Saving…' : 'Save condition'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MaterialConditionsPanel;
