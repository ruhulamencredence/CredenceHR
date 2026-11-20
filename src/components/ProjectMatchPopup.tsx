/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Budget Excel import: project names in the sheet that aren't in Admin Panel
// -> Projects. For each, pick the Project it means (look-alikes first) or add
// it as a new Project; then the import runs again with that choice
// (POST /api/budgets/:id/import, project_map).

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { SearchSelect } from './Combobox';

export interface UnknownProject {
  name: string;
  rows: number;
  suggestions: { id: number; name: string }[];
}

export const ProjectMatchPopup: React.FC<{
  unknown: UnknownProject[];
  projects: { id: number; project_name: string }[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (map: Record<string, number | 'new'>) => void;
}> = ({ unknown, projects, busy, onCancel, onConfirm }) => {
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(unknown.map((u) => [u.name, u.suggestions.length === 1 ? String(u.suggestions[0].id) : '']))
  );
  const ready = unknown.every((u) => map[u.name]);
  return createPortal(
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4">
      <div role="dialog" aria-label="Match project names" className="liquid-glass liquid-glass-in rounded-[32px] max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <button type="button" onClick={onCancel} className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
        <div className="px-5 pt-5 pb-3 pr-14">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" /> Project names not in Projects
          </h3>
          <p className="text-xs text-slate-600 mt-1">
            Nothing is saved yet. Pick the project each name means, so the rows join that project — or add it as a new project if it really is one.
          </p>
        </div>
        <div className="px-5 pb-3 overflow-y-auto space-y-3">
          {unknown.map((u) => (
            <div key={u.name} className="liquid-glass-inset rounded-2xl p-3 space-y-2">
              <div className="text-sm">
                <b className="text-slate-900">&ldquo;{u.name}&rdquo;</b> <span className="text-xs text-slate-500">· {u.rows} row{u.rows === 1 ? '' : 's'}</span>
              </div>
              <SearchSelect
                value={map[u.name] || ''}
                onChange={(e) => setMap((m) => ({ ...m, [u.name]: e.target.value }))}
                aria-label={`Project for ${u.name}`}
                className="block w-full px-3 py-2 bg-white/80 border border-slate-200 rounded-xl text-sm"
              >
                <option value="">— Pick the project —</option>
                <option value="new">+ Add &ldquo;{u.name}&rdquo; as a new project</option>
                {u.suggestions.map((s) => (
                  <option key={`s${s.id}`} value={s.id}>
                    {s.name} (looks alike)
                  </option>
                ))}
                {projects
                  .filter((p) => !u.suggestions.some((s) => s.id === p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.project_name}
                    </option>
                  ))}
              </SearchSelect>
            </div>
          ))}
        </div>
        <div className="px-5 py-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="liquid-glass-chip px-5 py-2.5 rounded-full text-slate-700 text-xs font-semibold">
            Cancel import
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => onConfirm(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === 'new' ? 'new' : Number(v)])))}
            className="liquid-glass-button rounded-full px-5 py-2.5 text-xs font-semibold disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import with these projects'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
