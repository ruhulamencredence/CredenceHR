/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> MIS -> Mail Administration (module "mail_admin",
// MailRoutes.ts): every Credence Mail mailbox connected in this company.
//   read          the list, and the log below
//   mail_open     open someone's mailbox, read only (explicit-only layer)
//   mail_password see a mailbox's saved password (explicit-only layer)
//   mail_settings turn internal delivery on / off, set our domains
//                 (explicit-only layer; everyone with "read" sees the setting)
// Every mailbox opened and every password shown is written to the log.
// The Superadmin's own mailbox only the Superadmin can open.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Search, Eye, KeyRound, Copy, Check, EyeOff, AlertCircle, Lock, History, Loader2, RefreshCw, Building2 } from 'lucide-react';
import type { User } from '../../types';
import { apiUrl } from '../../lib/api';
import { confirmDialog } from '../../lib/confirmDialog';
import { shortMailDate, fullMailDate } from '../../lib/mailApi';

const CredenceMail = lazy(() => import('./CredenceMail').then((m) => ({ default: m.CredenceMail })));

interface AdminMailbox {
  id: number;
  userId: number;
  userName: string;
  userLogin: string;
  emailAddress: string;
  name: string;
  provider: string;
  imapHost: string;
  smtpHost: string;
  lastSyncAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  locked: boolean;
}
interface AdminList {
  canOpen: boolean;
  canPassword: boolean;
  serverReady: boolean;
  items: AdminMailbox[];
}
interface LogRow {
  id: number;
  action: 'open' | 'password';
  at: string | null;
  actor: string;
  target: string;
  mailbox: string | null;
}

interface SystemSettings {
  internalDelivery: boolean;
  domains: string[];
  canEdit: boolean;
}

// Not mailFetch: these calls must never carry X-Mail-View-As.
async function adminFetch<T>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(`/api/mail/admin${path}`), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const PasswordCell: React.FC<{ token: string; box: AdminMailbox }> = ({ token, box }) => {
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const hide = () => {
    setPw(null);
    if (timer.current) clearTimeout(timer.current);
  };
  const show = async () => {
    if (!(await confirmDialog(`Show the saved password of ${box.emailAddress}? It is written in the Mail Administration log.`, { confirmLabel: 'Show password', tone: 'default' }))) return;
    setBusy(true);
    setError('');
    try {
      const r = await adminFetch<{ password: string }>(token, `/accounts/${box.id}/password`, 'POST');
      setPw(r.password);
      // Off the screen again after a minute.
      timer.current = setTimeout(() => setPw(null), 60_000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!pw) return;
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy is blocked here — select the password and copy it.');
    }
  };
  if (pw !== null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-xl bg-amber-50 ring-1 ring-amber-200 pl-2.5 pr-1 py-1 max-w-full">
        <span className="font-mono text-xs text-slate-900 select-all break-all">{pw}</span>
        <button type="button" onClick={() => void copy()} className="p-1 rounded-lg hover:bg-amber-100 text-amber-800" aria-label="Copy password" title="Copy">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <button type="button" onClick={hide} className="p-1 rounded-lg hover:bg-amber-100 text-amber-800" aria-label="Hide password" title="Hide">
          <EyeOff className="w-3.5 h-3.5" />
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => void show()} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} Password
      </button>
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </span>
  );
};

// Mail between our own mailboxes stays inside CredenceHR (MailRoutes.ts,
// "Internal delivery"); only mail to someone outside goes through cPanel.
const InternalDelivery: React.FC<{ token: string }> = ({ token }) => {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    adminFetch<SystemSettings>(token, '/settings')
      .then((r) => {
        setS(r);
        setDomains(r.domains.join(', '));
      })
      .catch((e) => setError(e.message));
  }, [token]);
  const save = async (patch: Partial<Pick<SystemSettings, 'internalDelivery'>> & { domains?: string }) => {
    if (patch.internalDelivery === false && !(await confirmDialog('Turn internal delivery off? Mail between colleagues will go through the mail server (cPanel) again.', { confirmLabel: 'Turn off', tone: 'danger' }))) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const r = await adminFetch<SystemSettings>(token, '/settings', 'PUT', patch);
      setS(r);
      setDomains(r.domains.join(', '));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!s) {
    return error ? (
      <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>
    ) : (
      <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-3" style={{ animation: 'skeleton-in .2s ease both' }}>
        <div className="h-4 w-48 rounded bg-slate-200/80" />
        <div className="h-3 w-full max-w-lg rounded bg-slate-100" />
        <div className="h-9 w-full max-w-md rounded-xl bg-slate-100" />
      </div>
    );
  }
  const changed = domains.split(/[\s,;]+/).filter(Boolean).join(',') !== s.domains.join(',');
  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4 max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Building2 className="w-4 h-4 text-emerald-600" /> Internal delivery</div>
          <p className="text-xs text-slate-600 mt-1">
            Mail from one of our mailboxes to a colleague whose mailbox is connected in Credence Mail is delivered inside CredenceHR, at once — it never goes through the
            mail server (cPanel). Only recipients outside (another domain, or a colleague not on Credence Mail) get it through the mail server. With a mix, each side
            gets one copy, To / Cc stay as written and Bcc stays hidden.
          </p>
        </div>
        <button
          type="button"
          disabled={!s.canEdit || busy}
          onClick={() => void save({ internalDelivery: !s.internalDelivery })}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 ${s.internalDelivery ? 'bg-emerald-500' : 'bg-slate-300'}`}
          title={s.canEdit ? (s.internalDelivery ? 'On — click to turn off' : 'Off — click to turn on') : 'You can see this setting but not change it'}
          aria-label="Internal delivery"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${s.internalDelivery ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      <div>
        <label className="text-xs font-semibold text-slate-700">Our domains</label>
        <div className="mt-1 flex gap-2 flex-wrap">
          <input
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            disabled={!s.canEdit || busy}
            placeholder="credencehousinglimited.com"
            className="flex-1 min-w-[14rem] text-sm px-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:bg-slate-50"
          />
          {s.canEdit && (
            <button type="button" disabled={!changed || busy} onClick={() => void save({ domains })} className="px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-500 mt-1">Comma separated. Only mail sent from and to these domains can stay inside CredenceHR.</p>
      </div>
      <div className="text-[11px] text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
        Internal mail is only in Credence Mail: Outlook or a phone's mail app on the cPanel mailbox doesn't show it.
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {saved && <div className="text-xs text-emerald-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved.</div>}
      {!s.canEdit && <div className="text-[11px] text-slate-500 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Changing this needs the "Internal delivery settings" permission.</div>}
    </div>
  );
};

export const MailAdministration: React.FC<{ token: string; user: User }> = ({ token, user }) => {
  const [tab, setTab] = useState<'boxes' | 'delivery' | 'log'>('boxes');
  const [data, setData] = useState<AdminList | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [opened, setOpened] = useState<AdminMailbox | null>(null);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await adminFetch<AdminList>(token, '/accounts'));
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);
  const loadLog = useCallback(async () => {
    try {
      setLog(await adminFetch<LogRow[]>(token, '/log'));
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (tab === 'log') void loadLog();
  }, [tab, loadLog]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.items || []).filter((b) => !t || `${b.userName} ${b.userLogin} ${b.emailAddress}`.toLowerCase().includes(t));
  }, [data, q]);
  const people = useMemo(() => new Set((data?.items || []).map((b) => b.userId)).size, [data]);

  if (opened) {
    return (
      <Suspense fallback={<div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>}>
        <CredenceMail
          key={opened.userId}
          token={token}
          user={user}
          viewAs={{ userId: opened.userId, name: opened.userName }}
          onBack={() => {
            setOpened(null);
            void load();
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Mail className="w-5 h-5 text-sky-600" /> Mail Administration
        </h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {(
              [
                ['boxes', 'Mailboxes'],
                ['delivery', 'Internal delivery'],
                ['log', 'Log']
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void (tab === 'log' ? loadLog() : load())} className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50" aria-label="Refresh" title="Refresh">
            <RefreshCw className="w-4 h-4 text-slate-600" />
          </button>
        </div>
      </div>

      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      {tab === 'delivery' ? (
        <InternalDelivery token={token} />
      ) : tab === 'boxes' ? (
        <>
          <p className="text-xs text-slate-600">
            Every Credence Mail mailbox connected in this company.
            {data?.canOpen ? ' Opening one shows it read only.' : ''}
            {data?.canOpen || data?.canPassword ? ' Every mailbox opened and every password shown is recorded in the Log.' : ''}
          </p>
          {data && !data.serverReady && (
            <div className="text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">MAIL_ENCRYPTION_KEY isn't set on the server, so mailboxes can't be read or connected.</div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[14rem] max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or mailbox" className="w-full text-sm pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-200" />
            </div>
            {data && <span className="text-xs text-slate-500">{data.items.length} mailbox{data.items.length === 1 ? '' : 'es'} · {people} {people === 1 ? 'person' : 'people'}</span>}
          </div>

          {!data && !error ? (
            <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100" style={{ animation: 'skeleton-in .2s ease both' }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-4">
                  <div className="h-3 w-40 rounded bg-slate-200/80" />
                  <div className="h-3 w-56 rounded bg-slate-100" />
                  <div className="ml-auto h-7 w-20 rounded-xl bg-slate-100" />
                </div>
              ))}
            </div>
          ) : data && !shown.length ? (
            <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{q ? 'No mailbox matches.' : 'Nobody has connected a mailbox yet.'}</div>
          ) : (
            data && (
              <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5 font-semibold">Employee</th>
                        <th className="px-4 py-2.5 font-semibold">Mailbox</th>
                        <th className="px-4 py-2.5 font-semibold">Status</th>
                        {(data.canOpen || data.canPassword) && <th className="px-4 py-2.5 font-semibold text-right">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {shown.map((b) => (
                        <tr key={b.id} className="align-top">
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">{b.userName}</div>
                            {b.userLogin && <div className="text-[11px] text-slate-500">{b.userLogin}</div>}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-slate-800">{b.emailAddress}</div>
                            <div className="text-[11px] text-slate-500">{b.imapHost}{b.connectedAt ? ` · connected ${shortMailDate(b.connectedAt)}` : ''}</div>
                          </td>
                          <td className="px-4 py-3">
                            {b.lastError ? (
                              <span className="inline-flex items-start gap-1 text-[11px] text-rose-600 max-w-[16rem]"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />{b.lastError}</span>
                            ) : (
                              <span className="text-[11px] text-slate-500" title={fullMailDate(b.lastSyncAt)}>{b.lastSyncAt ? `Checked ${shortMailDate(b.lastSyncAt)}` : 'Not checked yet'}</span>
                            )}
                          </td>
                          {(data.canOpen || data.canPassword) && (
                            <td className="px-4 py-3">
                              {b.locked ? (
                                <span className="flex justify-end items-center gap-1 text-[11px] text-slate-400"><Lock className="w-3.5 h-3.5" /> Superadmin only</span>
                              ) : (
                                <div className="flex flex-wrap justify-end items-center gap-2">
                                  {data.canPassword && <PasswordCell token={token} box={b} />}
                                  {data.canOpen && (
                                    <button type="button" onClick={() => setOpened(b)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700">
                                      <Eye className="w-3.5 h-3.5" /> Open
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
          {!log ? (
            <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : !log.length ? (
            <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center gap-2"><History className="w-6 h-6 text-slate-300" /> No mailbox has been opened and no password shown yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">Who</th>
                    <th className="px-4 py-2.5 font-semibold">What</th>
                    <th className="px-4 py-2.5 font-semibold">Whose mailbox</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {log.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">{fullMailDate(r.at)}</td>
                      <td className="px-4 py-2.5 text-slate-800">{r.actor}</td>
                      <td className="px-4 py-2.5">
                        {r.action === 'password' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800"><KeyRound className="w-3 h-3" /> Saw the password</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-800"><Eye className="w-3 h-3" /> Opened the mailbox</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-800">
                        {r.target}
                        {r.mailbox && <span className="text-[11px] text-slate-500"> · {r.mailbox}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MailAdministration;
