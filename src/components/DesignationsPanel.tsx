/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Designations (module "designations", DesignationRoutes.ts):
// one list for all companies, each designation with a permanent code
// (DSG-001…) that stays when the name changes and is never given out again.
//   - Look-alikes ("Senior Executive" / "Sr. Executive") shown on top, Merge.
//   - Rename shows first what changes (employees, OT rates, leave workflows…).
//   - Level ↑↓ orders them (1 = the top); Inactive hides one from the pickers.
// Layers: read to see, edit_add to add / rename / merge / level / active,
// delete_trash to delete one nobody has.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronUp, GitMerge, Loader2, Pencil, Plus, Search, Trash2, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';

interface Designation {
  id: number;
  code: string;
  name: string;
  level: number | null;
  isActive: boolean;
  employees: number;
  inactiveEmployees: number;
  usedIn: { label: string; rows: number }[];
}

type Modal =
  | { kind: 'add' }
  | { kind: 'rename'; d: Designation }
  | { kind: 'merge'; ids: number[] };

export const DesignationsPanel: React.FC<{ token: string; canEdit: boolean; canDelete: boolean }> = ({ token, canEdit, canDelete }) => {
  const [rows, setRows] = useState<Designation[] | null>(null);
  const [lookAlikes, setLookAlikes] = useState<number[][]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | 'all' | 'inactive'>('active');
  const [modal, setModal] = useState<Modal | null>(null);
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(apiUrl(`/api/designations${path}`), { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { data: j, status: r.status });
    return j;
  };
  const load = useCallback(() => {
    setError('');
    call('')
      .then((j) => {
        setRows(j.designations);
        setLookAlikes(j.lookAlikes || []);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => load(), [load]);
  const say = (t: string) => {
    setNote(t);
    window.setTimeout(() => setNote(''), 4000);
  };
  const byId = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows || [])
      .filter((r) => (status === 'all' ? true : status === 'active' ? r.isActive : !r.isActive))
      .filter((r) => !s || r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s))
      .sort((a, b) => (a.level ?? 9999) - (b.level ?? 9999) || a.name.localeCompare(b.name));
  }, [rows, q, status]);
  const total = (rows || []).reduce((s, r) => s + r.employees, 0);

  const patch = async (d: Designation, body: any) => {
    try {
      await call(`/${d.id}`, 'PATCH', body);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const remove = async (d: Designation) => {
    if (!(await confirmDialog(`Delete “${d.name}” (${d.code})? Nobody has it; its code won't be given out again.`, { tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await call(`/${d.id}`, 'DELETE');
      say(`${d.code} “${d.name}” deleted.`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 mr-auto">
          <BadgeCheck className="w-5 h-5 text-orange-600" />
          <h2 className="text-lg font-bold text-slate-900">Designations</h2>
          {rows && <span className="text-xs text-slate-500">{rows.length} designations · {total} employees · one list for all companies</span>}
        </div>
        {canEdit && (
          <button type="button" onClick={() => setModal({ kind: 'add' })} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-orange-600 text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Add designation
          </button>
        )}
      </div>

      {lookAlikes.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 space-y-2" aria-label="Look-alike designations">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <AlertTriangle className="w-4 h-4" /> These look like the same designation — {lookAlikes.length} group{lookAlikes.length === 1 ? '' : 's'}
          </div>
          {lookAlikes.map((g) => (
            <div key={g.join('-')} className="flex flex-wrap items-center gap-1.5">
              {g.map((id) => byId.get(id)).filter(Boolean).map((d) => (
                <span key={d!.id} className="text-xs px-2.5 py-1 rounded-full bg-white border border-amber-200 text-slate-700">
                  <code className="text-[11px] text-slate-500">{d!.code}</code> {d!.name} · {d!.employees}
                </span>
              ))}
              {canEdit && (
                <button type="button" onClick={() => setModal({ kind: 'merge', ids: g })} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-orange-600 text-white text-xs font-semibold">
                  <GitMerge className="w-3.5 h-3.5" /> Merge
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search designation or code" aria-label="Search designation or code" className="w-full pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 text-sm" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} aria-label="Status" className="px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm">
          <option value="active">Active</option>
          <option value="all">All</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      {error && <div className="text-sm px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {note && <div className="text-sm px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{note}</div>}

      {!rows ? (
        <div className="py-10 grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-auto md:max-h-[calc(100dvh-280px)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 text-xs">
              <tr>
                {['Code', 'Level', 'Designation', 'Employees', 'Used in', 'Status', ''].map((h, i) => (
                  <th key={i} className={`px-3 py-2.5 font-semibold whitespace-nowrap ${i === 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">No designations here.</td></tr>
              )}
              {shown.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-3 py-2"><code className="text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">{d.code}</code></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 tabular-nums text-slate-700">
                      {d.level ?? '—'}
                      {canEdit && (
                        <>
                          <button type="button" aria-label={`Raise ${d.name}`} onClick={() => void patch(d, { level: Math.max(1, (d.level ?? 21) - 1) })} className="p-0.5 rounded border border-slate-200 hover:bg-slate-50"><ChevronUp className="w-3 h-3" /></button>
                          <button type="button" aria-label={`Lower ${d.name}`} onClick={() => void patch(d, { level: (d.level ?? 19) + 1 })} className="p-0.5 rounded border border-slate-200 hover:bg-slate-50"><ChevronDown className="w-3 h-3" /></button>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-semibold text-slate-800">{d.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="font-semibold">{d.employees}</span>
                    {d.inactiveEmployees > 0 && <span className="block text-[10px] text-slate-400">+{d.inactiveEmployees} left</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{d.usedIn.length ? d.usedIn.map((u) => `${u.label} ${u.rows}`).join(' · ') : '—'}</td>
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <button type="button" onClick={() => void patch(d, { isActive: !d.isActive })} title={d.isActive ? 'Hide it from the pickers' : 'Show it in the pickers again'}
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${d.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {d.isActive ? 'Active' : 'Inactive'}
                      </button>
                    ) : (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${d.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{d.isActive ? 'Active' : 'Inactive'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {canEdit && (
                      <button type="button" onClick={() => setModal({ kind: 'rename', d })} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                        <Pencil className="w-3 h-3" /> Rename
                      </button>
                    )}
                    {canDelete && d.employees + d.inactiveEmployees === 0 && (
                      <button type="button" onClick={() => void remove(d)} aria-label={`Delete ${d.name}`} className="ml-1 p-1.5 rounded-lg text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'add' && <AddPopup call={call} onClose={() => setModal(null)} onDone={(t) => { setModal(null); say(t); load(); }} />}
      {modal?.kind === 'rename' && <RenamePopup call={call} d={modal.d} onClose={() => setModal(null)} onDone={(t) => { setModal(null); say(t); load(); }} />}
      {modal?.kind === 'merge' && (
        <MergePopup call={call} group={modal.ids.map((id) => byId.get(id)).filter(Boolean) as Designation[]} onClose={() => setModal(null)} onDone={(t) => { setModal(null); say(t); load(); }} />
      )}
    </div>
  );
};

type Call = (path: string, method?: string, body?: unknown) => Promise<any>;

const AddPopup: React.FC<{ call: Call; onClose: () => void; onDone: (t: string) => void }> = ({ call, onClose, onDone }) => {
  const [name, setName] = useState('');
  const [level, setLevel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState<{ code: string; name: string } | null>(null);
  const save = async (force = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await call('', 'POST', { name, level: level ? Number(level) : undefined, force });
      onDone(`${r.designation.code} “${r.designation.name}” added.`);
    } catch (e: any) {
      if (e.data?.similar) setSimilar(e.data.similar);
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup title="Add designation" icon={<Plus className="w-4 h-4 text-orange-600" />} onClose={onClose} size="md"
      footer={<>
        <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
        {similar && <button type="button" className={ghostBtn} disabled={busy} onClick={() => void save(true)}>Add anyway</button>}
        <button type="button" className={primaryBtn} disabled={busy || !name.trim()} onClick={() => void save()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Add</button>
      </>}>
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="dg-name">Name</label>
          <input id="dg-name" className={inputCls} value={name} autoFocus maxLength={150} onChange={(e) => { setName(e.target.value); setSimilar(null); setError(''); }} placeholder="e.g. Project Coordinator" />
        </div>
        <div>
          <label className={labelCls} htmlFor="dg-level">Level (optional — 1 is the top)</label>
          <input id="dg-level" className={inputCls} value={level} inputMode="numeric" onChange={(e) => setLevel(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 7" />
        </div>
        <p className="text-[11px] text-slate-500">It gets the next code (DSG-…) by itself. The code never changes, even if the name does.</p>
        {error && <div className={`text-xs px-3 py-2 rounded-xl ${similar ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'}`}>{error}</div>}
      </div>
    </Popup>
  );
};

const RenamePopup: React.FC<{ call: Call; d: Designation; onClose: () => void; onDone: (t: string) => void }> = ({ call, d, onClose, onDone }) => {
  const [name, setName] = useState(d.name);
  const [impact, setImpact] = useState<{ employees: number; namedIn: { label: string; rows: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState(false);
  useEffect(() => {
    call(`/${d.id}/impact`).then(setImpact).catch(() => setImpact({ employees: d.employees + d.inactiveEmployees, namedIn: d.usedIn }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id]);
  const save = async (force = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await call(`/${d.id}`, 'PATCH', { name, force });
      onDone(`${d.code}: “${d.name}” → “${name.trim()}”${r.employees ? ` — ${r.employees} employee${r.employees === 1 ? '' : 's'}` : ''}${r.rules ? `, ${r.rules} rule${r.rules === 1 ? '' : 's'}` : ''} updated.`);
    } catch (e: any) {
      setSimilar(!!e.data?.similar);
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup title={`Rename “${d.name}”`} icon={<Pencil className="w-4 h-4 text-orange-600" />} onClose={onClose} size="md"
      footer={<>
        <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
        {similar && <button type="button" className={ghostBtn} disabled={busy} onClick={() => void save(true)}>Rename anyway</button>}
        <button type="button" className={primaryBtn} disabled={busy || !name.trim() || name.trim() === d.name} onClick={() => void save()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Rename everywhere</button>
      </>}>
      <div className="space-y-3">
        <div className="rounded-2xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <b>Code {d.code} stays the same.</b> Reports, imports and other software that know it by its code keep working.
        </div>
        <div>
          <label className={labelCls} htmlFor="dg-rename">New name</label>
          <input id="dg-rename" className={inputCls} value={name} autoFocus maxLength={150} onChange={(e) => { setName(e.target.value); setError(''); setSimilar(false); }} />
        </div>
        <div className="liquid-glass-inset rounded-2xl px-3 py-2 text-xs text-slate-700 space-y-0.5">
          <div className="font-semibold">What changes</div>
          {!impact ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (
            <>
              <div>{impact.employees} employee{impact.employees === 1 ? '' : 's'} (all companies)</div>
              {impact.namedIn.map((u) => <div key={u.label}>{u.label}: {u.rows}</div>)}
              <div className="text-slate-500">Not a promotion — nothing is added to anyone's Service Book. Transfer history keeps the old name.</div>
            </>
          )}
        </div>
        {error && <div className={`text-xs px-3 py-2 rounded-xl ${similar ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'}`}>{error}</div>}
      </div>
    </Popup>
  );
};

const MergePopup: React.FC<{ call: Call; group: Designation[]; onClose: () => void; onDone: (t: string) => void }> = ({ call, group, onClose, onDone }) => {
  // The one most people have is kept by default.
  const [keep, setKeep] = useState(() => [...group].sort((a, b) => b.employees - a.employees)[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const k = group.find((g) => g.id === keep);
  const others = group.filter((g) => g.id !== keep);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await call('/merge', 'POST', { keepId: keep, mergeIds: others.map((o) => o.id) });
      onDone(`Merged into ${r.keep.code} “${r.keep.name}” — ${r.employees} employee${r.employees === 1 ? '' : 's'} moved; ${r.merged.join(', ')} retired.`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup title={`Merge ${group.length} into one`} icon={<GitMerge className="w-4 h-4 text-orange-600" />} onClose={onClose} size="md"
      footer={<>
        <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={busy || !k} onClick={() => void save()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Merge</button>
      </>}>
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="dg-keep">Keep this one (its name and code)</label>
          <select id="dg-keep" className={inputCls} value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
            {group.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name} ({g.employees})</option>)}
          </select>
        </div>
        <div className="liquid-glass-inset rounded-2xl px-3 py-2 text-xs text-slate-700 space-y-0.5">
          <div className="font-semibold">What happens</div>
          <div>{group.reduce((s, g) => s + g.employees + g.inactiveEmployees, 0)} employees end up as “{k?.name}” ({k?.code}).</div>
          <div>OT rates, leave workflows and the like that name {others.map((o) => `“${o.name}”`).join(', ')} change too.</div>
          <div>{others.map((o) => o.code).join(', ')} leave the list; those codes are never given out again (an old Excel with them still lands on “{k?.name}”).</div>
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
