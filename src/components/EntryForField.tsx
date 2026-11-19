/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM entry form: "For (your project)" — only on a Project whose Entry
// sharing is "By home project" (e.g. Central Inventory, PepmTeam.ts). The
// entry is shared with the team of the project it is For. With one project
// of their own it is filled in; with several the person picks; with none
// only they will see the entry. GET /api/entries/for-options.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';

interface Options {
  entry_scope: 'team' | 'own' | 'home';
  homes: { id: number; project_name: string }[];
}

export const EntryForField: React.FC<{
  token: string;
  projectId: string;
  value: string;
  onChange: (v: string) => void;
}> = ({ token, projectId, value, onChange }) => {
  const [opts, setOpts] = useState<Options | null>(null);

  useEffect(() => {
    setOpts(null);
    onChange('');
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/entries/for-options?project_id=${encodeURIComponent(projectId)}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data: Options = await res.json();
        if (cancelled) return;
        setOpts(data);
        if (data.entry_scope === 'home' && data.homes.length === 1) onChange(String(data.homes[0].id));
      } catch {
        // offline: the server fills For itself when there is one choice
      }
    })();
    return () => {
      cancelled = true;
    };
    // onChange is the parent's setter; re-run only for another Project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, token]);

  if (!opts) return null;
  if (opts.entry_scope === 'own') {
    return <p className="text-xs text-slate-500 -mt-2">Entries in this project are seen only by the person who makes them.</p>;
  }
  if (opts.entry_scope !== 'home') return null;

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        For (your project) {opts.homes.length > 1 && <span className="text-slate-400">*</span>}
      </label>
      {opts.homes.length === 0 ? (
        <p className="text-xs text-slate-500 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl">
          You have no other project, so only you will see this entry.
        </p>
      ) : opts.homes.length === 1 ? (
        <input
          type="text"
          readOnly
          value={opts.homes[0].project_name}
          aria-label="For"
          className="block w-full px-4 py-3.5 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-600 text-base sm:text-sm cursor-not-allowed"
        />
      ) : (
        <SearchSelect
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          aria-label="For"
          className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm"
        >
          <option value="">— Select your project —</option>
          {opts.homes.map((h) => (
            <option key={h.id} value={h.id}>
              {h.project_name}
            </option>
          ))}
        </SearchSelect>
      )}
      <p className="text-[11px] text-slate-500 mt-1">Only that project&rsquo;s team sees this entry.</p>
    </div>
  );
};
