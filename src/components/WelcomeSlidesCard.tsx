/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users -> "Welcome slides" (Superadmin only; the API
// is requireSuperAdmin too — WelcomeSlidesRoutes.ts): the four slides every
// account sees once on its first sign-in. Switch them off for everyone, or
// show them once more to everyone (e.g. after a big update). Also the
// Tutorials (guided tours, src/lib/tutorials.ts): on/off for everyone, and
// "Reset tutorials" so every account's ✓ Done goes away.

import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useHrApi } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

type Msg = { type: 'success' | 'error'; text: string } | null;

export const WelcomeSlidesCard: React.FC<{ api: ReturnType<typeof useHrApi>; onMsg: (m: Msg) => void }> = ({ api, onMsg }) => {
  const [s, setS] = useState<{ enabled: boolean; reset_at: string | null; tutorials_enabled: boolean; accounts: number; seen: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .get('/api/system/welcome-slides')
      .then(setS)
      .catch((e) => onMsg({ type: 'error', text: e.message }));
  }, [api, onMsg]);
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.put('/api/system/welcome-slides', { enabled });
      onMsg({ type: 'success', text: enabled ? 'Welcome slides switched on.' : 'Welcome slides switched off for everyone.' });
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const toggleTutorials = async (on: boolean) => {
    setBusy(true);
    try {
      await api.put('/api/system/welcome-slides', { tutorials_enabled: on });
      onMsg({ type: 'success', text: on ? 'Tutorials switched on.' : 'Tutorials switched off for everyone.' });
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const resetTutorials = async () => {
    if (!(await confirmDialog("Mark every tutorial as not done for everyone? Nobody's tours are started for them — the ✓ Done just goes away."))) return;
    setBusy(true);
    try {
      await api.post('/api/system/welcome-slides/reset-tutorials', {});
      onMsg({ type: 'success', text: 'Tutorials reset for everyone.' });
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const showAgain = async () => {
    if (!(await confirmDialog('Show the welcome slides once more to everyone, the next time they open CredenceHR?'))) return;
    setBusy(true);
    try {
      await api.post('/api/system/welcome-slides/show-again', {});
      onMsg({ type: 'success', text: 'Everyone sees the welcome slides once more.' });
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[240px]">
        <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-fuchsia-600" /> Welcome slides &amp; Tutorials
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Four short slides each account sees once, on its first sign-in (website and app). Seen by {s.seen} of {s.accounts} accounts
          {s.reset_at ? ` since ${new Date(s.reset_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}.
        </p>
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} /> Switched on
      </label>
      <button
        type="button"
        disabled={busy || !s.enabled}
        onClick={showAgain}
        className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Show again to everyone
      </button>
      <div className="basis-full border-t border-slate-100" />
      <div className="flex-1 min-w-[240px]">
        <div className="text-sm font-bold text-slate-900">Tutorials</div>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Short guided tours over the real screens (Dashboard, Check In/Out, Leave, Timesheet) — from the last slide's "Show me around" and Menu -&gt; Others -&gt; Tutorials (More on a phone). Each
          account sees only the tours of pages it can open.
        </p>
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
        <input type="checkbox" checked={s.tutorials_enabled} disabled={busy} onChange={(e) => void toggleTutorials(e.target.checked)} /> Switched on
      </label>
      <button
        type="button"
        disabled={busy || !s.tutorials_enabled}
        onClick={resetTutorials}
        className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Reset tutorials
      </button>
    </div>
  );
};
