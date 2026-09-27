/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users: shown while one or more accounts are ticked. Turns a
// switch on/off or applies an Access Template to every selected account,
// one account at a time through the normal per-user endpoints.

import React, { useState } from 'react';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { User } from '../types';
import {
  AccessTemplate,
  AccessViewer,
  BulkResult,
  TEMPLATE_FEATURES,
  TemplateFeature,
  applyTemplateToUser,
  canEditUserFeatures,
  runBulk,
  setFeatureForUser
} from '../lib/accessTemplates';
import { Spinner } from './Spinner';

interface UserBulkBarProps {
  token: string;
  selected: User[];
  templates: AccessTemplate[];
  viewer: AccessViewer;
  onClear: () => void;
  onDone: () => void;
  onOpenTemplates: () => void;
}

export function UserBulkBar({ token, selected, templates, viewer, onClear, onDone, onOpenTemplates }: UserBulkBarProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ title: string; r: BulkResult } | null>(null);

  const run = async (title: string, change: (u: User) => Promise<void>) => {
    const eligible = selected.filter((u) => canEditUserFeatures(u, viewer)).length;
    if (!confirm(`${title} for ${eligible} account${eligible === 1 ? '' : 's'}?`)) return;
    setResult(null);
    setProgress({ done: 0, total: eligible });
    const r = await runBulk(selected, (u) => canEditUserFeatures(u, viewer), change, (done, total) => setProgress({ done, total }));
    setProgress(null);
    setResult({ title, r });
    onDone();
  };

  const onFeature = (value: string, on: boolean) => {
    const f = TEMPLATE_FEATURES.find((x) => x.key === value);
    if (!f) return;
    run(`Turn ${on ? 'on' : 'off'} “${f.label}”`, (u) => setFeatureForUser(token, u, f.key as TemplateFeature, on));
  };

  const onTemplate = (value: string) => {
    if (value === '__manage') return onOpenTemplates();
    const t = templates.find((x) => String(x.id) === value);
    if (!t) return;
    run(`Apply template “${t.name}”`, (u) => applyTemplateToUser(token, t, u, viewer));
  };

  const selectClass =
    'text-xs font-semibold px-2.5 py-1.5 bg-white border border-blue-200 rounded-lg text-slate-700 focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-50';

  return (
    <div className="border-b border-blue-100 bg-blue-50/70">
      <div className="px-6 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-blue-900">{selected.length} selected</span>
        {progress ? (
          <span className="flex items-center gap-2 text-xs text-blue-800">
            <Spinner size={14} /> Updating {progress.done} of {progress.total}…
          </span>
        ) : (
          <>
            <select value="" onChange={(e) => onFeature(e.target.value, true)} className={selectClass}>
              <option value="">Turn on…</option>
              {TEMPLATE_FEATURES.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select value="" onChange={(e) => onFeature(e.target.value, false)} className={selectClass}>
              <option value="">Turn off…</option>
              {TEMPLATE_FEATURES.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select value="" onChange={(e) => onTemplate(e.target.value)} className={selectClass}>
              <option value="">Apply template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="__manage">{templates.length === 0 ? '+ Create a template…' : 'Manage templates…'}</option>
            </select>
          </>
        )}
        <button
          type="button"
          onClick={onClear}
          disabled={!!progress}
          className="ml-auto flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" /> Clear selection
        </button>
      </div>

      {result && (
        <div className="px-6 pb-2.5 text-xs">
          <div className="flex items-start gap-2 text-slate-700">
            {result.r.failed.length === 0 ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            )}
            <div>
              <span className="font-semibold">{result.title}:</span> {result.r.done} updated
              {result.r.skipped.length > 0 && (
                <span className="text-slate-500">
                  {' '}
                  · {result.r.skipped.length} skipped (you can’t change {result.r.skipped.length === 1 ? 'this account' : 'these accounts'}: {result.r.skipped.join(', ')})
                </span>
              )}
              {result.r.failed.length > 0 && (
                <div className="text-rose-600 mt-0.5">
                  {result.r.failed.map((f) => `${f.name}: ${f.error}`).join(' · ')}
                </div>
              )}
            </div>
            <button type="button" onClick={() => setResult(null)} className="ml-auto text-slate-400 hover:text-slate-600" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
