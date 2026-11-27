/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Projects -> Add / Edit: "Entry sharing" — who sees this
// Project's PEPM entries (PepmTeam.ts on the server):
//   Team             everyone on the Project sees every entry (default)
//   Own entries only each person sees the entries they made
//   By home project  each entry is For one of its maker's own Projects and
//                    that Project's team shares it (e.g. Central Inventory)
// For a saved "By home project" Project it also lists the old entries whose
// maker works on several Projects, so the Admin picks their For per person.

import React, { useCallback, useEffect, useState } from 'react';
import { Users, User, Network } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';

export type EntryScope = 'team' | 'own' | 'home';

export const ENTRY_SCOPE_LABEL: Record<EntryScope, string> = {
  team: 'Team',
  own: 'Own entries only',
  home: 'By home project'
};

const OPTIONS: { value: EntryScope; title: string; text: string; icon: React.ReactNode }[] = [
  { value: 'team', title: 'Team', text: 'Everyone on this project sees and changes every entry. One Final Submit locks it for all.', icon: <Users className="w-4 h-4" /> },
  { value: 'own', title: 'Own entries only', text: 'Each person sees only the entries they made. Final Submit locks only their own.', icon: <User className="w-4 h-4" /> },
  {
    value: 'home',
    title: 'By home project',
    text: 'Each entry says which of its maker’s own projects it is for (“For: Anamika”). Only that project’s team sees it. People with no other project see only their own.',
    icon: <Network className="w-4 h-4" />
  }
];

interface Gap {
  user_id: number;
  name: string;
  count: number;
  homes: { id: number; project_name: string }[];
}

export const ProjectEntrySharing: React.FC<{
  token: string;
  value: EntryScope;
  onChange: (v: EntryScope) => void;
  // The saved Project (null while adding one) and its saved Entry sharing.
  projectId: number | null;
  savedScope: EntryScope | null;
  // Bumped after a save, to reload the list below.
  reloadKey?: number;
}> = ({ token, value, onChange, projectId, savedScope, reloadKey }) => {
  const [gaps, setGaps] = useState<{ people: Gap[]; no_home: number } | null>(null);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!projectId || savedScope !== 'home') {
      setGaps(null);
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/for-gaps`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setGaps(await res.json());
    } catch {
      // offline: the list just doesn't show
    }
  }, [projectId, savedScope, token]);

  useEffect(() => {
    setMsg('');
    void load();
  }, [load, reloadKey]);

  const fill = async (g: Gap) => {
    const forId = Number(pick[g.user_id] || 0);
    if (!forId || !projectId) return;
    setBusy(g.user_id);
    try {
      const res = await fetch(apiUrl(`/api/projects/${projectId}/for-fill`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: g.user_id, for_project_id: forId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setMsg(`${g.name}: ${data.filled} entr${data.filled === 1 ? 'y' : 'ies'} set.`);
      await load();
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <span className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Entry sharing</span>
      <p className="text-[11px] text-slate-500 mb-2">Who sees this project&rsquo;s PEPM entries (Budget, Jobs, Entry Details, Job Edit).</p>
      <div className="space-y-2" role="radiogroup" aria-label="Entry sharing">
        {OPTIONS.map((o) => {
          const on = value === o.value;
          return (
            <label
              key={o.value}
              className={`flex gap-3 items-start p-3 rounded-xl border cursor-pointer transition-colors ${
                on ? 'border-blue-600 bg-blue-50/60' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
              }`}
            >
              <input type="radio" name="entry_scope" value={o.value} checked={on} onChange={() => onChange(o.value)} className="mt-1 accent-blue-600" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <span className="text-slate-500" aria-hidden="true">{o.icon}</span>
                  {o.title}
                </span>
                <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">{o.text}</span>
              </span>
            </label>
          );
        })}
      </div>
      {projectId && savedScope === 'home' && value === 'home' && gaps && (gaps.people.length > 0 || gaps.no_home > 0) && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
          {gaps.people.length > 0 && (
            <>
              <p className="text-xs font-semibold text-amber-900">Old entries with no &ldquo;For&rdquo;</p>
              <p className="text-[11px] text-amber-800">These people work on more than one project, so pick which one their old entries are for. Until then only they see them.</p>
              {gaps.people.map((g) => (
                <div key={g.user_id} className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-amber-100 p-2">
                  <span className="text-xs font-semibold text-slate-800 min-w-[8rem]">
                    {g.name} <span className="font-normal text-slate-500">· {g.count} entr{g.count === 1 ? 'y' : 'ies'}</span>
                  </span>
                  <div className="flex-1 min-w-[10rem]">
                    <SearchSelect
                      value={pick[g.user_id] || ''}
                      onChange={(e) => setPick((p) => ({ ...p, [g.user_id]: e.target.value }))}
                      className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                      aria-label={`For — ${g.name}`}
                    >
                      <option value="">— For which project —</option>
                      {g.homes.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.project_name}
                        </option>
                      ))}
                    </SearchSelect>
                  </div>
                  <button
                    type="button"
                    disabled={!pick[g.user_id] || busy === g.user_id}
                    onClick={() => fill(g)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg"
                  >
                    Set For
                  </button>
                </div>
              ))}
            </>
          )}
          {gaps.no_home > 0 && (
            <p className="text-[11px] text-amber-800">
              {gaps.no_home} entr{gaps.no_home === 1 ? 'y is' : 'ies are'} from people with no other project — only they see them.
            </p>
          )}
          {msg && <p className="text-[11px] text-slate-700">{msg}</p>}
        </div>
      )}
    </div>
  );
};
