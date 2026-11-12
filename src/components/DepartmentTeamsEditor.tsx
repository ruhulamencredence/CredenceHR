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

import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';

interface Person {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
}
interface Team {
  key: string;
  id: number | null;
  name: string;
  supervisor_user_id: string;
  everyone_else: boolean;
  member_ids: number[];
}
export interface DepartmentTeamsEditorHandle {
  save: (headUserId: number | null) => Promise<void>;
}

const field = 'block w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none';
const personText = (p: Person) => [p.name, p.employee_code, p.designation].filter(Boolean).join(' · ');
let seq = 0;

export const DepartmentTeamsEditor = forwardRef<
  DepartmentTeamsEditorHandle,
  { token: string; departmentId: number; departmentName: string; supervisors: { value: string; label: string }[] }
>(function DepartmentTeamsEditor({ token, departmentId, departmentName, supervisors }, ref) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
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
        setTeams(
          (j.teams || []).map((t: any) => ({
            key: `t${t.id}`,
            id: t.id,
            name: t.name,
            supervisor_user_id: t.supervisor_user_id ? String(t.supervisor_user_id) : '',
            everyone_else: !!t.everyone_else,
            member_ids: t.member_ids || []
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
          teams: teams.map((t) => ({ id: t.id, name: t.name.trim(), supervisor_user_id: t.supervisor_user_id ? Number(t.supervisor_user_id) : null, everyone_else: t.everyone_else, member_ids: t.member_ids }))
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Could not save the teams.');
    }
  }));

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const teamOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of teams || []) for (const id of t.member_ids) m.set(id, t.key);
    return m;
  }, [teams]);
  const catchAll = (teams || []).find((t) => t.everyone_else);
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
          onClick={() => setTeams((ts) => [...(ts || []), { key: `n${++seq}`, id: null, name: '', supervisor_user_id: '', everyone_else: false, member_ids: [] }])}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-dashed border-orange-300 bg-orange-50 text-orange-700 text-xs font-semibold"
        >
          <Plus className="w-3.5 h-3.5" /> Add team
        </button>
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!teams.length && <p className="text-xs text-slate-500">No teams yet. Without a team, everyone's requests go to the Head of Department, then the workflow.</p>}
      <div className="grid md:grid-cols-2 gap-3">
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
            <div className="flex flex-wrap gap-1.5">
              {t.member_ids.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold">
                  {byId.get(id)?.name || `#${id}`}
                  <button type="button" aria-label={`Take ${byId.get(id)?.name || id} out of ${t.name}`} onClick={() => set(t.key, { member_ids: t.member_ids.filter((x) => x !== id) })} className="p-0.5 rounded-full hover:bg-blue-100">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <SearchSelect
              aria-label={`Add member to ${t.name || `team ${i + 1}`}`}
              className={field}
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (!id) return;
                // One team per person: taken out of any other team.
                setTeams((ts) => (ts || []).map((x) => (x.key === t.key ? { ...x, member_ids: [...x.member_ids.filter((y) => y !== id), id] } : { ...x, member_ids: x.member_ids.filter((y) => y !== id) })));
              }}
            >
              <option value="">— Add member —</option>
              {people
                .filter((p) => teamOf.get(p.id) !== t.key)
                .map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {personText(p)}
                    {teamOf.has(p.id) ? ` (now in ${teams.find((x) => x.key === teamOf.get(p.id))?.name || 'another team'})` : ''}
                  </option>
                ))}
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
