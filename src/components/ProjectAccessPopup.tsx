/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> a user -> "Projects (Budget / Jobs / MPR)":
// which Projects this account works on. A ticked Project makes it part of that
// Project's PEPM team (PepmTeam.ts), so each ticked one says who else is on it
// and, by the Project's Entry sharing, what this person will see there.
// Ticked Projects come first.

import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import type { Project, User, UserProjectPermission } from '../types';
import { ENTRY_SCOPE_LABEL, type EntryScope } from './ProjectEntrySharing';

const scopeOf = (p: Project): EntryScope => (p.entry_scope as EntryScope) || 'team';

export const ProjectAccessPopup: React.FC<{
  user: User;
  projects: Project[];
  users: User[];
  permissions: UserProjectPermission[];
  selected: Set<number>;
  onToggle: (projectId: number) => void;
  search: string;
  onSearch: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}> = ({ user, projects, users, permissions, selected, onToggle, search, onSearch, saving, onSave, onClose }) => {
  const nameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of users) m.set(Number(u.id), u.name);
    return m;
  }, [users]);
  // Everyone else on each Project (saved access).
  const others = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const p of permissions) {
      if (Number(p.user_id) === Number(user.id)) continue;
      const n = nameOf.get(Number(p.user_id));
      if (!n) continue;
      const list = m.get(Number(p.project_id)) || [];
      list.push(n);
      m.set(Number(p.project_id), list);
    }
    for (const list of m.values()) list.sort((a, b) => a.localeCompare(b));
    return m;
  }, [permissions, user.id, nameOf]);
  // This person's home Projects, as ticked right now (what a "By home project" entry can be For).
  const homes = projects.filter((p) => selected.has(p.id) && scopeOf(p) !== 'home').map((p) => p.project_name);

  const q = search.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.project_name.toLowerCase().includes(q)) : projects;
  const on = shown.filter((p) => selected.has(p.id));
  const off = shown.filter((p) => !selected.has(p.id));

  const short = (names: string[]) => (names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`);
  const line = (p: Project): string => {
    const scope = scopeOf(p);
    const team = others.get(p.id) || [];
    if (scope === 'own') return 'Sees only the entries they make here.';
    if (scope === 'home') {
      return homes.length
        ? `Sees the entries made for ${homes.join(' and ')} (their team's), plus their own.`
        : 'No other project ticked, so sees only their own entries here.';
    }
    return team.length ? `Team: ${short(team)} — everyone sees every entry.` : 'Nobody else yet — whoever is added later sees every entry too.';
  };

  const row = (p: Project, ticked: boolean) => {
    const scope = scopeOf(p);
    return (
      <label
        key={p.id}
        className={`flex items-start gap-3 p-3 rounded-[18px] cursor-pointer transition-colors liquid-glass-inset ${ticked ? 'ring-2 ring-blue-500/70' : ''}`}
      >
        <input
          type="checkbox"
          checked={ticked}
          onChange={() => onToggle(p.id)}
          className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-900">{p.project_name}</span>
            {scope !== 'team' && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 whitespace-nowrap">
                {ENTRY_SCOPE_LABEL[scope]}
              </span>
            )}
          </span>
          {ticked && <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">{line(p)}</span>}
        </span>
      </label>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Project Access"
        className="liquid-glass liquid-glass-in rounded-[32px] max-w-md w-full max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
        <div className="px-5 pt-5 pb-3 pr-14">
          <h3 className="text-base font-bold text-slate-900">Project Access</h3>
          <p className="text-xs text-slate-500 truncate">
            {user.name}
            {user.email ? ` · ${user.email}` : ''}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">A ticked project puts them on its PEPM team.</p>
        </div>

        {projects.length > 0 && (
          <div className="px-5 pb-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search Project Name..."
                autoComplete="off"
                aria-label="Search projects"
                className="liquid-glass-inset block w-full pl-10 pr-3 py-2 rounded-2xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
              />
            </div>
          </div>
        )}

        <div className="px-5 pb-3 overflow-y-auto flex-1 space-y-2">
          {projects.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No projects exist yet. Add one from the Projects tab first.</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No Project matches &ldquo;{search}&rdquo;.</p>
          ) : (
            <>
              {on.length > 0 && <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 pt-1">Given · {on.length}</p>}
              {on.map((p) => row(p, true))}
              {off.length > 0 && on.length > 0 && <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 pt-2">Other projects</p>}
              {off.map((p) => row(p, false))}
            </>
          )}
        </div>

        <div className="px-5 py-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="liquid-glass-chip px-5 py-2.5 rounded-full text-slate-700 text-xs font-semibold">
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving} className="liquid-glass-button rounded-full px-5 py-2.5 text-xs font-semibold disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Access'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
