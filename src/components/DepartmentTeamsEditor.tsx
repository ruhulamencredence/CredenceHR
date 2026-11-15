/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Departments -> Edit: the Department's teams, each with its own
// Supervisor and members (DepartmentTeams.ts). A person's request goes to their
// own team's Supervisor, then the Head of Department, then the workflow — never
// to another team's Supervisor. One team may also hold "everyone else in the
// Department" (new hires land there by themselves); without it, people in no
// team go straight to the Head.
// Saved with the Department's own Save (the parent calls save()).
//
// Members can come from any Department. "Add people" lists everyone at the
// chosen Work stations ("projects", Employees -> Branch) in a Department (this
// one by default, or all) to tick and add at once, and can add a rule so new
// joiners there join this team by themselves (department_team_auto).

import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2, X, UserPlus, Sparkles } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';

interface Person {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department_id?: number | null;
  department?: string | null;
  branch?: string | null;
  team_id?: number | null;
  team_name?: string | null;
  team_department?: string | null;
}
interface AutoRule { branch: string; department_id: number | null }
interface Team {
  key: string;
  id: number | null;
  name: string;
  supervisor_user_id: string;
  everyone_else: boolean;
  member_ids: number[];
  auto: AutoRule[];
}
export interface DepartmentTeamsEditorHandle {
  save: (headUserId: number | null) => Promise<void>;
}

const field = 'block w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none';
const personText = (p: Person) => [p.name, p.employee_code, p.designation, p.department, p.branch].filter(Boolean).join(' · ');
const NO_BRANCH = '(No work station)';
const branchOf = (p: Person) => p.branch || NO_BRANCH;
let seq = 0;

export const DepartmentTeamsEditor = forwardRef<
  DepartmentTeamsEditorHandle,
  { token: string; departmentId: number; departmentName: string; supervisors: { value: string; label: string }[] }
>(function DepartmentTeamsEditor({ token, departmentId, departmentName, supervisors }, ref) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [pool, setPool] = useState<Person[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setTeams(null);
    fetch(apiUrl(`/api/departments/${departmentId}/teams`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
        if (!alive) return;
        setPeople(j.people || []);
        setPool(j.pool || j.people || []);
        setTeams(
          (j.teams || []).map((t: any) => ({
            key: `t${t.id}`,
            id: t.id,
            name: t.name,
            supervisor_user_id: t.supervisor_user_id ? String(t.supervisor_user_id) : '',
            everyone_else: !!t.everyone_else,
            member_ids: t.member_ids || [],
            auto: t.auto || []
          }))
        );
      })
      .catch((e) => alive && (setError(e.message), setTeams([])));
    return () => {
      alive = false;
    };
  }, [token, departmentId]);

  useImperativeHandle(ref, () => ({
    save: async (headUserId: number | null) => {
      if (!teams) return;
      const res = await fetch(apiUrl(`/api/departments/${departmentId}/teams`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          head_user_id: headUserId,
          teams: teams.map((t) => ({ id: t.id, name: t.name.trim(), supervisor_user_id: t.supervisor_user_id ? Number(t.supervisor_user_id) : null, everyone_else: t.everyone_else, member_ids: t.member_ids, auto: t.auto }))
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Could not save the teams.');
    }
  }));

  const byId = useMemo(() => new Map(pool.map((p) => [p.id, p])), [pool]);
  const teamOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of teams || []) for (const id of t.member_ids) m.set(id, t.key);
    return m;
  }, [teams]);
  const catchAll = (teams || []).find((t) => t.everyone_else);
  const nowIn = (p: Person, here: string) => {
    const k = teamOf.get(p.id);
    if (k) return k === here ? '' : teams?.find((x) => x.key === k)?.name || 'another team';
    // In a team of another Department (moves here if added; unless already moved out locally).
    const ourIds = new Set((teams || []).map((t) => t.id).filter(Boolean));
    return p.team_id && !ourIds.has(p.team_id) ? `${p.team_name}${p.team_department ? ` (${p.team_department})` : ''}` : '';
  };
  // One team per person: into this team, out of the others here.
  const addTo = (key: string, ids: number[], rules: AutoRule[] = []) =>
    setTeams((ts) =>
      (ts || []).map((x) =>
        x.key === key
          ? {
              ...x,
              member_ids: [...x.member_ids.filter((y) => !ids.includes(y)), ...ids],
              auto: [...x.auto, ...rules.filter((r) => !x.auto.some((a) => a.branch.toLowerCase() === r.branch.toLowerCase() && a.department_id === r.department_id))]
            }
          : { ...x, member_ids: x.member_ids.filter((y) => !ids.includes(y)) }
      )
    );
  const noTeam = people.filter((p) => !teamOf.has(p.id));
  const set = (key: string, patch: Partial<Team>) => setTeams((ts) => (ts || []).map((t) => (t.key === key ? { ...t, ...patch } : t)));

  if (!teams) return <p className="text-xs text-slate-500">{error || 'Loading teams…'}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Teams <span className="normal-case tracking-normal font-normal text-slate-500">— each with its own Supervisor and members</span>
        </p>
        <button
          type="button"
          onClick={() => setTeams((ts) => [...(ts || []), { key: `n${++seq}`, id: null, name: '', supervisor_user_id: '', everyone_else: false, member_ids: [], auto: [] }])}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-dashed border-orange-300 bg-orange-50 text-orange-700 text-xs font-semibold"
        >
          <Plus className="w-3.5 h-3.5" /> Add team
        </button>
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!teams.length && <p className="text-xs text-slate-500">No teams yet. Without a team, everyone's requests go to the Head of Department, then the workflow.</p>}
      <div className="grid gap-3">
        {teams.map((t, i) => (
          <div key={t.key} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <input aria-label={`Team ${i + 1} name`} className={`${field} font-semibold`} value={t.name} onChange={(e) => set(t.key, { name: e.target.value })} placeholder="e.g. Accounts team" />
              <button
                type="button"
                aria-label={`Remove team ${t.name || i + 1}`}
                onClick={async () => {
                  if (await confirmDialog(`Remove the team "${t.name || 'new team'}"? Its people go to the "everyone else" team, or to the Head of Department.`, { confirmLabel: 'Remove', tone: 'danger' }))
                    setTeams((ts) => (ts || []).filter((x) => x.key !== t.key));
                }}
                className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Supervisor</label>
              <SearchSelect aria-label={`Supervisor of ${t.name || `team ${i + 1}`}`} className={field} value={t.supervisor_user_id} onChange={(e) => set(t.key, { supervisor_user_id: e.target.value })}>
                <option value="">— Select supervisor —</option>
                {supervisors.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </SearchSelect>
            </div>
            <AddPeople
              teamName={t.name || `team ${i + 1}`}
              departmentId={departmentId}
              departmentName={departmentName}
              pool={pool}
              memberIds={t.member_ids}
              nowIn={(p) => nowIn(p, t.key)}
              onAdd={(ids, rules) => addTo(t.key, ids, rules)}
            />
            {t.auto.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="New joiners added by themselves">
                {t.auto.map((r) => (
                  <span key={`${r.branch}|${r.department_id}`} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-emerald-50 text-emerald-800 text-[11px] font-semibold">
                    <Sparkles className="w-3 h-3" /> New joiners · {r.branch} · {r.department_id ? pool.find((p) => p.department_id === r.department_id)?.department || (r.department_id === departmentId ? departmentName : 'Department') : 'any department'}
                    <button type="button" aria-label={`Stop adding new joiners at ${r.branch}`} onClick={() => set(t.key, { auto: t.auto.filter((x) => x !== r) })} className="p-0.5 rounded-full hover:bg-emerald-100">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {t.member_ids.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold text-slate-600">Members — {t.member_ids.length}, by work station</p>
                {[...t.member_ids.reduce((m, id) => { const p = byId.get(id); const b = p ? branchOf(p) : NO_BRANCH; m.set(b, [...(m.get(b) || []), id]); return m; }, new Map<string, number[]>())]
                  .sort((a, b) => b[1].length - a[1].length)
                  .map(([b, ids]) => (
                    <div key={b} className="rounded-xl bg-white border border-slate-200 px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] font-bold text-slate-700">
                        <span>{b} <span className="font-medium text-slate-500">· {ids.length}</span></span>
                        <button type="button" className="font-semibold text-rose-600 hover:underline" onClick={() => set(t.key, { member_ids: t.member_ids.filter((x) => !ids.includes(x)) })}>
                          Remove all
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ids.map((id) => {
                          const p = byId.get(id);
                          const other = p?.department_id && p.department_id !== departmentId ? p.department : '';
                          return (
                            <span key={id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold" title={p ? personText(p) : undefined}>
                              {p?.name || `#${id}`}
                              {other && <span className="text-[10px] font-medium text-blue-500">· {other}</span>}
                              <button type="button" aria-label={`Take ${p?.name || id} out of ${t.name}`} onClick={() => set(t.key, { member_ids: t.member_ids.filter((x) => x !== id) })} className="p-0.5 rounded-full hover:bg-blue-100">
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <SearchSelect
              aria-label={`Add member to ${t.name || `team ${i + 1}`}`}
              className={field}
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (!id) return;
                // One team per person: taken out of any other team.
                addTo(t.key, [id]);
              }}
            >
              <option value="">— Add one person (any department) —</option>
              {pool
                .filter((p) => teamOf.get(p.id) !== t.key)
                .map((p) => {
                  const w = nowIn(p, t.key);
                  return (
                    <option key={p.id} value={String(p.id)}>
                      {personText(p)}
                      {w ? ` (now in ${w})` : ''}
                    </option>
                  );
                })}
            </SearchSelect>
            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-blue-600"
                checked={t.everyone_else}
                onChange={(e) => setTeams((ts) => (ts || []).map((x) => ({ ...x, everyone_else: x.key === t.key ? e.target.checked : e.target.checked ? false : x.everyone_else })))}
              />
              <span>
                Also everyone else in {departmentName} (people in no other team, new hires too)
              </span>
            </label>
          </div>
        ))}
      </div>
      {!catchAll && noTeam.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-orange-50 border border-orange-200 text-xs text-orange-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {noTeam.length} {noTeam.length === 1 ? 'person' : 'people'} in {departmentName} in no team ({noTeam.slice(0, 4).map((p) => p.name).join(', ')}
            {noTeam.length > 4 ? '…' : ''}) — their requests go to the Head of Department, then the workflow.
          </span>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Approval: own team's Supervisor → Head of Department → the Approval Template. Someone with a Direct Supervisor (Employees → Supervisor) goes to that person instead of the team Supervisor.
      </p>
    </div>
  );
});

// Team -> "Add people": pick Work stations (projects) and a Department, tick
// who to add (or everyone shown), add at once; optionally new joiners there
// join this team by themselves.
function AddPeople({
  teamName,
  departmentId,
  departmentName,
  pool,
  memberIds,
  nowIn,
  onAdd
}: {
  teamName: string;
  departmentId: number;
  departmentName: string;
  pool: Person[];
  memberIds: number[];
  nowIn: (p: Person) => string;
  onAdd: (ids: number[], rules: AutoRule[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Set<string>>(new Set());
  const [dept, setDept] = useState(String(departmentId));
  const [q, setQ] = useState('');
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [auto, setAuto] = useState(true);
  const [done, setDone] = useState('');
  const inDept = (p: Person) => dept === '*' || String(p.department_id || '') === dept;
  const departments = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of pool) if (p.department_id && p.department) m.set(p.department_id, p.department);
    return [...m].filter(([id]) => id !== departmentId).sort((a, b) => a[1].localeCompare(b[1]));
  }, [pool, departmentId]);
  // Work stations with how many people (in the chosen Department) are there.
  const stations = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pool) if (inDept(p)) m.set(branchOf(p), (m.get(branchOf(p)) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, dept]);
  const members = useMemo(() => new Set(memberIds), [memberIds]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return pool.filter(
      (p) => branches.has(branchOf(p)) && inDept(p) && !members.has(p.id) && (!s || [p.name, p.employee_code, p.designation].some((v) => String(v || '').toLowerCase().includes(s)))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, branches, dept, q, members]);
  const picked = list.filter((p) => ticked.has(p.id));
  const moving = picked.filter((p) => nowIn(p)).length;
  const others = picked.filter((p) => p.department_id !== departmentId).length;
  const chip = 'px-2.5 py-1 rounded-full border text-[11px] font-semibold';

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-xl border border-dashed border-orange-300 bg-orange-50 text-orange-700 text-xs font-semibold">
        <UserPlus className="w-3.5 h-3.5" /> Add people by project
      </button>
    );
  return (
    <div className="rounded-2xl border-2 border-orange-300 bg-white p-3 space-y-2.5" aria-label={`Add people to ${teamName}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-800">Add people by project</p>
        <button type="button" aria-label="Close add people" onClick={() => setOpen(false)} className="p-1 rounded-full text-slate-500 hover:bg-slate-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-slate-600 mb-1">1 · Department</p>
        <select aria-label="Department" className={field} value={dept} onChange={(e) => { setDept(e.target.value); setTicked(new Set()); }}>
          <option value={String(departmentId)}>{departmentName} (this department)</option>
          <option value="*">All departments</option>
          {departments.map(([id, name]) => (
            <option key={id} value={String(id)}>{name}</option>
          ))}
        </select>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-slate-600 mb-1">2 · Project / Work station <span className="font-normal text-slate-500">— pick one or more</span></p>
        <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
          {stations.length === 0 && <span className="text-[11px] text-slate-500">Nobody in this department.</span>}
          {stations.map(([b, n]) => {
            const on = branches.has(b);
            return (
              <button key={b} type="button" aria-pressed={on} onClick={() => { setBranches((x) => { const y = new Set(x); on ? y.delete(b) : y.add(b); return y; }); }}
                className={`${chip} ${on ? 'bg-orange-500 border-orange-500 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
                {b} <span className={on ? 'text-white/80' : 'text-slate-400'}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      {branches.size > 0 && (
        <>
          <div className="flex items-center gap-2">
            <input aria-label="Search the list" className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — name, Employee ID, designation" />
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-500">{list.length} not in this team yet · {picked.length} ticked</span>
            <span className="flex gap-3">
              <button type="button" className="font-semibold text-orange-700 hover:underline" onClick={() => setTicked(new Set(list.map((p) => p.id)))}>Select all</button>
              <button type="button" className="font-semibold text-slate-500 hover:underline" onClick={() => setTicked(new Set())}>Clear</button>
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100" role="list">
            {list.length === 0 && <p className="px-3 py-3 text-[11px] text-slate-500">Everyone here is already in this team.</p>}
            {list.map((p) => {
              const w = nowIn(p);
              return (
                <label key={p.id} role="listitem" className="flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" className="mt-0.5 accent-orange-500" checked={ticked.has(p.id)}
                    onChange={(e) => setTicked((x) => { const y = new Set(x); e.target.checked ? y.add(p.id) : y.delete(p.id); return y; })} />
                  <span className="flex-1 min-w-0">
                    <span className="font-semibold text-slate-800">{p.name}</span>
                    <span className="text-slate-500"> · {[p.employee_code, p.designation, dept === '*' ? p.department : null].filter(Boolean).join(' · ')}</span>
                    {w && <span className="block text-[10px] font-semibold text-amber-700">now in {w}</span>}
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">{branchOf(p)}</span>
                </label>
              );
            })}
          </div>
          {(moving > 0 || others > 0) && (
            <div className="text-[11px] px-2.5 py-1.5 rounded-lg bg-amber-50 text-amber-800 space-y-0.5">
              {moving > 0 && <p>{moving} {moving === 1 ? 'is' : 'are'} in another team now — adding moves them here.</p>}
              {others > 0 && <p>{others} from another department: their requests come to this team's Supervisor, then their own department's Head.</p>}
            </div>
          )}
          <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-emerald-600" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Also add <b>new joiners</b> at {[...branches].filter((b) => b !== NO_BRANCH).join(', ') || 'these work stations'} ({dept === '*' ? 'any department' : dept === String(departmentId) ? departmentName : departments.find(([id]) => String(id) === dept)?.[1]}) to this team by themselves</span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-emerald-700">{done}</span>
            <button
              type="button"
              disabled={!picked.length && !auto}
              onClick={() => {
                const rules = auto ? [...branches].filter((b) => b !== NO_BRANCH).map((b) => ({ branch: b, department_id: dept === '*' ? null : Number(dept) })) : [];
                onAdd(picked.map((p) => p.id), rules);
                setDone(`${picked.length} added${rules.length ? ' · new joiners too' : ''} — Save Changes to keep it`);
                setTicked(new Set());
              }}
              className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-orange-500 text-white text-xs font-bold disabled:opacity-40"
            >
              <UserPlus className="w-3.5 h-3.5" /> {picked.length ? `Add ${picked.length} to team` : 'Add the rule'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
