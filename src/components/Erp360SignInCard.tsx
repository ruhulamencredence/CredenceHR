/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users -> "Partner app sign-in (SSO)" (Superadmin only;
// the API is requireSuperAdmin too — Erp360InboundSsoRoutes.ts). Each partner
// application (360 ERP, and any other) gets its OWN App ID / App Secret, IP
// list, per-minute limit, link life and on/off switch, so one can be changed,
// switched off or removed without touching the others. The secret is shown
// once, when made or replaced — only its hash is kept. Below: what happened
// lately (sign-ins and API calls), per application.
// Guide for a partner's developers: docs/CredenceHR-SSO-API.md.

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useHrApi, inputCls } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

type Msg = { type: 'success' | 'error'; text: string } | null;
interface Client {
  id: number;
  name: string;
  app_id: string;
  is_active: boolean;
  allowed_ips: string;
  rate_per_minute: number;
  token_ttl_seconds: number;
  secret_rotated_at: string | null;
  last_used_at: string | null;
}
interface LoginRow {
  id: number;
  client_id: number | null;
  app_name: string | null;
  success: number;
  reason: string | null;
  ip: string | null;
  platform: string | null;
  created_at: string;
  user_name: string | null;
}
interface CallRow {
  id: number;
  client_id: number | null;
  app_name: string | null;
  app_id: string | null;
  ip: string | null;
  status: number;
  message: string | null;
  created_at: string;
}
type Form = { name: string; is_active: boolean; allowed_ips: string; rate_per_minute: string; token_ttl_seconds: string };

const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const toForm = (c: Client): Form => ({
  name: c.name,
  is_active: c.is_active,
  allowed_ips: c.allowed_ips,
  rate_per_minute: String(c.rate_per_minute),
  token_ttl_seconds: String(c.token_ttl_seconds)
});

// One application: its settings, New secret, Remove.
const AppRow: React.FC<{
  client: Client;
  api: ReturnType<typeof useHrApi>;
  onMsg: (m: Msg) => void;
  onSecret: (s: { name: string; app_id: string; secret: string }) => void;
  onChanged: () => void;
}> = ({ client, api, onMsg, onSecret, onChanged }) => {
  const [form, setForm] = useState<Form>(() => toForm(client));
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(toForm(client)), [client]);
  const changed = JSON.stringify(form) !== JSON.stringify(toForm(client));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await api.put(`/api/system/sso-clients/${client.id}`, {
        name: form.name,
        is_active: form.is_active,
        allowed_ips: form.allowed_ips,
        rate_per_minute: Number(form.rate_per_minute),
        token_ttl_seconds: Number(form.token_ttl_seconds)
      });
      onMsg({ type: 'success', text: `${form.name} saved.` });
      onChanged();
    });
  const rotate = async () => {
    if (!(await confirmDialog(`Make a new App Secret for ${client.name}? It stops signing people in until its server is given the new one.`, { tone: 'danger' }))) return;
    await run(async () => {
      const d = await api.post(`/api/system/sso-clients/${client.id}/rotate`, {});
      onSecret({ name: client.name, ...d });
      onChanged();
    });
  };
  const remove = async () => {
    if (!(await confirmDialog(`Remove ${client.name}? Its App ID stops working at once. Its log stays.`, { tone: 'danger' }))) return;
    await run(async () => {
      await api.del(`/api/system/sso-clients/${client.id}`);
      onMsg({ type: 'success', text: `${client.name} removed.` });
      onChanged();
    });
  };

  return (
    <div className={`rounded-xl border p-3 space-y-2.5 ${form.is_active ? 'border-slate-200' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          maxLength={100}
          aria-label="Application name"
          className={`${inputCls} !w-48 font-semibold`}
        />
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${client.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
          {client.is_active ? 'On' : 'Off'}
        </span>
        <span className="text-[11px] text-slate-500">
          App ID <span className="font-mono">{client.app_id}</span> · secret made {when(client.secret_rotated_at)} · last used {when(client.last_used_at)}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Switched on
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-slate-600">Its server IPs (empty = any)</span>
          <input value={form.allowed_ips} onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })} placeholder="e.g. 203.0.113.10" className={`${inputCls} mt-1`} />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-slate-600">Requests per minute</span>
          <input type="number" min={1} max={1000} value={form.rate_per_minute} onChange={(e) => setForm({ ...form, rate_per_minute: e.target.value })} className={`${inputCls} mt-1 w-28`} />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-slate-600">Link valid for (seconds)</span>
          <input type="number" min={30} max={600} value={form.token_ttl_seconds} onChange={(e) => setForm({ ...form, token_ttl_seconds: e.target.value })} className={`${inputCls} mt-1 w-28`} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {changed && (
          <button type="button" disabled={busy || !form.name.trim()} onClick={save} className="text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white disabled:opacity-50">
            Save
          </button>
        )}
        <button type="button" disabled={busy} onClick={rotate} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className="w-3.5 h-3.5" /> New secret
        </button>
        <button type="button" disabled={busy} onClick={remove} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
          <Trash2 className="w-3.5 h-3.5" /> Remove
        </button>
      </div>
    </div>
  );
};

export const Erp360SignInCard: React.FC<{ api: ReturnType<typeof useHrApi>; onMsg: (m: Msg) => void }> = ({ api, onMsg }) => {
  const [data, setData] = useState<{ clients: Client[]; logins: LoginRow[]; calls: CallRow[]; initiate_url: string } | null>(null);
  const [secret, setSecret] = useState<{ name: string; app_id: string; secret: string } | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [logApp, setLogApp] = useState<string>('');

  const load = useCallback(() => {
    api
      .get('/api/system/sso-clients')
      .then(setData)
      .catch((e) => onMsg({ type: 'error', text: e.message }));
  }, [api, onMsg]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => onMsg({ type: 'success', text: 'Copied.' }),
      () => undefined
    );
  };
  const add = async () => {
    const name = (newName || '').trim();
    if (!name) return;
    setBusy(true);
    try {
      const d = await api.post('/api/system/sso-clients', { name });
      setSecret({ name, ...d });
      setNewName(null);
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const logins = data.logins.filter((l) => !logApp || String(l.client_id) === logApp);
  const calls = data.calls.filter((c) => !logApp || String(c.client_id) === logApp);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Link2 className="w-4 h-4 text-violet-600" /> Partner app sign-in (SSO)
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 max-w-3xl">
            Lets someone signed in to another application (360 ERP or any other) open CredenceHR without a password. That application's server asks for a
            one-time link with its own App ID and Secret; the person is matched by <b>email and Employee ID</b>, and the sign-in passes the same checks as a
            password sign-in. Each application below has its own keys and settings.
          </p>
        </div>
        {newName === null && (
          <button type="button" onClick={() => setNewName('')} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white">
            <Plus className="w-3.5 h-3.5" /> Add application
          </button>
        )}
      </div>

      <div className="text-[11px] text-slate-600">
        Every application calls: <span className="font-mono break-all">POST {data.initiate_url}</span>{' '}
        <button type="button" onClick={() => copy(data.initiate_url)} className="inline-flex items-center gap-0.5 text-violet-700 font-semibold">
          <Copy className="w-3 h-3" /> Copy
        </button>
      </div>

      {newName !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/50 p-2.5">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            maxLength={100}
            placeholder="Application name, e.g. 360 ERP"
            className={`${inputCls} !w-64`}
          />
          <button type="button" disabled={busy || !newName.trim()} onClick={add} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white disabled:opacity-50">
            <KeyRound className="w-3.5 h-3.5" /> Make its keys
          </button>
          <button type="button" onClick={() => setNewName(null)} className="text-xs font-semibold px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
        </div>
      )}

      {secret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1.5">
          <div className="font-semibold">Give these to {secret.name} now — the secret is not shown again.</div>
          {[
            ['X-App-Id', secret.app_id],
            ['X-App-Secret', secret.secret]
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-semibold">{k}</span>
              <span className="font-mono break-all flex-1">{v}</span>
              <button type="button" onClick={() => copy(v)} className="shrink-0 text-violet-700" aria-label={`Copy ${k}`}>
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setSecret(null)} className="text-[11px] font-semibold underline">
            I've saved it
          </button>
        </div>
      )}

      {data.clients.length === 0 && newName === null && <p className="text-xs text-slate-400">No application yet. Add one to give it its keys.</p>}
      <div className="space-y-2.5">
        {data.clients.map((c) => (
          <AppRow key={c.id} client={c} api={api} onMsg={onMsg} onSecret={setSecret} onChanged={load} />
        ))}
      </div>

      {(data.logins.length > 0 || data.calls.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setShowLog((v) => !v)} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
            {showLog ? 'Hide' : 'Show'} recent sign-ins and calls
          </button>
          {showLog && data.clients.length > 1 && (
            <select value={logApp} onChange={(e) => setLogApp(e.target.value)} className={`${inputCls} !w-48 !py-1.5 text-xs`} aria-label="Application">
              <option value="">All applications</option>
              {data.clients.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {showLog && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 overflow-auto max-h-72">
            <div className="px-3 py-2 text-[11px] font-bold text-slate-600 bg-slate-50 sticky top-0">Sign-ins (sso_login_logs)</div>
            {logins.length === 0 && <div className="px-3 py-4 text-xs text-slate-400">None yet.</div>}
            {logins.map((l) => (
              <div key={l.id} className="px-3 py-1.5 text-[11px] border-t border-slate-100 flex gap-2">
                <span className={`w-2 h-2 mt-1 rounded-full shrink-0 ${Number(l.success) ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{l.user_name || '—'}</span> · {l.app_name || '—'} · {l.reason || ''} · {l.platform || ''} · {l.ip || ''}
                </span>
                <span className="text-slate-400 shrink-0">{when(l.created_at)}</span>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-slate-200 overflow-auto max-h-72">
            <div className="px-3 py-2 text-[11px] font-bold text-slate-600 bg-slate-50 sticky top-0">API calls (api_access_logs)</div>
            {calls.length === 0 && <div className="px-3 py-4 text-xs text-slate-400">None yet.</div>}
            {calls.map((c) => (
              <div key={c.id} className="px-3 py-1.5 text-[11px] border-t border-slate-100 flex gap-2">
                <span className={`font-mono shrink-0 ${c.status < 400 ? 'text-emerald-700' : 'text-rose-700'}`}>{c.status}</span>
                <span className="flex-1 min-w-0 break-all">
                  <span className="font-semibold">{c.app_name || c.app_id || 'unknown app'}</span> · {c.message || ''} · {c.ip || ''}
                </span>
                <span className="text-slate-400 shrink-0">{when(c.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
