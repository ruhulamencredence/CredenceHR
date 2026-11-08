/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Exit / Offboarding -> Clearance Departments: the departments every new
// exit is cleared by, what each one clears, who approves it, and their order.
// Picking the approver needs only the module (as before); adding, renaming,
// reordering and removing departments needs the "Exit — Clearance
// Departments setup" layer (exit_clearance_setup) — the API checks the same.
// Exits already raised keep the clearance items they were given; a new
// department can be added to the open exits too.

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { activePeople } from '../lib/activePeople';
import { confirmDialog } from '../lib/confirmDialog';
import { Spinner } from './Spinner';

import { SearchSelect } from './Combobox';
interface Dept {
  id: number | null;
  department: string;
  item_label: string;
  sort_order: number;
  approver_user_id: number | null;
  approver_name: string | null;
}
const input = 'w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50';

export const ClearanceDepartments: React.FC<{ token: string; users: { id: number; name: string; role: string }[]; canSetup: boolean; onChanged?: () => void }> = ({
  token,
  users,
  canSetup,
  onChanged
}) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [list, setList] = useState<Dept[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; department: string; item_label: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ department: '', item_label: '', approver_user_id: '', apply_to_open: false });

  const call = async (path: string, method: string, body?: any) => {
    const res = await fetch(apiUrl(path), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
  const load = () =>
    call('/api/exit-clearance-approvers', 'GET')
      .then((d) => setList(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const setApprover = (d: Dept, id: number | null) =>
    run(`approver:${d.department}`, () => call(`/api/exit-clearance-approvers/${encodeURIComponent(d.department)}`, 'PUT', { approver_user_id: id }));
  const move = (i: number, dir: -1 | 1) => {
    if (!list) return;
    const ids = list.map((d) => d.id as number);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    run('order', () => call('/api/exit-clearance-departments-order', 'PUT', { ids }));
  };
  const remove = async (d: Dept) => {
    if (!(await confirmDialog(`Remove "${d.department}" from clearance? New exits won't have it; exits already raised keep their ${d.department} item.`))) return;
    run(`del:${d.id}`, () => call(`/api/exit-clearance-departments/${d.id}`, 'DELETE'));
  };
  const saveEdit = () => editing && run(`edit:${editing.id}`, () => call(`/api/exit-clearance-departments/${editing.id}`, 'PUT', editing).then(() => setEditing(null)));
  const add = () =>
    run('add', async () => {
      const r = await call('/api/exit-clearance-departments', 'POST', {
        department: draft.department,
        item_label: draft.item_label,
        approver_user_id: draft.approver_user_id ? Number(draft.approver_user_id) : null,
        apply_to_open: draft.apply_to_open
      });
      setDraft({ department: '', item_label: '', approver_user_id: '', apply_to_open: false });
      setAdding(false);
      if (r.added_to_open) setError(`Added to ${r.added_to_open} open exit${r.added_to_open === 1 ? '' : 's'} too.`);
    });

  return (
    <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/60">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-xs font-bold text-slate-700">Clearance Departments</p>
          <p className="text-[11px] text-slate-500 max-w-xl">
            Every NEW exit gets one clearance item per department below, in this order. The approver gets it in their Approve Application
            queue. Exits already raised keep what they were given.
          </p>
        </div>
        {canSetup && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl">
            <Plus className="w-3.5 h-3.5" /> Add department
          </button>
        )}
      </div>

      {error && <p className={`text-xs mb-2 ${error.startsWith('Added to') ? 'text-emerald-700' : 'text-rose-600'}`}>{error}</p>}

      {adding && (
        <div className="mb-3 p-3 rounded-xl bg-white border border-blue-200 grid grid-cols-1 sm:grid-cols-[1fr_2fr_1fr] gap-2 items-end">
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Department</label>
            <input className={input} value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} placeholder="e.g. Store" maxLength={100} aria-label="New department" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">What it clears</label>
            <input className={input} value={draft.item_label} onChange={(e) => setDraft({ ...draft, item_label: e.target.value })} placeholder="e.g. Tools & uniform return" maxLength={255} aria-label="What it clears" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Approver</label>
            <SearchSelect className={input} value={draft.approver_user_id} onChange={(e) => setDraft({ ...draft, approver_user_id: e.target.value })}>
              <option value="">Unassigned</option>
              {activePeople(users, draft.approver_user_id).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </SearchSelect>
          </div>
          <label className="sm:col-span-2 flex items-center gap-2 text-[11px] text-slate-600">
            <input type="checkbox" checked={draft.apply_to_open} onChange={(e) => setDraft({ ...draft, apply_to_open: e.target.checked })} />
            Also add it to the exits still pending / in clearance
          </label>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-2 text-xs font-semibold text-slate-600 rounded-xl hover:bg-slate-100">
              Cancel
            </button>
            <button type="button" disabled={busy === 'add'} onClick={add} className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl disabled:opacity-50">
              {busy === 'add' ? <Spinner size={12} /> : <Check className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>
      )}

      {!list ? (
        <Spinner size={18} />
      ) : (
        <div className="space-y-2">
          {list.map((d, i) => {
            const isEditing = editing && editing.id === d.id;
            return (
              <div key={d.id ?? d.department} className="rounded-xl bg-white border border-slate-200 p-3 grid grid-cols-1 sm:grid-cols-[auto_1fr_220px_auto] gap-3 items-center">
                <span className="text-xs font-bold text-slate-400 w-5">{i + 1}.</span>
                {isEditing ? (
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
                    <input className={input} value={editing!.department} onChange={(e) => setEditing({ ...editing!, department: e.target.value })} maxLength={100} aria-label="Department name" />
                    <input className={input} value={editing!.item_label} onChange={(e) => setEditing({ ...editing!, item_label: e.target.value })} maxLength={255} aria-label="What it clears" />
                  </div>
                ) : (
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">{d.department}</p>
                    <p className="text-[11px] text-slate-500">{d.item_label}</p>
                  </div>
                )}
                <SearchSelect
                  value={d.approver_user_id ?? ''}
                  disabled={busy === `approver:${d.department}` || d.id === null}
                  onChange={(e) => setApprover(d, e.target.value ? Number(e.target.value) : null)}
                  className={input}
                  aria-label={`${d.department} approver`}
                >
                  <option value="">Approver: unassigned</option>
                  {activePeople(users, d.approver_user_id).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </SearchSelect>
                {canSetup && d.id !== null && (
                  <div className="flex items-center gap-1 justify-end">
                    {isEditing ? (
                      <>
                        <button type="button" onClick={saveEdit} disabled={busy === `edit:${d.id}`} className="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50" aria-label="Save">
                          <Check className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Cancel edit">
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label={`Move ${d.department} up`}>
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button type="button" disabled={i === list.length - 1 || !!busy} onClick={() => move(i, 1)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label={`Move ${d.department} down`}>
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => setEditing({ id: d.id as number, department: d.department, item_label: d.item_label })} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100" aria-label={`Edit ${d.department}`}>
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button type="button" disabled={list.length <= 1 || !!busy} onClick={() => remove(d)} className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-30" aria-label={`Remove ${d.department}`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!canSetup && <p className="text-[11px] text-slate-400 mt-2">Adding or changing departments needs the “Exit — Clearance Departments setup” permission.</p>}
    </div>
  );
};
