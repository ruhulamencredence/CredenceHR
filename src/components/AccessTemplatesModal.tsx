/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> "Access Templates": named access presets
// ("Driver", "Field Staff"…). A template lists feature switches to turn on
// and Admin Panel modules to add; applying it (bulk bar or Manage panel)
// never removes anything the account already has.

import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, Edit2, Search, LayoutTemplate } from 'lucide-react';
import { ADMIN_MODULES } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { AccessTemplate, TEMPLATE_FEATURES, TemplateFeature } from '../lib/accessTemplates';
import { Spinner } from './Spinner';

interface AccessTemplatesModalProps {
  token: string;
  canGrantModuleAccess: boolean;
  templates: AccessTemplate[];
  onChanged: () => void;
  onClose: () => void;
}

const emptyDraft = { id: 0, name: '', description: '', features: [] as TemplateFeature[], modules: [] as string[] };

export function AccessTemplatesModal({ token, canGrantModuleAccess, templates, onChanged, onClose }: AccessTemplatesModalProps) {
  useBackButtonClose(true, onClose);
  const [draft, setDraft] = useState<typeof emptyDraft | null>(null);
  const [moduleQuery, setModuleQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (templates.length === 0) setDraft({ ...emptyDraft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modules = useMemo(
    () => ADMIN_MODULES.filter((m) => m.label.toLowerCase().includes(moduleQuery.trim().toLowerCase())),
    [moduleQuery]
  );

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name: draft.name, description: draft.description, features: draft.features, modules: draft.modules };
      if (draft.id) await call('PUT', `/api/access-templates/${draft.id}`, body);
      else await call('POST', '/api/access-templates', body);
      setDraft(null);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: AccessTemplate) => {
    if (!confirm(`Delete the template “${t.name}”? Accounts it was applied to keep their access.`)) return;
    try {
      await call('DELETE', `/api/access-templates/${t.id}`);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleIn = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <LayoutTemplate className="w-4 h-4 text-blue-600" /> Access Templates
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Ready-made access for a job role. Applying a template turns its switches on and adds its modules — nothing is removed.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && <div className="mb-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5">{error}</div>}

          {!draft && (
            <>
              <div className="space-y-2">
                {templates.map((t) => (
                  <div key={t.id} className="border border-slate-200 rounded-xl px-4 py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{t.name}</div>
                      {t.description && <div className="text-xs text-slate-500">{t.description}</div>}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {t.features.map((f) => (
                          <span key={f} className="text-[11px] px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                            {TEMPLATE_FEATURES.find((x) => x.key === f)?.label || f}
                          </span>
                        ))}
                        {t.modules.map((m) => (
                          <span key={m} className="text-[11px] px-2 py-0.5 rounded-full border bg-violet-50 text-violet-700 border-violet-200">
                            {ADMIN_MODULES.find((x) => x.key === m)?.label || m}
                          </span>
                        ))}
                        {t.features.length === 0 && t.modules.length === 0 && <span className="text-[11px] text-slate-400">Empty template</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setDraft({ ...t })}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => remove(t)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDraft({ ...emptyDraft })}
                className="mt-4 w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-semibold rounded-xl border-2 border-dashed border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700"
              >
                <Plus className="w-4 h-4" /> New template
              </button>
            </>
          )}

          {draft && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Name</span>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g. Driver"
                    className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Description</span>
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Who is this for?"
                    className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </label>
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Switches to turn on</div>
                <div className="mt-1.5 grid sm:grid-cols-2 gap-1.5">
                  {TEMPLATE_FEATURES.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm cursor-pointer hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={draft.features.includes(f.key)}
                        onChange={() => setDraft({ ...draft, features: toggleIn(draft.features, f.key) })}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>

              {canGrantModuleAccess && (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Admin Panel modules to add ({draft.modules.length})</span>
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                      <input
                        value={moduleQuery}
                        onChange={(e) => setModuleQuery(e.target.value)}
                        placeholder="Search modules…"
                        className="pl-7 pr-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="mt-1.5 grid sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-1">
                    {modules.map((m) => (
                      <label key={m.key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 text-xs cursor-pointer hover:bg-slate-50">
                        <input type="checkbox" checked={draft.modules.includes(m.key)} onChange={() => setDraft({ ...draft, modules: toggleIn(draft.modules, m.key) })} />
                        {m.label}
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">Modules are only added to accounts you’re allowed to give modules to.</p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => (templates.length === 0 ? onClose() : setDraft(null))}
                  className="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !draft.name.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving && <Spinner size={14} />} {draft.id ? 'Save template' : 'Create template'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
