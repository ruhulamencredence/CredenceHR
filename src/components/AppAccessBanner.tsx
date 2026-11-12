/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users: Mobile App (APK) access for many accounts at once
// (AppAccess.ts). Shows how many accounts here can't use the app yet, with
// "Show them" and "Turn on for all", and — for the Superadmin — the workspace
// setting "New accounts get the Mobile App" (an account with nothing set for
// itself follows it). Only for accounts that grant Module Access, under the
// same rule as one account at a time (a delegated Admin: plain Users only).

import React, { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import type { User } from '../types';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { canEditUserModules, type AccessViewer } from '../lib/accessTemplates';

export async function setAppForUsers(token: string, ids: number[], on: boolean): Promise<{ done: number; skipped: string[] }> {
  const res = await fetch(apiUrl('/api/app-access/bulk'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ user_ids: ids, can_use_app: on })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Could not change the Mobile App access.');
  return { done: Number(data.done) || 0, skipped: data.skipped || [] };
}

export const AppAccessBanner: React.FC<{
  token: string;
  users: User[];
  viewer: AccessViewer;
  showingOff: boolean;
  onShowOff: () => void;
  onDone: () => void;
}> = ({ token, users, viewer, showingOff, onShowOff, onDone }) => {
  const [setting, setSetting] = useState<{ on: boolean; canChange: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(apiUrl('/api/app-access/settings'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSetting({ on: !!d.new_accounts_app, canChange: !!d.can_change }))
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const off = users.filter((u) => u.app_on === false && !u.is_blocked && canEditUserModules(u, viewer));

  const turnOnAll = async () => {
    if (!off.length) return;
    if (!(await confirmDialog(`Turn on the Mobile App for ${off.length} account${off.length === 1 ? '' : 's'}? They can sign in to the app with the same access they have on the website.`, { confirmLabel: 'Turn on' }))) return;
    setBusy(true);
    setError('');
    try {
      const r = await setAppForUsers(token, off.map((u) => u.id), true);
      setNotice(`Mobile App turned on: ${r.done} account${r.done === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`);
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changeSetting = async (on: boolean) => {
    if (!setting) return;
    if (
      !(await confirmDialog(
        on
          ? 'New accounts get the Mobile App from day one (with the same access as the website). Accounts already set to off stay off.'
          : 'New accounts start website-only; turn the app on for each when needed. Accounts already turned on keep it.',
        { confirmLabel: on ? 'Turn on' : 'Turn off' }
      ))
    )
      return;
    setError('');
    try {
      const res = await fetch(apiUrl('/api/app-access/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ new_accounts_app: on })
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || 'Could not save.');
      setSetting({ ...setting, on });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!viewer.canGrantModuleAccess) return null;
  return (
    <div className="px-6 py-3 border-b border-slate-100 space-y-2">
      {off.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-orange-50 border border-orange-200 px-4 py-3">
          <span className="w-9 h-9 rounded-xl bg-orange-600 text-white flex items-center justify-center shrink-0">
            <Smartphone className="w-4.5 h-4.5" />
          </span>
          <span className="flex-1 min-w-[14rem]">
            <span className="block text-sm font-bold text-slate-900">
              {off.length} account{off.length === 1 ? " can't" : "s can't"} use the Mobile App yet
            </span>
            <span className="block text-xs text-orange-800">They can only use the website. Turned on, the app gets exactly what they have on the website.</span>
          </span>
          {!showingOff && (
            <button type="button" onClick={onShowOff} className="h-9 px-4 rounded-full border border-orange-300 bg-white text-orange-800 text-xs font-semibold">
              Show them
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void turnOnAll()} className="h-9 px-4 rounded-full bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold disabled:opacity-60">
            {busy ? 'Turning on…' : `Turn on for all ${off.length}`}
          </button>
        </div>
      )}
      {setting && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span>
            New accounts get the Mobile App: <b className={setting.on ? 'text-emerald-700' : 'text-slate-700'}>{setting.on ? 'On' : 'Off'}</b>
            <span className="text-slate-400"> — a login made from now on (Users, Employees, Data Import){setting.on ? ' can use the app straight away' : ' starts website-only'}.</span>
          </span>
          {setting.canChange && (
            <button
              type="button"
              role="switch"
              aria-checked={setting.on}
              aria-label="New accounts get the Mobile App"
              onClick={() => void changeSetting(!setting.on)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${setting.on ? 'bg-emerald-500' : 'bg-slate-300'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${setting.on ? 'translate-x-[18px]' : 'translate-x-1'}`} />
            </button>
          )}
        </div>
      )}
      {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
    </div>
  );
};
