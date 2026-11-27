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
//   mail_groups   add / change / remove central mail groups (explicit-only
//                 layer; everyone with "read" sees the groups) — MailGroups.tsx
// Every mailbox opened and every password shown is written to the log.
// The Superadmin's own mailbox only the Superadmin can open.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Search, Eye, KeyRound, Copy, Check, EyeOff, AlertCircle, Lock, History, Loader2, RefreshCw, Building2 } from 'lucide-react';
import type { User } from '../../types';
import { apiUrl } from '../../lib/api';
import { confirmDialog } from '../../lib/confirmDialog';
import { shortMailDate, fullMailDate } from '../../lib/mailApi';
import { CentralGroupsAdmin } from './MailGroups';
import { useElementHeight } from '../../lib/useElementHeight';

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
  // How many mailboxes this person has connected.
  boxes: number;
  locked: boolean;
}
interface AdminList {
  canOpen: boolean;
  canPassword: boolean;
  serverReady: boolean;
  // One page at a time (the server filters, sorts and counts).
  total: number;
  page: number;
  perPage: number;
  pages: number;
  totalMailboxes: number;
  people: number;
  multiPeople: number;
  items: AdminMailbox[];
}
interface LogPage {
  total: number;
  page: number;
  perPage: number;
  pages: number;
  items: LogRow[];
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
  // A colleague not using Credence Mail: through the mail server, or held inside.
  unconnected: 'server' | 'inside';
  canEdit: boolean;
  // Signature links (Signature tab).
  signatureLinks?: { website: string; facebook: string; linkedin: string };
  canEditSignature?: boolean;
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
  const save = async (patch: Partial<Pick<SystemSettings, 'internalDelivery' | 'unconnected'>> & { domains?: string }) => {
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
            mail server (cPanel). Recipients outside (another domain) get it through the mail server, and so does a colleague not on Credence Mail unless set
            otherwise below. With a mix, each side gets one copy, To / Cc stay as written and Bcc stays hidden.
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
      <div>
        <div className="text-xs font-semibold text-slate-700">A colleague not using Credence Mail</div>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Someone who hasn't connected their mailbox in Credence Mail (or has Mail turned off). Mail from someone who has only an inside-only mailbox always stays inside.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="A colleague not using Credence Mail">
          {([
            ['server', 'Through the mail server', 'Goes to their real mailbox — seen in Outlook or the phone, and in Credence Mail once they connect.'],
            ['inside', 'Keep it inside CredenceHR', 'Held in Credence Mail only; they see it when they open Credence Mail. For people with no real mailbox.']
          ] as const).map(([k, title, desc]) => {
            const on = (s.unconnected || 'server') === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!s.canEdit || busy}
                onClick={() => !on && void save({ unconnected: k })}
                className={`text-left rounded-xl border px-3 py-2.5 transition-colors disabled:cursor-not-allowed ${on ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'} ${!s.canEdit ? 'opacity-70' : ''}`}
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                  <span className={`w-3.5 h-3.5 rounded-full border-2 ${on ? 'border-emerald-600 bg-emerald-600 shadow-[inset_0_0_0_2px_white]' : 'border-slate-300'}`} />
                  {title}
                </span>
                <span className="block mt-1 text-[11px] text-slate-500 leading-snug">{desc}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="text-[11px] text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
        Internal mail is only in Credence Mail: Outlook or a phone's mail app on the cPanel mailbox doesn't show it.
      </div>
      <CheckAddress token={token} domain={s.domains[0] || 'credencehousinglimited.com'} />
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {saved && <div className="text-xs text-emerald-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved.</div>}
      {!s.canEdit && <div className="text-[11px] text-slate-500 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Changing this needs the "Internal delivery settings" permission.</div>}
    </div>
  );
};

// Would a mail from one address to another stay inside — and if not, why.
const CheckAddress: React.FC<{ token: string; domain: string }> = ({ token, domain }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [res, setRes] = useState<{ inside: boolean; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = async () => {
    setBusy(true);
    setErr('');
    setRes(null);
    try {
      setRes(await adminFetch(token, `/check?from=${encodeURIComponent(from.trim())}&to=${encodeURIComponent(to.trim())}`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const input = 'flex-1 min-w-[12rem] text-sm px-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-200';
  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="text-xs font-semibold text-slate-700">Check an address</div>
      <p className="text-[11px] text-slate-500 mt-0.5">Does mail from one of our addresses to another stay inside CredenceHR — and if not, why.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder={`From, e.g. you@${domain}`} className={input} />
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={`To, e.g. colleague@${domain}`} className={input} onKeyDown={(e) => e.key === 'Enter' && void check()} />
        <button type="button" disabled={busy || !from.trim() || !to.trim()} onClick={() => void check()} className="px-3 py-2 rounded-xl text-xs font-semibold bg-slate-900 text-white disabled:opacity-40">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Check'}
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}
      {res && (
        <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${res.inside ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
          {res.inside ? res.reason : `Goes through the mail server: ${res.reason}.`}
        </div>
      )}
    </div>
  );
};

// "1–50 of 1,540", first / previous / next / last, and how many to a page.
const PageBar: React.FC<{ page: number; pages: number; total: number; perPage: number; onPage: (p: number) => void; onPerPage: (n: number) => void; busy?: boolean }> = ({ page, pages, total, perPage, onPage, onPerPage, busy }) => {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const btn = 'px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-white">
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <span>{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
        <select value={perPage} onChange={(e) => onPerPage(Number(e.target.value))} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs" aria-label="Rows per page">
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)}>« First</button>
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="px-2 text-xs text-slate-600">Page <b>{page}</b> of {pages}</span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(pages)}>Last »</button>
      </div>
    </div>
  );
};

// The Website / Facebook / LinkedIn links on every Credence design signature.
// Empty = that link is not shown. Changing them needs the "Signature links" permission.
const SignatureLinksSettings: React.FC<{ token: string }> = ({ token }) => {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [form, setForm] = useState({ website: '', facebook: '', linkedin: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    adminFetch<SystemSettings>(token, '/settings')
      .then((r) => {
        setS(r);
        setForm({ website: r.signatureLinks?.website || '', facebook: r.signatureLinks?.facebook || '', linkedin: r.signatureLinks?.linkedin || '' });
      })
      .catch((e) => setError(e.message));
  }, [token]);
  if (!s) {
    return error ? (
      <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>
    ) : (
      <div className="rounded-2xl bg-white border border-slate-200 p-5"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
    );
  }
  const can = !!s.canEditSignature;
  const cur = s.signatureLinks || { website: '', facebook: '', linkedin: '' };
  const changed = form.website.trim() !== cur.website || form.facebook.trim() !== cur.facebook || form.linkedin.trim() !== cur.linkedin;
  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const r = await adminFetch<SystemSettings>(token, '/signature-links', 'PUT', { website: form.website.trim(), facebook: form.facebook.trim(), linkedin: form.linkedin.trim() });
      setS(r);
      setForm({ website: r.signatureLinks?.website || '', facebook: r.signatureLinks?.facebook || '', linkedin: r.signatureLinks?.linkedin || '' });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: 'website' | 'facebook' | 'linkedin', label: string, ph: string) => (
    <div>
      <label className="text-xs font-semibold text-slate-700">{label}</label>
      <input
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        disabled={!can || busy}
        placeholder={ph}
        inputMode="url"
        className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:bg-slate-50"
      />
    </div>
  );
  const shownLinks = [['WEBSITE', form.website], ['FACEBOOK', form.facebook], ['LINKEDIN', form.linkedin]].filter(([, v]) => v.trim());
  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4 max-w-2xl">
      <div>
        <div className="text-sm font-semibold text-slate-900">Signature links</div>
        <p className="text-xs text-slate-600 mt-1">
          The WEBSITE | FACEBOOK | LINKEDIN line at the bottom of every Credence design signature. Each one opens the address you set here. Leave one empty to hide it. A
          change shows in everyone's signatures the next time they open Credence Mail.
        </p>
      </div>
      <div className="grid gap-3">
        {field('website', 'Website', 'https://www.credencehousingltd.com/')}
        {field('facebook', 'Facebook', 'https://www.facebook.com/credencehousingltd/')}
        {field('linkedin', 'LinkedIn', 'https://www.linkedin.com/company/credencehousinglimited/posts/')}
      </div>
      <div>
        <div className="text-xs font-semibold text-slate-700 mb-1">Preview</div>
        <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-[10px] font-bold tracking-wider text-orange-600">
          {shownLinks.length ? shownLinks.map(([label], i) => (
            <span key={label}>{i > 0 && <span className="text-slate-300 mx-1.5">|</span>}{label}</span>
          )) : <span className="font-normal text-slate-400">No links on the signature.</span>}
        </div>
      </div>
      {can && (
        <div className="flex items-center gap-3">
          <button type="button" disabled={!changed || busy} onClick={() => void save()} className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
          </button>
          {saved && <span className="text-xs text-emerald-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved.</span>}
        </div>
      )}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!can && <div className="text-[11px] text-slate-500 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Changing these needs the "Signature links" permission.</div>}
    </div>
  );
};

export const MailAdministration: React.FC<{ token: string; user: User }> = ({ token, user }) => {
  const [tab, setTab] = useState<'boxes' | 'delivery' | 'signature' | 'groups' | 'log'>('boxes');
  // The sticky title / search bar's height, so the column titles stick under it.
  const [barRef, barH] = useElementHeight(56);
  const stickTop = 64 + barH;
  const [data, setData] = useState<AdminList | null>(null);
  const [log, setLog] = useState<LogPage | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [qSent, setQSent] = useState('');
  const [multiOnly, setMultiOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [logPage, setLogPage] = useState(1);
  const [logPerPage, setLogPerPage] = useState(50);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<AdminMailbox | null>(null);

  // Typing in the search box asks the server after a short pause, from page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setQSent((cur) => (cur === q.trim() ? cur : q.trim()));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [qSent, multiOnly, perPage]);
  useEffect(() => setLogPage(1), [logPerPage]);

  const load = useCallback(async () => {
    try {
      setError('');
      setLoading(true);
      const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (qSent) qs.set('q', qSent);
      if (multiOnly) qs.set('multi', '1');
      const r = await adminFetch<AdminList>(token, `/accounts?${qs.toString()}`);
      setData(r);
      if (r.page !== page) setPage(r.page);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, page, perPage, qSent, multiOnly]);
  const loadLog = useCallback(async () => {
    try {
      setError('');
      setLoading(true);
      const r = await adminFetch<LogPage>(token, `/log?page=${logPage}&per_page=${logPerPage}`);
      setLog(r);
      if (r.page !== logPage) setLogPage(r.page);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, logPage, logPerPage]);
  useEffect(() => {
    if (tab === 'boxes') void load();
  }, [tab, load]);
  useEffect(() => {
    if (tab === 'log') void loadLog();
  }, [tab, loadLog]);

  const shown = data?.items || [];
  const multiPeople = data?.multiPeople || 0;
  const people = data?.people || 0;

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
      {/* Desktop: the title, tabs and search stay under the header while the
          list scrolls; the table's column titles stick right under them. */}
      <div ref={barRef} className="md:sticky md:top-16 md:z-20 md:bg-white md:rounded-2xl md:border md:border-slate-200 md:px-3 md:py-2.5 space-y-3">
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
                ['signature', 'Signature'],
                ['groups', 'Groups'],
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
        {tab === 'boxes' && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[14rem] max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or mailbox" className="w-full text-sm pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-200" />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input type="checkbox" checked={multiOnly} onChange={(e) => setMultiOnly(e.target.checked)} className="rounded" />
                Only people with more than one mailbox{multiPeople ? ` (${multiPeople})` : ''}
              </label>
              {data && <span className="text-xs text-slate-500">{data.totalMailboxes.toLocaleString()} mailbox{data.totalMailboxes === 1 ? '' : 'es'} · {people.toLocaleString()} {people === 1 ? 'person' : 'people'}</span>}
            </div>
        )}
      </div>

      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      {tab === 'delivery' ? (
        <InternalDelivery token={token} />
      ) : tab === 'signature' ? (
        <SignatureLinksSettings token={token} />
      ) : tab === 'groups' ? (
        <CentralGroupsAdmin token={token} />
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
              <div className="rounded-2xl bg-white border border-slate-200 overflow-clip">
                <div className="overflow-x-auto xl:overflow-visible">
                  <table className="w-full text-sm">
                    <thead className="sticky z-10 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 shadow-[0_1px_0_rgb(226,232,240)]" style={{ top: stickTop }}>
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
                            {b.boxes > 1 && (
                              <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">{b.boxes} mailboxes</span>
                            )}
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
                <PageBar page={data.page} pages={data.pages} total={data.total} perPage={data.perPage} onPage={setPage} onPerPage={setPerPage} busy={loading} />
              </div>
            )
          )}
        </>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-clip">
          {!log ? (
            <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : !log.items.length ? (
            <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center gap-2"><History className="w-6 h-6 text-slate-300" /> No mailbox has been opened and no password shown yet.</div>
          ) : (
            <div className="overflow-x-auto xl:overflow-visible">
              <table className="w-full text-sm">
                <thead className="sticky z-10 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 shadow-[0_1px_0_rgb(226,232,240)]" style={{ top: stickTop }}>
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">Who</th>
                    <th className="px-4 py-2.5 font-semibold">What</th>
                    <th className="px-4 py-2.5 font-semibold">Whose mailbox</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {log.items.map((r) => (
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
          {log && log.total > 0 && (
            <PageBar page={log.page} pages={log.pages} total={log.total} perPage={log.perPage} onPage={setLogPage} onPerPage={setLogPerPage} busy={loading} />
          )}
        </div>
      )}
    </div>
  );
};

export default MailAdministration;
