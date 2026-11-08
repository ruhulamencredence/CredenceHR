/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users -> "360 ERP sign-in" (Superadmin only; the API
// is requireSuperAdmin too — Erp360InboundSsoRoutes.ts). Makes the App ID /
// App Secret 360 ERP's server uses to open CredenceHR for someone already
// signed in there, and shows what happened: the latest sign-ins and API
// calls. The secret is shown once, when made or replaced — only its hash is
// kept, so a lost secret is replaced, never shown again.

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Link2, RefreshCw } from 'lucide-react';
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
  success: number;
  reason: string | null;
  ip: string | null;
  platform: string | null;
  created_at: string;
  user_name: string | null;
}
interface CallRow {
  id: number;
  app_id: string | null;
  ip: string | null;
  status: number;
  message: string | null;
  created_at: string;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export const Erp360SignInCard: React.FC<{ api: ReturnType<typeof useHrApi>; onMsg: (m: Msg) => void }> = ({ api, onMsg }) => {
  const [data, setData] = useState<{ clients: Client[]; logins: LoginRow[]; calls: CallRow[]; initiate_url: string } | null>(null);
  const [form, setForm] = useState<{ is_active: boolean; allowed_ips: string; rate_per_minute: string; token_ttl_seconds: string } | null>(null);
  const [secret, setSecret] = useState<{ app_id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(() => {
    api
      .get('/api/system/sso-clients')
      .then((d) => {
        setData(d);
        const c: Client | undefined = d.clients?.[0];
        setForm(c ? { is_active: c.is_active, allowed_ips: c.allowed_ips, rate_per_minute: String(c.rate_per_minute), token_ttl_seconds: String(c.token_ttl_seconds) } : null);
      })
      .catch((e) => onMsg({ type: 'error', text: e.message }));
  }, [api, onMsg]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const client = data.clients[0];
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => onMsg({ type: 'success', text: 'Copied.' }),
      () => undefined
    );
  };

  const create = async () => {
    setBusy(true);
    try {
      const d = await api.post('/api/system/sso-clients', { name: '360 ERP' });
      setSecret(d);
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    if (!client) return;
    if (!(await confirmDialog('Make a new App Secret? 360 ERP stops signing people in until its server is given the new one.', { tone: 'danger' }))) return;
    setBusy(true);
    try {
      setSecret(await api.post(`/api/system/sso-clients/${client.id}/rotate`, {}));
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!client || !form) return;
    setBusy(true);
    try {
      await api.put(`/api/system/sso-clients/${client.id}`, {
        is_active: form.is_active,
        allowed_ips: form.allowed_ips,
        rate_per_minute: Number(form.rate_per_minute),
        token_ttl_seconds: Number(form.token_ttl_seconds)
      });
      onMsg({ type: 'success', text: '360 ERP sign-in saved.' });
      load();
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const changed =
    !!client &&
    !!form &&
    (form.is_active !== client.is_active ||
      form.allowed_ips !== client.allowed_ips ||
      form.rate_per_minute !== String(client.rate_per_minute) ||
      form.token_ttl_seconds !== String(client.token_ttl_seconds));

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
      <div>
        <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <Link2 className="w-4 h-4 text-violet-600" /> 360 ERP sign-in
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Lets someone signed in to 360 ERP open CredenceHR without a password. 360 ERP's server asks for a one-time link with these credentials; the person is
          matched by <b>email and Employee ID</b>, and the sign-in passes the same checks as a password sign-in.
        </p>
      </div>

      <div className="text-[11px] text-slate-600">
        360 ERP calls: <span className="font-mono break-all">POST {data.initiate_url}</span>{' '}
        <button type="button" onClick={() => copy(data.initiate_url)} className="inline-flex items-center gap-0.5 text-violet-700 font-semibold">
          <Copy className="w-3 h-3" /> Copy
        </button>
      </div>

      {secret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1.5">
          <div className="font-semibold">Give these to 360 ERP now — the secret is not shown again.</div>
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

      {!client ? (
        <button type="button" disabled={busy} onClick={create} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white disabled:opacity-50">
          <KeyRound className="w-3.5 h-3.5" /> Make credentials for 360 ERP
        </button>
      ) : (
        form && (
          <>
            <div className="text-[11px] text-slate-600">
              App ID: <span className="font-mono">{client.app_id}</span> · secret made {when(client.secret_rotated_at)} · last used {when(client.last_used_at)}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Switched on
              </label>
              <label className="block lg:col-span-1">
                <span className="text-[11px] font-semibold text-slate-600">360 ERP server IPs (empty = any)</span>
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
                <button type="button" disabled={busy} onClick={save} className="text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white disabled:opacity-50">
                  Save
                </button>
              )}
              <button type="button" disabled={busy} onClick={rotate} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                <RefreshCw className="w-3.5 h-3.5" /> New secret
              </button>
              <button type="button" onClick={() => setShowLog((v) => !v)} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">
                {showLog ? 'Hide' : 'Show'} recent sign-ins and calls
              </button>
            </div>
          </>
        )
      )}

      {showLog && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 overflow-auto max-h-72">
            <div className="px-3 py-2 text-[11px] font-bold text-slate-600 bg-slate-50 sticky top-0">Sign-ins (sso_login_logs)</div>
            {data.logins.length === 0 && <div className="px-3 py-4 text-xs text-slate-400">None yet.</div>}
            {data.logins.map((l) => (
              <div key={l.id} className="px-3 py-1.5 text-[11px] border-t border-slate-100 flex gap-2">
                <span className={`w-2 h-2 mt-1 rounded-full shrink-0 ${Number(l.success) ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{l.user_name || '—'}</span> · {l.reason || ''} · {l.platform || ''} · {l.ip || ''}
                </span>
                <span className="text-slate-400 shrink-0">{when(l.created_at)}</span>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-slate-200 overflow-auto max-h-72">
            <div className="px-3 py-2 text-[11px] font-bold text-slate-600 bg-slate-50 sticky top-0">API calls (api_access_logs)</div>
            {data.calls.length === 0 && <div className="px-3 py-4 text-xs text-slate-400">None yet.</div>}
            {data.calls.map((c) => (
              <div key={c.id} className="px-3 py-1.5 text-[11px] border-t border-slate-100 flex gap-2">
                <span className={`font-mono shrink-0 ${c.status < 400 ? 'text-emerald-700' : 'text-rose-700'}`}>{c.status}</span>
                <span className="flex-1 min-w-0 break-all">
                  {c.message || ''} · {c.ip || ''}
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
