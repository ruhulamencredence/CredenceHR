/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Device Access (Superadmin only): which phone each account
// may use the mobile app on (DeviceRoutes.ts). An account signs in to the app
// on one phone; signing in on another waits here, where the Superadmin moves
// the account to the new phone or allows one more. Removing a phone signs it
// out. The website is never limited.

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Search, Smartphone, Trash2, X } from 'lucide-react';
import { useHrApi, Notice, btnGhost, btnPrimary } from './uiKit';
import { confirmDialog } from '../lib/confirmDialog';
import { PagerBar } from './PagerBar';

interface Phone {
  id: number;
  name: string;
  platform: string | null;
  status: string;
  requested_at: string | null;
  approved_at: string | null;
  last_seen_at: string | null;
  created_at: string | null;
}
interface Account {
  id: number;
  name: string;
  email: string | null;
  role: string;
  exempt: boolean;
  max_devices: number;
  devices: Phone[];
  pending: Phone[];
}
type Msg = { type: 'success' | 'error'; text: string } | null;

// Loading placeholder in the page's own shape: title, search box and the
// Account / Phones / Phones allowed table.
const DeviceAccessSkeleton: React.FC = () => {
  const bar = (w: string, tone = 'bg-slate-200/80') => <div className={`h-3 rounded ${tone} ${w}`} />;
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading device access">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-blue-100" />
          {bar('w-36 h-4')}
        </div>
        {bar('w-full max-w-xl', 'bg-slate-100')}
      </div>
      <div className="h-8 max-w-xs rounded-lg border border-slate-200 bg-white" />
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-3 py-2.5 grid grid-cols-[2fr_3fr_1fr] gap-4">
          {bar('w-16', 'bg-slate-200')}
          {bar('w-14', 'bg-slate-200')}
          {bar('w-24', 'bg-slate-200')}
        </div>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="border-t border-slate-100 px-3 py-3 grid grid-cols-[2fr_3fr_1fr] gap-4 items-start">
            <div className="space-y-1.5">
              {bar(i % 2 ? 'w-28' : 'w-36')}
              {bar(i % 3 ? 'w-40' : 'w-32', 'bg-slate-100')}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3.5 h-3.5 rounded bg-slate-200" />
              {bar(i % 2 ? 'w-24' : 'w-32')}
              {bar('w-20', 'bg-slate-100')}
            </div>
            <div className="h-6 w-12 rounded-lg border border-slate-200 bg-white" />
          </div>
        ))}
      </div>
    </div>
  );
};

const when = (v: string | null) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');

export const DeviceAccess: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [maxLimit, setMaxLimit] = useState(5);
  const [q, setQ] = useState('');
  // Only one page of the accounts is drawn at a time.
  const [pg, setPg] = useState(1);
  const [pgSize, setPgSize] = useState(50);
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(() => {
    api
      .get('/api/devices')
      .then((d) => {
        setAccounts(d.users);
        setMaxLimit(d.max_limit || 5);
      })
      .catch((e) => {
        setAccounts([]);
        setMsg({ type: 'error', text: e.message });
      });
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<any>, text: string) => {
    try {
      await fn();
      setMsg({ type: 'success', text });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  if (!accounts) return <DeviceAccessSkeleton />;
  const waiting = accounts.filter((a) => a.pending.length > 0);
  const shown = accounts.filter((a) => !q.trim() || [a.name, a.email].some((v) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-blue-600" /> Device Access
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Each account uses the mobile app on one phone. Signing in on another phone waits here for you. The website isn't limited. Superadmins aren't limited.
        </p>
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />

      {waiting.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
          <div className="text-sm font-semibold text-amber-900">Waiting for approval ({waiting.reduce((n, a) => n + a.pending.length, 0)})</div>
          {waiting.flatMap((a) =>
            a.pending.map((p) => (
              <div key={p.id} className="rounded-lg border border-amber-200 bg-white p-3 flex flex-wrap items-center gap-3 justify-between">
                <div className="min-w-0 text-xs">
                  <div className="text-sm font-semibold text-slate-800">{a.name}</div>
                  <div className="text-slate-500">{a.email}</div>
                  <div className="mt-1">
                    New phone: <span className="font-semibold text-slate-800">{p.name}</span> · asked {when(p.requested_at)}
                  </div>
                  <div className="text-slate-500">
                    Now on: {a.devices.map((d) => d.name).join(', ') || 'no phone'}
                  </div>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={() => run(() => api.post(`/api/devices/${p.id}/approve`, { mode: 'replace' }), `${a.name} now uses the app on ${p.name}. The old phone is signed out.`)}
                    title="The account moves to this phone; its old phone is signed out"
                  >
                    <Check className="w-3.5 h-3.5" /> Move to this phone
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => run(() => api.post(`/api/devices/${p.id}/approve`, { mode: 'add' }), `${a.name} can now use one more phone.`)}
                    title="Keep the old phone and allow this one too"
                  >
                    <Plus className="w-3.5 h-3.5" /> Allow one more
                  </button>
                  <button
                    type="button"
                    className={`${btnGhost} text-rose-600`}
                    onClick={() => run(() => api.del(`/api/devices/${p.id}`), `${p.name} was turned away.`)}
                  >
                    <X className="w-3.5 h-3.5" /> Turn away
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="relative max-w-xs">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPg(1);
          }}
          placeholder="Search account"
          className="w-full pl-7 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Account</th>
              <th className="px-3 py-2 font-semibold">Phones</th>
              <th className="px-3 py-2 font-semibold">Phones allowed</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice((pg - 1) * pgSize, pg * pgSize).map((a) => (
              <tr key={a.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2.5">
                  <div className="font-semibold text-slate-800">{a.name}</div>
                  <div className="text-slate-500">{a.email}</div>
                </td>
                <td className="px-3 py-2.5">
                  {a.devices.length === 0 && <span className="text-slate-400">Not signed in on the app yet</span>}
                  <div className="space-y-1">
                    {a.devices.map((d) => (
                      <div key={d.id} className="flex items-center gap-2">
                        <Smartphone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="text-slate-700">{d.name}</span>
                        <span className="text-[10px] text-slate-400">last used {when(d.last_seen_at)}</span>
                        <button
                          type="button"
                          className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                          aria-label={`Remove ${d.name} from ${a.name}`}
                          title="Remove this phone (it is signed out)"
                          onClick={async () => {
                            if ((await confirmDialog(`Remove ${d.name} from ${a.name}? That phone is signed out; the next phone they sign in on is allowed straight away.`)))
                              run(() => api.del(`/api/devices/${d.id}`), `${d.name} was removed from ${a.name}.`);
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {a.pending.length > 0 && <div className="text-[10px] font-semibold text-amber-700">{a.pending.length} waiting for approval</div>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {a.exempt ? (
                    <span className="text-slate-400">Not limited</span>
                  ) : (
                    <select
                      aria-label={`Phones allowed for ${a.name}`}
                      value={a.max_devices}
                      onChange={(e) => run(() => api.put(`/api/devices/users/${a.id}/limit`, { max_devices: Number(e.target.value) }), `${a.name} may now use ${e.target.value} phone(s).`)}
                      className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
                    >
                      {Array.from({ length: maxLimit }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <PagerBar page={pg} pageSize={pgSize} total={shown.length} onPage={setPg} onPageSize={(n) => { setPgSize(n); setPg(1); }} />
      </div>
    </div>
  );
};
