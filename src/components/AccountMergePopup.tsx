/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> Merge accounts (Users layer "merge_accounts",
// AccountMergeRoutes.ts). Logins made by hand before the employee import,
// paired with the login the import made for the same person. Merging moves
// everything on the old login (attendance, leave, claims, approvals, chat…)
// to the import's login and deletes the old one — only the import's login,
// Login ID = Employee ID, is left.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, GitMerge, Loader2, AlertTriangle, History } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { confirmDialog } from '../lib/confirmDialog';
import { MailPopup as Popup, ghostBtn } from './mail/MailPopup';
import { SearchSelect } from './Combobox';

interface OldLogin { id: number; name: string; email: string | null; username: string | null; role: string; last_login_at: string | null }
interface Keeper { id: number; name: string; email: string | null; username: string | null; role: string; employee_code: string | null; designation: string | null; department: string | null }
interface Pair { from: OldLogin; to: Keeper; match: string[]; ambiguous: boolean }
interface TableCount { table: string; label: string; rows: number; access: boolean }
interface LogRow { id: number; from_name: string; from_login: string; to_name: string; kept_access: string; kept_password: string; merged_at: string; merged_by_name: string | null; moved: { moved?: Record<string, number>; dropped?: number } }

const keeperLabel = (k: Keeper) => [k.name, k.employee_code, k.designation, k.department].filter(Boolean).join(' · ');
const loginOf = (u: { username: string | null; email: string | null }) => u.username || u.email || '—';
const when = (v: string | null) => (v ? `${formatDate(v)} ${String(v).slice(11, 16)}` : 'never');

const Choice: React.FC<{ value: string; on: string; set: (v: string) => void; options: [string, string, string][] }> = ({ value, on, set, options }) => (
  <div className="grid sm:grid-cols-2 gap-2">
    {options.map(([v, title, hint]) => (
      <button key={v} type="button" onClick={() => set(v)} aria-pressed={on === v}
        className={`text-left rounded-2xl border px-3 py-2 ${on === v ? 'border-teal-500 bg-teal-50/80 ring-2 ring-teal-500/20' : 'border-slate-200 bg-white/70 hover:bg-white'}`}>
        <div className="text-xs font-bold text-slate-800">{title}{v === value ? <span className="ml-1 text-[10px] font-semibold text-teal-700">(suggested)</span> : null}</div>
        <div className="text-[11px] text-slate-500">{hint}</div>
      </button>
    ))}
  </div>
);

export const AccountMergePopup: React.FC<{ token: string; onClose: () => void; onChanged?: () => void }> = ({ token, onClose, onChanged }) => {
  const [data, setData] = useState<{ pairs: Pair[]; unlinked: OldLogin[]; keepers: Keeper[] } | null>(null);
  const [error, setError] = useState('');
  // Pairs on screen: the found ones plus any made by hand (old id -> keeper id).
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [access, setAccess] = useState('old');
  const [password, setPassword] = useState('old');
  const [preview, setPreview] = useState<Record<number, TableCount[] | 'loading' | string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ merged: any[]; failed: any[] } | null>(null);
  const [view, setView] = useState<'merge' | 'log'>('merge');
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [q, setQ] = useState('');
  const auth = { Authorization: `Bearer ${token}` };

  const load = useCallback(() => {
    setError('');
    fetch(apiUrl('/api/users/merge/candidates'), { headers: auth })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Could not load the accounts');
        setData(j);
        const c: Record<number, number> = {};
        const t = new Set<number>();
        for (const p of j.pairs as Pair[]) {
          c[p.from.id] = p.to.id;
          // A clear match (email / Login ID, or a name only one employee has) starts ticked.
          if (!p.ambiguous) t.add(p.from.id);
        }
        setChosen(c);
        setTicked(t);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (view !== 'log') return;
    fetch(apiUrl('/api/users/merge/log'), { headers: auth }).then((r) => r.json()).then((j) => setLog(Array.isArray(j) ? j : [])).catch(() => setLog([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);

  const keeperById = useMemo(() => new Map((data?.keepers || []).map((k) => [k.id, k])), [data]);
  const matchOf = useMemo(() => new Map((data?.pairs || []).map((p) => [p.from.id, p])), [data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.unlinked || [])
      .filter((u) => !s || [u.name, u.email, u.username, keeperById.get(chosen[u.id])?.name, keeperById.get(chosen[u.id])?.employee_code].some((v) => String(v || '').toLowerCase().includes(s)))
      // Matched first, then the ones still to pair by hand.
      .sort((a, b) => Number(!!chosen[b.id]) - Number(!!chosen[a.id]) || a.name.localeCompare(b.name));
  }, [data, chosen, q, keeperById]);
  const ready = rows.filter((u) => chosen[u.id] && ticked.has(u.id));

  const showPreview = async (fromId: number) => {
    const toId = chosen[fromId];
    if (!toId) return;
    setPreview((p) => ({ ...p, [fromId]: 'loading' }));
    try {
      const r = await fetch(apiUrl(`/api/users/merge/preview?from=${fromId}&to=${toId}`), { headers: auth });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not check');
      setPreview((p) => ({ ...p, [fromId]: j.tables }));
    } catch (e: any) {
      setPreview((p) => ({ ...p, [fromId]: e.message }));
    }
  };

  const merge = async () => {
    if (!ready.length) return;
    const ok = await confirmDialog(
      `Merge ${ready.length} account${ready.length === 1 ? '' : 's'}? Everything on each old login moves to the employee's login, and the old login is deleted. This can't be undone — keep a database backup first.`,
      { title: 'Merge accounts', confirmLabel: `Merge ${ready.length}`, tone: 'danger' }
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/users/merge'), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: ready.map((u) => ({ from: u.id, to: chosen[u.id] })), access, password })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not merge');
      setResult(j);
      setPreview({});
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <div className="px-5 pb-2 flex gap-1.5">
      {([['merge', 'Merge'], ['log', 'History']] as const).map(([k, l]) => (
        <button key={k} type="button" onClick={() => setView(k)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold ${view === k ? 'bg-slate-900 text-white' : 'liquid-glass-chip text-slate-600'}`}>
          {k === 'log' && <History className="w-3 h-3 inline mr-1" />}{l}
        </button>
      ))}
    </div>
  );
  const footer = view === 'merge' ? (
    <>
      <span className="mr-auto text-xs text-slate-500">{ready.length} selected</span>
      <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
      <button type="button" onClick={merge} disabled={busy || !ready.length}
        className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-rose-600 disabled:opacity-50 inline-flex items-center gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />} Merge {ready.length || ''} selected
      </button>
    </>
  ) : undefined;

  return (
    <Popup title="Merge accounts" icon={<GitMerge className="w-4 h-4 text-teal-600" />} onClose={onClose} size="xl" head={head} footer={footer}>
      {view === 'log' ? (
        !log ? <div className="py-10 grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
        : log.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">No accounts merged yet.</p>
        : (
          <div className="liquid-glass-inset rounded-2xl divide-y divide-slate-200/70">
            {log.map((l) => (
              <div key={l.id} className="px-3 py-2 text-xs">
                <div className="font-semibold text-slate-800">{l.from_name} <span className="text-slate-400 font-normal">({l.from_login})</span> <ArrowRight className="w-3 h-3 inline" /> {l.to_name}</div>
                <div className="text-slate-500">
                  {when(l.merged_at)}{l.merged_by_name ? ` · by ${l.merged_by_name}` : ''} · {Object.values(l.moved?.moved || {}).reduce((a, b) => a + b, 0)} records moved
                  {l.moved?.dropped ? ` · ${l.moved.dropped} duplicates dropped` : ''} · access from {l.kept_access === 'old' ? 'old login' : 'employee login'} · password from {l.kept_password === 'old' ? 'old login' : 'employee login'}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div className="liquid-glass-inset rounded-2xl px-4 py-3 text-xs text-slate-700 space-y-1">
            <p><b>What this does:</b> each login made by hand (not linked to any employee) is paired with the login the employee import made for the same person. Merging moves everything on the old login — attendance, leave, claims, approvals, chat, tracking, tasks — to the employee's login and deletes the old one. Only the employee's login stays (Login ID = Employee ID).</p>
            <p className="text-rose-700 flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> It can't be undone. Check each pair (press <b>What moves</b>) and keep a database backup before merging on the live site.</p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold text-slate-700">Module access the kept login gets</div>
            <Choice value="old" on={access} set={setAccess} options={[
              ['old', 'From the old login', 'The modules, layers and switches you set by hand on it.'],
              ['keep', "Keep the employee login's", "What the import gave it (the default access template)."]
            ]} />
            <div className="text-xs font-bold text-slate-700 pt-1">Password</div>
            <Choice value="old" on={password} set={setPassword} options={[
              ['old', "The old login's password", 'People sign in with their Employee ID and the password they already use.'],
              ['keep', "The employee login's password", 'The password the import set.']
            ]} />
          </div>

          {result && (
            <div className={`rounded-2xl px-4 py-3 text-xs ${result.failed.length ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900'}`}>
              <b>{result.merged.length} merged.</b>{' '}
              {result.merged.slice(0, 5).map((m) => `${m.from_name} → ${m.to_name} (${m.moved} records)`).join(', ')}
              {result.failed.length > 0 && <div className="mt-1">Not merged: {result.failed.map((f) => `#${f.from}: ${f.error}`).join('; ')}</div>}
            </div>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}

          {!data ? (
            <div className="py-10 grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : data.unlinked.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">Every login is linked to an employee — nothing to merge.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or login…"
                  className="flex-1 min-w-[180px] text-sm px-3 py-2 bg-white/80 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-200" />
                <span className="text-xs text-slate-500">{data.unlinked.length} logins with no employee · {data.pairs.length} matched</span>
                <button type="button" className="text-xs font-semibold text-teal-700 hover:underline"
                  onClick={() => setTicked(new Set(rows.filter((u) => chosen[u.id]).map((u) => u.id)))}>Select all paired</button>
                <button type="button" className="text-xs font-semibold text-slate-500 hover:underline" onClick={() => setTicked(new Set())}>Clear</button>
              </div>
              <div className="space-y-2">
                {rows.map((u) => {
                  const m = matchOf.get(u.id);
                  const k = keeperById.get(chosen[u.id]);
                  const pv = preview[u.id];
                  return (
                    <div key={u.id} data-merge-row={u.id} className={`rounded-2xl border px-3 py-2.5 ${ticked.has(u.id) && k ? 'border-teal-400 bg-white' : 'border-slate-200 bg-white/70'}`}>
                      <div className="flex flex-col md:flex-row md:items-center gap-2">
                        <label className="flex items-start gap-2 md:w-[38%] min-w-0">
                          <input type="checkbox" className="mt-1 accent-teal-600" disabled={!k} checked={!!k && ticked.has(u.id)}
                            onChange={(e) => setTicked((t) => { const n = new Set(t); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })} />
                          <span className="min-w-0">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-rose-600">Remove · old login</span>
                            <span className="block text-sm font-semibold text-slate-800 truncate">{u.name}</span>
                            <span className="block text-[11px] text-slate-500 truncate">{loginOf(u)} · {u.role} · last sign-in {when(u.last_login_at)}</span>
                          </span>
                        </label>
                        <ArrowRight className="hidden md:block w-4 h-4 text-slate-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="block text-[10px] font-bold uppercase tracking-wide text-teal-700">Keep · employee login</span>
                          <SearchSelect className="w-full text-sm px-3 py-2 bg-white/80 border border-slate-200 rounded-xl" value={chosen[u.id] ? String(chosen[u.id]) : ''}
                            onChange={(e) => { const v = Number(e.target.value); setChosen((c) => { const n = { ...c }; if (v) n[u.id] = v; else delete n[u.id]; return n; }); setPreview((p) => { const n = { ...p }; delete n[u.id]; return n; }); if (v) setTicked((t) => new Set(t).add(u.id)); }}>
                            <option value="">— Pick the employee —</option>
                            {(data.keepers || []).map((x) => <option key={x.id} value={x.id}>{keeperLabel(x)}</option>)}
                          </SearchSelect>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            {k && <span className="text-[11px] text-slate-500">Login ID {loginOf(k)}</span>}
                            {m && m.to.id === chosen[u.id] && m.match.map((w) => <span key={w} className="text-[10px] font-semibold rounded-full bg-sky-50 text-sky-700 px-2 py-0.5">same {w}</span>)}
                            {m?.ambiguous && m.to.id === chosen[u.id] && <span className="text-[10px] font-semibold rounded-full bg-amber-50 text-amber-700 px-2 py-0.5">name only, more than one — check</span>}
                            {!k && <span className="text-[11px] text-amber-700">No match found — pick the employee, or leave it.</span>}
                            {k && (
                              <button type="button" className="ml-auto text-[11px] font-semibold text-teal-700 hover:underline" onClick={() => showPreview(u.id)}>
                                What moves
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      {pv && (
                        <div className="mt-2 liquid-glass-inset rounded-xl px-3 py-2 text-[11px] text-slate-600">
                          {pv === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : typeof pv === 'string' ? <span className="text-rose-600">{pv}</span>
                            : pv.length === 0 ? <span>Nothing on the old login — it is only deleted.</span>
                            : (
                              <>
                                <b>{pv.filter((t) => !t.access).reduce((a, t) => a + t.rows, 0)} records move:</b>{' '}
                                {pv.filter((t) => !t.access).map((t) => `${t.label} ${t.rows}`).join(' · ')}
                                {pv.some((t) => t.access) && (
                                  <span className="block mt-0.5 text-slate-500">
                                    Access settings: {pv.filter((t) => t.access).map((t) => `${t.label} ${t.rows}`).join(' · ')} — {access === 'old' ? 'replace the employee login’s' : 'dropped (the employee login’s are kept)'}
                                  </span>
                                )}
                              </>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </Popup>
  );
};
