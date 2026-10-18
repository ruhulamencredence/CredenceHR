/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> Credence Mail (MailRoutes.ts, users.can_use_mail): each
// person's own mailbox inside CredenceHR. Desktop: folders | list | mail.
// Phone / app: one at a time (list -> mail), folders in a side drawer.
// New mail arrives live over the app's socket ("mail:new" / "mail:changed").

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  ArrowLeft, Mail, Inbox, Star, Send, FileText, Clock, Archive, ShieldAlert, Trash2, AlertCircle, Pencil, RefreshCw, Search, X, Menu, Paperclip,
  CheckSquare, Square, MailOpen, Plus, Loader2, Server, ChevronDown, Bookmark, LogOut, Check,
  Users, ListChecks, Filter, BarChart3, Settings, Tag, Eye
} from 'lucide-react';
import { ModulePath } from '../ModulePath';
import { confirmDialog } from '../../lib/confirmDialog';
import { connectChatSocket } from '../../lib/chatSocket';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { useKeyboardInset, scrollFocusedFieldIntoView } from '../../lib/useKeyboardInset';
import type { User } from '../../types';
import {
  MAIL_CATEGORIES, MAIL_FOLDERS, MailAccount, MailContact, MailCounts, MailFilter, MailList, MailMessage, MailSettings, MailStatus, MailTemplate, SYSTEM_LABELS, mailFetch,
  setMailTimeZone, setMailViewAs, shortMailDate, fullMailDate
} from '../../lib/mailApi';
import { MailReader, ReaderAction, MailAvatar } from './MailReader';
import { MailCompose, ComposeInit } from './MailCompose';
import { sanitizeMailHtml } from './MailBody';
import { MailSettingsPopup } from './MailSettings';
import { MailRulesPopup, MailTemplatesPopup, MailContactsPopup, MailPlannerPopup, FromMail } from './MailTools';
import { MailAnalyticsPopup } from './MailAnalytics';

type Tool =
  | { kind: 'settings'; tab?: string }
  | { kind: 'rules'; prefill?: Partial<MailFilter> }
  | { kind: 'templates' }
  | { kind: 'contacts'; prefill?: Partial<MailContact> }
  | { kind: 'planner'; tab: 'tasks' | 'calendar'; fromMail?: FromMail }
  | { kind: 'analytics' };

const FOLDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Inbox, Starred: Star, Important: Bookmark, Sent: Send, Drafts: FileText, Scheduled: Clock, Archive, Spam: ShieldAlert, Trash: Trash2
};
const PAGE = 50;

// Mail server settings for a new mailbox (same presets as MailRoutes.ts).
// Anything that isn't a known provider is taken to be on the Credence server.
const CREDENCE_DOMAIN = 'credencehousinglimited.com';
interface ServerFields {
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  username: string;
}
const srv = (imapHost: string, smtpHost: string, smtpPort = '465', smtpSecure = true): ServerFields => ({ imapHost, imapPort: '993', imapSecure: true, smtpHost, smtpPort, smtpSecure, username: '' });
function presetFor(email: string): ServerFields {
  const d = (email.split('@')[1] || '').toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return srv('imap.gmail.com', 'smtp.gmail.com');
  if (/(^|\.)(outlook|hotmail|live)\./.test(d)) return srv('outlook.office365.com', 'smtp.office365.com', '587', false);
  if (d.startsWith('yahoo.')) return srv('imap.mail.yahoo.com', 'smtp.mail.yahoo.com');
  if (d.startsWith('zoho.')) return srv('imap.zoho.com', 'smtp.zoho.com');
  return srv(CREDENCE_DOMAIN, CREDENCE_DOMAIN);
}

// ---------------------------------------------------------------------------
// Connect a mailbox (first time, or another one)
// ---------------------------------------------------------------------------
const ConnectMailbox: React.FC<{ token: string; userName: string; onConnected: (a: MailAccount) => void; onCancel?: () => void; serverReady: boolean }> = ({
  token, userName, onConnected, onCancel, serverReady
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(userName);
  const [advanced, setAdvanced] = useState(false);
  // Server settings start as the Credence mail server; another provider's
  // address fills in its own — until the person changes a field by hand.
  const [server, setServer] = useState<ServerFields>({ ...presetFor('') });
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputCls = 'w-full text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-200 focus:outline-none';
  // Just the name part ("rahim") means a Credence address.
  const fullEmail = (v: string) => {
    const t = v.trim().toLowerCase();
    return t && !t.includes('@') ? `${t}@${CREDENCE_DOMAIN}` : t;
  };
  const setField = (patch: Partial<ServerFields>) => {
    setEdited(true);
    setServer((f) => ({ ...f, ...patch }));
  };
  useEffect(() => {
    if (!edited) setServer({ ...presetFor(fullEmail(email)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, edited]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const addr = fullEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(addr)) return setError('Enter your email address.');
    if (!password) return setError('Enter the mailbox password.');
    if (!server.imapHost.trim() || !server.smtpHost.trim()) {
      setAdvanced(true);
      return setError('Fill in the incoming (IMAP) and outgoing (SMTP) servers.');
    }
    setBusy(true);
    try {
      const body: any = {
        email: addr,
        password,
        name: name.trim(),
        imapHost: server.imapHost.trim(),
        imapPort: Number(server.imapPort) || 993,
        imapSecure: server.imapSecure,
        smtpHost: server.smtpHost.trim(),
        smtpPort: Number(server.smtpPort) || 465,
        smtpSecure: server.smtpSecure,
        username: server.username.trim() || undefined
      };
      onConnected(await mailFetch<MailAccount>(token, '/accounts', { method: 'POST', body }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!serverReady) {
    return (
      <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center max-w-md mx-auto">
        <Server className="w-8 h-8 text-slate-300 mx-auto" />
        <p className="mt-3 text-sm text-slate-600">Credence Mail isn't set up on the server yet. Ask the system administrator to add MAIL_ENCRYPTION_KEY.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} onFocusCapture={scrollFocusedFieldIntoView} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Email address</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="text" inputMode="email" autoComplete="email" autoCapitalize="none" placeholder="you@credencehousinglimited.com" className={inputCls} autoFocus />
        {email.trim() && !email.includes('@') && <p className="mt-1 text-[11px] text-slate-500">{fullEmail(email)}</p>}
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Mailbox password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" className={inputCls} />
        <p className="mt-1 text-[11px] text-slate-500">The password of your mailbox (cPanel / webmail), not your CredenceHR password. It is kept encrypted.</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Name shown to people you write to</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </div>
      <div className="rounded-2xl liquid-glass-inset p-3">
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-slate-700">Server settings</span>
            <span className="block text-[11px] text-slate-500 truncate">
              {server.imapHost || '—'} · IMAP {server.imapPort}{server.imapSecure ? ' SSL' : ''} · SMTP {server.smtpPort}{server.smtpSecure ? ' SSL' : ''}
            </span>
          </span>
          <span className="text-xs text-sky-700 font-semibold inline-flex items-center gap-1 shrink-0">
            {advanced ? 'Hide' : 'Change'} <ChevronDown className={`w-3 h-3 transition-transform ${advanced ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {advanced && (
          <div className="mt-3 space-y-2.5">
            <p className="text-[11px] text-slate-500">Set for the Credence mail server ({CREDENCE_DOMAIN}). Change only for a mailbox somewhere else.</p>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <input value={server.imapHost} onChange={(e) => setField({ imapHost: e.target.value })} placeholder="IMAP server (incoming)" aria-label="IMAP server (incoming)" className={inputCls} />
              <input value={server.imapPort} onChange={(e) => setField({ imapPort: e.target.value })} inputMode="numeric" aria-label="IMAP port" className={inputCls} />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={server.imapSecure} onChange={(e) => setField({ imapSecure: e.target.checked })} /> IMAP uses SSL/TLS</label>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <input value={server.smtpHost} onChange={(e) => setField({ smtpHost: e.target.value })} placeholder="SMTP server (outgoing)" aria-label="SMTP server (outgoing)" className={inputCls} />
              <input value={server.smtpPort} onChange={(e) => setField({ smtpPort: e.target.value })} inputMode="numeric" aria-label="SMTP port" className={inputCls} />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={server.smtpSecure} onChange={(e) => setField({ smtpSecure: e.target.checked })} /> SMTP uses SSL/TLS (port 465)</label>
            <input value={server.username} onChange={(e) => setField({ username: e.target.value })} placeholder="Login name (if not the email address)" className={inputCls} />
            {edited && (
              <button type="button" onClick={() => setEdited(false)} className="text-[11px] text-slate-500 hover:text-slate-800 underline underline-offset-2">
                Back to the usual settings
              </button>
            )}
          </div>
        )}
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-full text-sm text-slate-600 hover:bg-black/5">Cancel</button>
        )}
        <button type="submit" disabled={busy} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {busy ? 'Checking the mailbox…' : 'Connect mailbox'}
        </button>
      </div>
    </form>
  );
};

// Mailboxes popup: switch default, remove, add another.
const MailboxesPopup: React.FC<{ token: string; userName: string; accounts: MailAccount[]; onChanged: () => void; onClose: () => void }> = ({ token, userName, accounts, onChanged, onClose }) => {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const keyboardInset = useKeyboardInset();
  useBackButtonClose(true, onClose);
  const remove = async (a: MailAccount) => {
    if (!(await confirmDialog(`Remove ${a.emailAddress} from Credence Mail? Its mail stays on the mail server; only the copy here is deleted.`, { confirmLabel: 'Remove' }))) return;
    try {
      await mailFetch(token, `/accounts/${a.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const makeDefault = async (a: MailAccount) => {
    try {
      await mailFetch(token, `/accounts/${a.id}`, { method: 'PUT', body: { isDefault: true } });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" style={keyboardInset ? { paddingBottom: keyboardInset + 8 } : undefined} onClick={onClose}>
      <div className="w-full max-w-md max-h-[92vh] flex" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full p-5 overflow-y-auto">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h3 className="text-base font-bold text-slate-900">{adding ? 'Connect another mailbox' : 'Mailboxes'}</h3>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
          {adding ? (
            <ConnectMailbox token={token} userName={userName} serverReady onCancel={() => setAdding(false)} onConnected={() => { setAdding(false); onChanged(); }} />
          ) : (
            <>
              <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-3">
                    <MailAvatar name={a.name} email={a.emailAddress} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{a.emailAddress}</div>
                      <div className={`text-[11px] truncate ${a.lastError ? 'text-rose-600' : 'text-slate-500'}`}>
                        {a.internalOnly
                          ? 'Only inside CredenceHR — add it again with its password for outside mail'
                          : a.lastError || (a.lastSyncAt ? `Checked ${shortMailDate(a.lastSyncAt)}` : 'Connected')}
                      </div>
                    </div>
                    {a.isDefault ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">Default</span>
                    ) : (
                      <button type="button" onClick={() => void makeDefault(a)} className="text-[11px] text-slate-500 hover:text-slate-800">Make default</button>
                    )}
                    <button type="button" onClick={() => void remove(a)} className="p-1.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Remove ${a.emailAddress}`}><LogOut className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              {error && <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
              {accounts.length < 5 && (
                <button type="button" onClick={() => setAdding(true)} className="mt-4 w-full liquid-glass-button rounded-full px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 inline-flex items-center justify-center gap-2">
                  <Plus className="w-4 h-4" /> Connect another mailbox
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
const ListSkeleton: React.FC = () => (
  <div className="divide-y divide-slate-100" style={{ animation: 'skeleton-in .2s ease both' }}>
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="flex items-start gap-3 px-4 py-3">
        <div className="w-10 h-10 rounded-full bg-slate-200/80 shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="flex justify-between gap-4">
            <div className="h-3 w-32 rounded bg-slate-200/80" />
            <div className="h-2.5 w-10 rounded bg-slate-100" />
          </div>
          <div className={`h-3 rounded bg-slate-200/60 ${i % 2 ? 'w-3/4' : 'w-2/3'}`} />
          <div className="h-2.5 w-full rounded bg-slate-100" />
        </div>
      </div>
    ))}
  </div>
);

// The whole page, while the first call runs.
const PageSkeleton: React.FC = () => (
  <div className="flex h-full min-h-0">
    <div className="hidden md:block w-56 shrink-0 p-3 space-y-2" style={{ animation: 'skeleton-in .2s ease both' }}>
      <div className="h-10 rounded-2xl bg-slate-200/80" />
      {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-8 rounded-xl bg-slate-100" />)}
    </div>
    <div className="flex-1 md:max-w-sm lg:max-w-md md:border-x border-slate-200/70 bg-white/70"><ListSkeleton /></div>
    <div className="hidden md:block flex-1" />
  </div>
);

const Row: React.FC<{
  m: MailMessage;
  folder: string;
  selected: boolean;
  checked: boolean;
  checking: boolean;
  compact?: boolean;
  readOnly?: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onStar: () => void;
}> = ({ m, folder, selected, checked, checking, compact, readOnly, onOpen, onCheck, onStar }) => {
  const outgoing = folder === 'Sent' || folder === 'Drafts' || folder === 'Scheduled';
  const who = outgoing ? `To: ${m.to.concat(m.cc).join(', ') || '(no one yet)'}` : m.from.name || m.from.email;
  const ownLabels = m.labels.filter((l) => !SYSTEM_LABELS.has(l)).slice(0, 2);
  const trailing = (
    <>
      {ownLabels.map((l) => <span key={l} className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 shrink-0">{l}</span>)}
      {m.hasAttachments && <Paperclip className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
      {folder !== 'Drafts' && folder !== 'Scheduled' && !readOnly && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStar();
          }}
          className="p-0.5 -m-0.5 shrink-0"
          aria-label={m.isStarred ? 'Unstar' : 'Star'}
        >
          <Star className={`w-4 h-4 ${m.isStarred ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-slate-500'}`} />
        </button>
      )}
    </>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={`group flex items-start gap-3 px-3 sm:px-4 ${compact ? 'py-1.5' : 'py-3'} cursor-pointer border-l-[3px] ${selected ? 'bg-sky-50/80 border-sky-500' : m.isRead ? 'border-transparent hover:bg-slate-50' : 'border-transparent bg-white hover:bg-slate-50'}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          // An opened (read-only) mailbox has nothing to select mails for.
          if (readOnly) onOpen();
          else onCheck();
        }}
        className="relative shrink-0"
        aria-label={readOnly ? 'Open' : checked ? 'Unselect' : 'Select'}
      >
        <span className={readOnly ? '' : checking || checked ? 'hidden' : 'group-hover:hidden'}>
          <MailAvatar name={outgoing ? m.to[0] || '?' : m.from.name} email={outgoing ? m.to[0] || '' : m.from.email} size={compact ? 'sm' : 'md'} />
        </span>
        <span className={`${readOnly ? 'hidden' : checking || checked ? 'flex' : 'hidden group-hover:flex'} ${compact ? 'w-8 h-8' : 'w-10 h-10'} items-center justify-center rounded-full ${checked ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
          {checked ? <Check className="w-5 h-5" /> : <Square className="w-4 h-4" />}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm truncate ${m.isRead ? 'text-slate-700' : 'font-bold text-slate-900'}`}>{who}</span>
          <span className={`text-[11px] shrink-0 ${m.isRead ? 'text-slate-400' : 'text-sky-700 font-semibold'}`}>
            {folder === 'Scheduled' ? shortMailDate(m.scheduledSendTime) : shortMailDate(m.date)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          {m.isDraft && <span className="text-[11px] font-semibold text-rose-600 shrink-0">Draft</span>}
          {m.sendError && <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
          <span className={`text-[13px] truncate ${m.isRead ? 'text-slate-600' : 'font-semibold text-slate-800'}`}>{m.subject}</span>
          {/* Compact: no preview line, so the icons sit here. */}
          {compact && (
            <>
              <span className="flex-1" />
              {trailing}
            </>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs text-slate-500 truncate flex-1">{m.snippet}</span>
            {trailing}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export const CredenceMail: React.FC<{
  token: string;
  user: User;
  onBack?: () => void;
  // Admin Panel -> Mail Administration: someone else's mailbox, read only.
  viewAs?: { userId: number; name: string };
}> = ({ token, user, onBack, viewAs }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const ro = !!viewAs;
  // Every call from here on carries whose mailbox it is (set before the first fetch).
  setMailViewAs(viewAs ? viewAs.userId : null);
  useEffect(() => () => setMailViewAs(null), []);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [accountFilter, setAccountFilter] = useState<number | 0>(0);
  const [folder, setFolder] = useState<string>('Inbox');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [list, setList] = useState<MailList | null>(null);
  const [listError, setListError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<MailCounts | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<MailMessage[] | null>(null);
  const [threadError, setThreadError] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [mailboxes, setMailboxes] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [ruleLabels, setRuleLabels] = useState<string[]>([]);
  const listReq = useRef(0);
  const accounts = status?.accounts || [];
  const ownEmails = useMemo(() => new Set(accounts.map((a) => a.emailAddress.toLowerCase())), [accounts]);
  // Pictures show without asking in one's own mail, mail from our own
  // domains, and from senders chosen with "Always from this sender".
  const ourDomains = useMemo(() => new Set((status?.ourDomains || []).map((d) => d.toLowerCase())), [status]);
  const pictureSenders = useMemo(() => new Set((settings?.pictureSenders || []).map((d) => d.toLowerCase())), [settings]);
  const picturesOk = useCallback(
    (m: MailMessage) => {
      const from = (m.from.email || '').toLowerCase();
      return ownEmails.has(from) || ourDomains.has(from.split('@')[1] || '') || pictureSenders.has(from);
    },
    [ownEmails, ourDomains, pictureSenders]
  );
  const trustSender = async (email: string) => {
    try {
      const cur = settings || (await mailFetch<MailSettings>(token, '/settings'));
      const next = await mailFetch<MailSettings>(token, '/settings', { method: 'PUT', body: { pictureSenders: [...new Set([...(cur.pictureSenders || []), email.toLowerCase()])] } });
      setSettings(next);
      say(`Pictures from ${email} will always show.`);
    } catch (e: any) {
      say(e.message, 'error');
    }
  };

  useBackButtonClose(drawer, () => setDrawer(false));
  useBackButtonClose(!!selectedId, () => setSelectedId(null));

  const say = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({ text, tone });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadStatus = useCallback(async () => {
    try {
      setStatusError('');
      // An opened mailbox: its owner's mailboxes, no own-access check.
      if (viewAs) setStatus({ enabled: true, serverReady: true, accounts: await mailFetch<MailAccount[]>(token, '/accounts') });
      else setStatus(await mailFetch<MailStatus>(token, '/status'));
    } catch (e: any) {
      setStatusError(e.message);
    }
  }, [token]);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const listPath = useCallback(
    (page: number) => {
      const p = new URLSearchParams({ label: folder, page: String(page), limit: String(PAGE) });
      if (accountFilter) p.set('accountId', String(accountFilter));
      if (folder === 'Inbox' && category) p.set('category', category);
      if (q) p.set('q', q);
      return `/messages?${p.toString()}`;
    },
    [folder, accountFilter, category, q]
  );

  const loadList = useCallback(
    async (quiet = false) => {
      if (!status?.enabled || !accounts.length) return;
      const req = ++listReq.current;
      if (!quiet) setList(null);
      setListError('');
      try {
        // A quiet refresh keeps however many pages are showing.
        const pages = quiet && list ? Math.max(1, Math.ceil(list.items.length / PAGE)) : 1;
        const first = await mailFetch<MailList>(token, listPath(1));
        let items = first.items;
        for (let pg = 2; pg <= pages; pg++) items = items.concat((await mailFetch<MailList>(token, listPath(pg))).items);
        if (req === listReq.current) setList({ ...first, items });
      } catch (e: any) {
        if (req === listReq.current) setListError(e.message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, listPath, status?.enabled, accounts.length]
  );
  const loadCounts = useCallback(async () => {
    if (!status?.enabled || !accounts.length) return;
    try {
      setCounts(await mailFetch<MailCounts>(token, `/counts${accountFilter ? `?accountId=${accountFilter}` : ''}`));
    } catch {
      // Counts are a nicety.
    }
  }, [token, accountFilter, status?.enabled, accounts.length]);

  // Search as you type (a short pause after the last key); Enter searches at once.
  useEffect(() => {
    const next = qInput.trim();
    if (next === q) return;
    const t = setTimeout(() => {
      setQ(next);
      setSelectedId(null);
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  // Older mail than the mailbox brought in when it was connected is only on
  // the mail server: look there too, once per search, and show what it finds.
  const [serverSearch, setServerSearch] = useState<'' | 'busy' | 'done'>('');
  const serverSearchKey = useRef('');
  useEffect(() => {
    const key = `${folder}|${accountFilter}|${q}`;
    serverSearchKey.current = key;
    if (!status?.enabled || !accounts.length || q.length < 2 || !['Inbox', 'Sent', 'Spam', 'All', 'Starred', 'Important'].includes(folder)) {
      setServerSearch('');
      return;
    }
    setServerSearch('busy');
    // Not cancelled by the list reloading meanwhile — only a newer search wins.
    mailFetch<{ added: number }>(token, '/search-server', { method: 'POST', body: { q, label: folder, accountId: accountFilter || undefined } })
      .then((r) => {
        if (serverSearchKey.current !== key) return;
        setServerSearch('done');
        if (r.added > 0) refreshRef.current();
      })
      .catch(() => serverSearchKey.current === key && setServerSearch('done'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, folder, accountFilter, status?.enabled, accounts.length]);

  useEffect(() => {
    setChecked(new Set());
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPath, status?.enabled, accounts.length]);
  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);
  const loadRuleLabels = useCallback(() => {
    mailFetch<MailFilter[]>(token, '/filters')
      .then((fs) => setRuleLabels([...new Set(fs.flatMap((f) => f.actions?.applyLabels || []))].filter((l) => !SYSTEM_LABELS.has(l)).sort((a, b) => a.localeCompare(b))))
      .catch(() => undefined);
  }, [token]);
  useEffect(() => {
    if (!status?.enabled) return;
    mailFetch<MailSettings>(token, '/settings')
      .then((st) => {
        setMailTimeZone(st.timezone);
        setSettings(st);
      })
      .catch(() => undefined);
    mailFetch<MailTemplate[]>(token, '/templates').then(setTemplates).catch(() => undefined);
    loadRuleLabels();
  }, [token, status?.enabled, loadRuleLabels]);

  // Live: the server's IDLE watcher / scheduled sender tell this account.
  const refreshRef = useRef<() => void>(() => undefined);
  refreshRef.current = () => {
    void loadList(true);
    void loadCounts();
  };
  useEffect(() => {
    // Live news goes to the owner's own screen, not to an admin's view.
    if (!status?.enabled || ro) return;
    const socket = connectChatSocket(token);
    const onChanged = () => refreshRef.current();
    // New mail and a failed scheduled mail are told through CredenceHR's own
    // Alerts (MailRoutes.ts createAlert); here the list just refreshes.
    const onNew = () => refreshRef.current();
    const onFailed = () => refreshRef.current();
    socket.on('mail:changed', onChanged);
    socket.on('mail:new', onNew);
    socket.on('mail:send-failed', onFailed);
    // A safety net when the socket is down: check every 2 minutes on screen.
    const t = setInterval(() => document.visibilityState === 'visible' && refreshRef.current(), 120_000);
    return () => {
      socket.off('mail:changed', onChanged);
      socket.off('mail:new', onNew);
      socket.off('mail:send-failed', onFailed);
      clearInterval(t);
    };
  }, [token, status?.enabled, ro]);

  // A mail alert (CredenceHR's Alerts bell) opens that mail: on arriving here,
  // or when already here.
  useEffect(() => {
    if (ro) return;
    const take = () => {
      try {
        const id = sessionStorage.getItem('open_mail_id');
        if (!id) return;
        sessionStorage.removeItem('open_mail_id');
        setSelectedId(id);
      } catch {
        // storage unavailable — stays on the list
      }
    };
    take();
    const onOpen = (e: Event) => (e as CustomEvent).detail === 'credenceMail' && setTimeout(take, 0);
    window.addEventListener('credence:open-self-service', onOpen);
    return () => window.removeEventListener('credence:open-self-service', onOpen);
  }, [ro]);

  // Opening one: the whole conversation, marked read.
  useEffect(() => {
    if (!selectedId || !list) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setThread(null);
    setThreadError('');
    (async () => {
      try {
        // A mail from a task / event link may not be in this list.
        const m = list.items.find((x) => x.id === selectedId) || (await mailFetch<MailMessage>(token, `/messages/${selectedId}`));
        const t = await mailFetch<MailMessage[]>(token, `/threads/${encodeURIComponent(m.threadId)}`);
        // Trash / Spam / Drafts open just the one mail.
        const shown = folder === 'Trash' || folder === 'Spam' || folder === 'Drafts' || folder === 'Scheduled' || !t.some((x) => x.id === m.id) ? [await mailFetch<MailMessage>(token, `/messages/${m.id}`)] : t;
        if (cancelled) return;
        setThread(shown);
        // Reading someone else's mailbox leaves it as it was.
        const unread = ro ? [] : shown.filter((x) => !x.isRead).map((x) => x.id);
        if (unread.length) {
          await mailFetch(token, '/messages/batch', { method: 'POST', body: { ids: unread, patch: { isRead: true } } });
          setList((prev) => (prev ? { ...prev, items: prev.items.map((x) => (unread.includes(x.id) ? { ...x, isRead: true } : x)) } : prev));
          void loadCounts();
        }
      } catch (e: any) {
        if (!cancelled) setThreadError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only when a different mail is opened (or the list first arrives, for a
    // mail opened from an alert).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, token, !!list]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await mailFetch<{ accounts: { error?: string }[] }>(token, '/sync', { method: 'POST', body: accountFilter ? { accountId: accountFilter } : {} });
      const err = r.accounts.find((a) => a.error)?.error;
      if (err) say(err, 'error');
      await Promise.all([loadList(true), loadCounts(), loadStatus()]);
    } catch (e: any) {
      say(e.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const openFolder = (f: string) => {
    setFolder(f);
    setCategory('');
    setSelectedId(null);
    setDrawer(false);
  };

  // ---- Compose helpers ----
  const quoteOf = (m: MailMessage) => {
    const safe = sanitizeMailHtml(m.body || '', false).html.replace(/<style[\s\S]*?<\/style>/gi, '');
    return `<div><br></div><div data-credence-quote="1"><div style="color:#64748b">On ${fullMailDate(m.date)}, ${m.from.name.replace(/</g, '&lt;')} &lt;${m.from.email}&gt; wrote:</div><blockquote>${safe}</blockquote></div>`;
  };
  const prefixed = (p: string, s: string) => (new RegExp(`^${p}:`, 'i').test(s.trim()) ? s : `${p}: ${s}`);
  const startReply = async (m: MailMessage, all: boolean) => {
    const full = m.body !== undefined ? m : await mailFetch<MailMessage>(token, `/messages/${m.id}`);
    const fromMe = ownEmails.has(full.from.email.toLowerCase());
    const strip = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].filter((x) => !ownEmails.has(x));
    const to = fromMe ? full.to : [full.from.email, ...(all ? full.to : [])];
    setCompose({
      accountId: full.accountId,
      to: strip(to).join(', '),
      cc: all ? strip(full.cc).filter((x) => !to.includes(x)).join(', ') : '',
      subject: prefixed('Re', full.subject),
      body: quoteOf(full),
      inReplyTo: full.messageId
    });
  };
  const startForward = async (m: MailMessage) => {
    const full = m.body !== undefined ? m : await mailFetch<MailMessage>(token, `/messages/${m.id}`);
    setCompose({
      accountId: full.accountId,
      subject: prefixed('Fwd', full.subject),
      body: `<div><br></div><div data-credence-quote="1"><div style="color:#64748b">---------- Forwarded message ----------<br>From: ${full.from.name.replace(/</g, '&lt;')} &lt;${full.from.email}&gt;<br>Date: ${fullMailDate(full.date)}<br>Subject: ${full.subject.replace(/</g, '&lt;')}<br>To: ${full.to.join(', ')}</div><br>${sanitizeMailHtml(full.body || '', false).html.replace(/<style[\s\S]*?<\/style>/gi, '')}</div>`,
      forwardFrom: full.attachments.length ? { messageId: full.id, attachments: full.attachments } : undefined
    });
  };
  const openDraft = async (m: MailMessage) => {
    const full = await mailFetch<MailMessage>(token, `/messages/${m.id}`);
    setCompose({
      accountId: full.accountId,
      to: full.to.join(', '),
      cc: full.cc.join(', '),
      bcc: full.bcc.join(', '),
      subject: full.subject === '(no subject)' ? '' : full.subject,
      body: full.body,
      draftId: full.id,
      draftAttachments: full.attachments
    });
  };

  // ---- Changes ----
  const patchLocal = (ids: string[], patch: Partial<MailMessage>, removeFromList = false) =>
    setList((prev) =>
      prev ? { ...prev, items: removeFromList ? prev.items.filter((x) => !ids.includes(x.id)) : prev.items.map((x) => (ids.includes(x.id) ? { ...x, ...patch } : x)), total: removeFromList ? prev.total - ids.length : prev.total } : prev
    );

  const moveLabels = (m: MailMessage, to: 'Trash' | 'Spam' | 'Inbox' | 'Archive') => {
    const keep = m.labels.filter((l) => !['Inbox', 'Spam', 'Trash', 'Archive'].includes(l));
    return [...keep, to];
  };

  const act = async (action: ReaderAction, m: MailMessage) => {
    try {
      if (action === 'reply' || action === 'replyAll') return void (await startReply(m, action === 'replyAll'));
      if (action === 'forward') return void (await startForward(m));
      if (action === 'star') {
        patchLocal([m.id], { isStarred: !m.isStarred });
        setThread((t) => t && t.map((x) => (x.id === m.id ? { ...x, isStarred: !m.isStarred } : x)));
        await mailFetch(token, `/messages/${m.id}`, { method: 'PATCH', body: { isStarred: !m.isStarred } });
        void loadCounts();
        return;
      }
      if (action === 'unread') {
        await mailFetch(token, `/messages/${m.id}`, { method: 'PATCH', body: { isRead: !m.isRead } });
        patchLocal([m.id], { isRead: !m.isRead });
        if (m.isRead) setSelectedId(null);
        else setThread((t) => t && t.map((x) => (x.id === m.id ? { ...x, isRead: true } : x)));
        void loadCounts();
        return;
      }
      if (action === 'task' || action === 'event') {
        setTool({ kind: 'planner', tab: action === 'task' ? 'tasks' : 'calendar', fromMail: { emailId: m.id, subject: m.subject } });
        return;
      }
      if (action === 'contact') {
        setTool({ kind: 'contacts', prefill: { name: m.from.name, email: m.from.email } });
        return;
      }
      if (action === 'rule') {
        setTool({ kind: 'rules', prefill: { name: `Mail from ${m.from.name || m.from.email}`, conditions: { from: m.from.email }, actions: { applyLabels: [] }, isActive: true } });
        return;
      }
      if (action === 'block') {
        const addr = m.from.email.toLowerCase();
        if (!addr || !(await confirmDialog(`Block ${addr}? New mail from this address will go to Spam.`, { confirmLabel: 'Block' }))) return;
        const cur = settings || (await mailFetch<MailSettings>(token, '/settings'));
        const next = await mailFetch<MailSettings>(token, '/settings', { method: 'PUT', body: { blockedSenders: [...new Set([...(cur.blockedSenders || []), addr])] } });
        setSettings(next);
        if (!m.labels.includes('Spam') && (await confirmDialog('Move this mail to Spam too?', { confirmLabel: 'Move to Spam' }))) return void (await act('spam', m));
        say(`${addr} is blocked.`);
        return;
      }
      if (action === 'unschedule') {
        await mailFetch(token, `/messages/${m.id}/unschedule`, { method: 'POST' });
        say('Sending cancelled — it is in Drafts now.');
        setSelectedId(null);
        refreshRef.current();
        return;
      }
      if (action === 'trash') {
        const forGood = m.labels.includes('Trash') || m.labels.includes('Scheduled') || m.labels.includes('Drafts');
        if (forGood && !(await confirmDialog('Delete this mail for good? This cannot be undone.', { tone: 'danger', confirmLabel: 'Delete' }))) return;
        // The whole conversation goes, like in other mail apps.
        const ids = forGood ? [m.id] : (thread || [m]).filter((x) => !x.labels.includes('Trash')).map((x) => x.id);
        // Gone from the screen at once; the mail server (which can take a few
        // seconds) catches up behind it — if it fails, the list comes back.
        patchLocal(ids, {}, true);
        setSelectedId(null);
        say(forGood ? 'Deleted.' : 'Moved to Trash.');
        try {
          await mailFetch(token, '/messages/batch', { method: 'POST', body: { ids, action: 'delete' } });
        } catch (e: any) {
          say(e.message, 'error');
          refreshRef.current();
        }
        void loadCounts();
        return;
      }
      const target = action === 'spam' ? 'Spam' : action === 'archive' ? 'Archive' : 'Inbox';
      await mailFetch(token, `/messages/${m.id}`, { method: 'PATCH', body: { labels: moveLabels(m, target) } });
      patchLocal([m.id], {}, folder !== 'Starred' && folder !== 'Important');
      setSelectedId(null);
      say(action === 'spam' ? 'Moved to Spam.' : action === 'archive' ? 'Archived.' : 'Moved to Inbox.');
      void loadCounts();
    } catch (e: any) {
      say(e.message, 'error');
    }
  };

  const items = list?.items || [];
  const checkedItems = items.filter((m) => checked.has(m.id));
  const bulk = async (kind: 'read' | 'unread' | 'trash' | 'spam' | 'inbox' | 'archive') => {
    const ids = checkedItems.map((m) => m.id);
    if (!ids.length) return;
    const forGood = kind === 'trash' && (folder === 'Trash' || folder === 'Drafts' || folder === 'Scheduled');
    if (forGood && !(await confirmDialog(`Delete ${ids.length} mail${ids.length > 1 ? 's' : ''} for good? This cannot be undone.`, { tone: 'danger', confirmLabel: 'Delete' }))) return;
    // The list changes at once; the mail server catches up behind it (one
    // request for the whole selection — see /messages/batch).
    const reading = kind === 'read' || kind === 'unread';
    if (reading) patchLocal(ids, { isRead: kind === 'read' });
    else {
      patchLocal(ids, {}, true);
      if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    }
    setChecked(new Set());
    try {
      if (reading) await mailFetch(token, '/messages/batch', { method: 'POST', body: { ids, patch: { isRead: kind === 'read' } } });
      else if (kind === 'trash') await mailFetch(token, '/messages/batch', { method: 'POST', body: { ids, action: 'delete' } });
      else await mailFetch(token, '/messages/batch', { method: 'POST', body: { ids, action: 'move', to: kind === 'spam' ? 'Spam' : kind === 'archive' ? 'Archive' : 'Inbox' } });
      if (!reading) say(kind === 'trash' ? (forGood ? `Deleted ${ids.length}.` : `Moved ${ids.length} to Trash.`) : kind === 'spam' ? 'Moved to Spam.' : kind === 'archive' ? 'Archived.' : 'Moved to Inbox.');
    } catch (e: any) {
      say(e.message, 'error');
      refreshRef.current();
    }
    void loadCounts();
  };

  const loadMore = async () => {
    if (!list) return;
    setLoadingMore(true);
    try {
      const next = await mailFetch<MailList>(token, listPath(Math.floor(list.items.length / PAGE) + 1));
      setList((prev) => (prev ? { ...prev, items: [...prev.items, ...next.items.filter((n) => !prev.items.some((p) => p.id === n.id))] } : prev));
    } catch (e: any) {
      say(e.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const openRow = (m: MailMessage) => {
    if (m.labels.includes('Drafts') && !ro) {
      void openDraft(m).catch((e) => say(e.message, 'error'));
      return;
    }
    setSelectedId(m.id);
  };

  // ---- Screens ----
  const modulePath = ['Self Service', 'Credence Mail'];
  const roBanner = ro ? (
    <div className="mb-3 flex items-center gap-2 rounded-2xl bg-amber-50 text-amber-900 text-xs px-3 py-2">
      <Eye className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0">You are looking at {viewAs!.name}'s mailbox. Read only — nothing here changes, and the visit is in the Mail Administration log.</span>
      {onBack && (
        <button type="button" onClick={onBack} className="shrink-0 font-semibold underline underline-offset-2">Close</button>
      )}
    </div>
  ) : null;
  const header = (
    <div className="flex items-center justify-between gap-3 mb-3 mt-2 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        {onBack && (
          <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
            <ArrowLeft className="w-5 h-5 text-slate-500" />
          </button>
        )}
        <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight min-w-0">
          <Mail className="w-5 h-5 text-sky-600 shrink-0" /> <span className="truncate">{viewAs ? `${viewAs.name}'s mailbox` : 'Credence Mail'}</span>
        </h1>
      </div>
      {accounts.length > 0 && !ro && (
        <div className="flex items-center gap-1.5">
          {accounts.length > 1 && (
            <select
              value={accountFilter}
              onChange={(e) => {
                setAccountFilter(Number(e.target.value));
                setSelectedId(null);
              }}
              className="hidden sm:block text-xs px-2 py-1.5 rounded-xl bg-white/80 border border-slate-200 max-w-[14rem]"
            >
              <option value={0}>All mailboxes</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.emailAddress}</option>)}
            </select>
          )}
          <button type="button" onClick={() => setMailboxes(true)} className="text-xs px-3 py-1.5 rounded-xl bg-white/80 border border-slate-200 hover:bg-white text-slate-700 hidden sm:inline-flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" /> Mailboxes
          </button>
          <button type="button" onClick={() => settings && setTool({ kind: 'settings' })} disabled={!settings} className="w-8 h-8 rounded-xl bg-white/80 border border-slate-200 hover:bg-white text-slate-700 inline-flex items-center justify-center disabled:opacity-50" aria-label="Mail settings" title="Settings">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  const wrap = (body: React.ReactNode) => (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
        {/* Inside the Admin Panel, its own path line is already shown. */}
          {!isNativeApp && !ro && <ModulePath path={modulePath} />}
        {header}
        {roBanner}
        {body}
      </div>
    </div>
  );

  if (statusError) return wrap(<div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-rose-600">{statusError}</div>);
  if (!status) return wrap(<div className="h-[calc(100vh-11rem)] rounded-3xl overflow-hidden bg-white/50 border border-slate-200/70"><PageSkeleton /></div>);
  if (!status.enabled) return wrap(<div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Credence Mail isn't turned on for your account.</div>);
  if (!accounts.length && ro) return wrap(<div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{viewAs!.name} has no mailbox connected now.</div>);
  if (!accounts.length) {
    return wrap(
      <div className="max-w-md mx-auto mt-6">
        <div className="rounded-[28px] bg-white/80 border border-slate-200 p-5 sm:p-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-b from-sky-400 to-sky-600 text-white flex items-center justify-center shadow-[0_8px_20px_-6px_rgba(2,132,199,0.6)]">
            <Mail className="w-6 h-6" />
          </div>
          <h2 className="mt-4 text-lg font-bold">Connect your mailbox</h2>
          <p className="mt-1 text-sm text-slate-600">Read and send your office mail right here. You only do this once.</p>
          <div className="mt-5">
            <ConnectMailbox token={token} userName={user.name} serverReady={status.serverReady} onConnected={() => void loadStatus()} />
          </div>
        </div>
      </div>
    );
  }

  const countFor = (label: string) =>
    !counts ? 0 : label === 'Inbox' ? counts.inboxUnread : label === 'Drafts' ? counts.drafts : label === 'Scheduled' ? counts.scheduled : label === 'Spam' ? counts.spamUnread : 0;

  const folderNav = (
    <nav className="space-y-0.5">
      {MAIL_FOLDERS.map((f) => {
        const Icon = FOLDER_ICONS[f.label] || Inbox;
        const n = countFor(f.label);
        const active = folder === f.label;
        return (
          <button
            key={f.label}
            type="button"
            onClick={() => openFolder(f.label)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm ${active ? 'bg-sky-100/80 text-sky-800 font-semibold' : 'text-slate-700 hover:bg-black/5'}`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left">{f.title}</span>
            {n > 0 && <span className={`text-[11px] ${active ? 'text-sky-800' : 'text-slate-500'} font-semibold`}>{n}</span>}
          </button>
        );
      })}
      {ruleLabels.length > 0 && (
        <>
          <div className="pt-3 pb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Labels</div>
          {ruleLabels.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => openFolder(l)}
              className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-xl text-sm ${folder === l ? 'bg-sky-100/80 text-sky-800 font-semibold' : 'text-slate-700 hover:bg-black/5'}`}
            >
              <Tag className="w-4 h-4 shrink-0" />
              <span className="flex-1 text-left truncate">{l}</span>
            </button>
          ))}
        </>
      )}
    </nav>
  );

  const openTool = (t: Tool) => {
    setDrawer(false);
    setTool(t);
  };
  const toolsNav = (
    <nav className="space-y-0.5">
      <div className="pb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Tools</div>
      {(
        [
          ['Contacts', Users, () => openTool({ kind: 'contacts' })],
          ['Tasks & Calendar', ListChecks, () => openTool({ kind: 'planner', tab: 'tasks' })],
          ['Rules', Filter, () => openTool({ kind: 'rules' })],
          ['Templates', FileText, () => openTool({ kind: 'templates' })],
          ['Analytics', BarChart3, () => openTool({ kind: 'analytics' })],
          ['Settings', Settings, () => settings && openTool({ kind: 'settings' })]
        ] as [string, React.ComponentType<{ className?: string }>, () => void][]
      ).map(([label, Icon, onClick]) => (
        <button key={label} type="button" onClick={onClick} className="w-full flex items-center gap-3 px-3 py-1.5 rounded-xl text-sm text-slate-700 hover:bg-black/5">
          <Icon className="w-4 h-4 shrink-0" />
          <span className="flex-1 text-left">{label}</span>
        </button>
      ))}
    </nav>
  );

  const composeButton = (
    <button
      type="button"
      onClick={() => setCompose({ accountId: accountFilter || undefined })}
      className="liquid-glass-button rounded-2xl w-full px-4 py-3 text-sm font-semibold text-white bg-sky-600 inline-flex items-center gap-2 justify-center"
    >
      <Pencil className="w-4 h-4" /> Write
    </button>
  );

  const allChecked = items.length > 0 && items.every((m) => checked.has(m.id));
  const folderTitle = MAIL_FOLDERS.find((f) => f.label === folder)?.title || folder;
  const listPane = (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-slate-200/70">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setDrawer(true)} className="md:hidden p-2 -ml-1 rounded-full hover:bg-black/5" aria-label="Folders">
            <Menu className="w-5 h-5 text-slate-600" />
          </button>
          <form
            className="flex-1 relative"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(qInput.trim());
              setSelectedId(null);
            }}
          >
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder={`Search ${folderTitle}`}
              className="w-full text-sm pl-9 pr-8 py-2 rounded-full bg-slate-100/80 focus:bg-white border border-transparent focus:border-slate-200 focus:outline-none"
            />
            {(qInput || q) && (
              <button type="button" onClick={() => { setQInput(''); setQ(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-black/5" aria-label="Clear search">
                <X className="w-3.5 h-3.5 text-slate-500" />
              </button>
            )}
          </form>
          <button type="button" onClick={() => void sync()} disabled={syncing} className="p-2 rounded-full hover:bg-black/5 disabled:opacity-50" aria-label="Check for new mail" title="Check for new mail">
            <RefreshCw className={`w-4 h-4 text-slate-600 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {checked.size > 0 ? (
          <div className="flex items-center gap-1 flex-wrap">
            <button type="button" onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((m) => m.id)))} className="p-1.5 rounded-lg hover:bg-black/5" aria-label="Select all">
              {allChecked ? <CheckSquare className="w-4 h-4 text-sky-600" /> : <Square className="w-4 h-4 text-slate-500" />}
            </button>
            <span className="text-xs text-slate-600 mr-1">{checked.size} selected</span>
            <button type="button" onClick={() => void bulk('read')} className="p-1.5 rounded-lg hover:bg-black/5" title="Mark as read"><MailOpen className="w-4 h-4 text-slate-600" /></button>
            <button type="button" onClick={() => void bulk('unread')} className="p-1.5 rounded-lg hover:bg-black/5" title="Mark as unread"><Mail className="w-4 h-4 text-slate-600" /></button>
            {folder === 'Spam' || folder === 'Trash' || folder === 'Archive' ? (
              <button type="button" onClick={() => void bulk('inbox')} className="p-1.5 rounded-lg hover:bg-black/5" title="Move to Inbox"><Inbox className="w-4 h-4 text-slate-600" /></button>
            ) : folder !== 'Drafts' && folder !== 'Scheduled' && folder !== 'Sent' ? (
              <>
                <button type="button" onClick={() => void bulk('archive')} className="p-1.5 rounded-lg hover:bg-black/5" title="Archive"><Archive className="w-4 h-4 text-slate-600" /></button>
                <button type="button" onClick={() => void bulk('spam')} className="p-1.5 rounded-lg hover:bg-black/5" title="Report spam"><ShieldAlert className="w-4 h-4 text-slate-600" /></button>
              </>
            ) : null}
            <button type="button" onClick={() => void bulk('trash')} className="p-1.5 rounded-lg hover:bg-rose-50" title="Delete"><Trash2 className="w-4 h-4 text-rose-600" /></button>
            <button type="button" onClick={() => setChecked(new Set())} className="ml-auto p-1.5 rounded-lg hover:bg-black/5" aria-label="Clear selection"><X className="w-4 h-4 text-slate-500" /></button>
          </div>
        ) : folder === 'Inbox' && !q ? (
          <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
            {MAIL_CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => { setCategory(c.key); setSelectedId(null); }}
                className={`shrink-0 text-xs px-3 py-1 rounded-full ${category === c.key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {c.title}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-500 px-1">
            {q ? `Results for “${q}” in ${folderTitle}` : folderTitle}
            {list ? ` · ${list.total}` : ''}
            {q && serverSearch === 'busy' && (
              <span className="inline-flex items-center gap-1 ml-2 text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> looking for older mail on the server…</span>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {listError ? (
          <div className="p-6 text-sm text-rose-600">{listError}</div>
        ) : !list ? (
          <ListSkeleton />
        ) : !items.length ? (
          <div className="py-16 flex flex-col items-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center"><Inbox className="w-6 h-6 text-slate-300" /></div>
            <p className="mt-3 text-sm text-slate-500">{q ? 'No mail matches your search.' : `Nothing in ${folderTitle}.`}</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-slate-100">
              {items.map((m) => (
                <Row
                  key={m.id}
                  m={m}
                  folder={folder}
                  selected={selectedId === m.id}
                  checked={checked.has(m.id)}
                  checking={checked.size > 0}
                  readOnly={ro}
                  compact={settings?.layout?.density === 'compact'}
                  onOpen={() => (checked.size ? setChecked((p) => { const n = new Set(p); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; }) : openRow(m))}
                  onCheck={() => setChecked((p) => { const n = new Set(p); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })}
                  onStar={() => void act('star', m)}
                />
              ))}
            </div>
            {items.length < list.total && (
              <div className="p-4 flex justify-center">
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="text-xs font-medium px-4 py-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1.5">
                  {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Show more
                </button>
              </div>
            )}
            <div className="h-24 md:h-4" />
          </>
        )}
      </div>
    </div>
  );

  const reader = selectedId ? (
    <MailReader
      token={token}
      thread={thread}
      folder={folder}
      error={threadError}
      readOnly={ro}
      onBack={() => setSelectedId(null)}
      onAction={(a, m) => void act(a, m)}
      picturesOk={picturesOk}
      onTrustSender={(email) => void trustSender(email)}
    />
  ) : (
    <div className="hidden md:flex h-full items-center justify-center text-center p-8">
      <div>
        <div className="w-14 h-14 rounded-full bg-white/80 border border-slate-200 flex items-center justify-center mx-auto"><Mail className="w-6 h-6 text-slate-300" /></div>
        <p className="mt-3 text-sm text-slate-500">Pick a mail to read it.</p>
      </div>
    </div>
  );

  return (
    <div className="w-full text-slate-900">
      <div className="w-full px-0 sm:px-6 lg:px-8 pt-1 sm:pt-3 pb-0 md:pb-6">
        <div className="px-3 sm:px-0">
          {!isNativeApp && !ro && <ModulePath path={modulePath} />}
          <div className="hidden md:block">{header}</div>
          {roBanner}
        </div>
        <div className="flex h-[calc(100dvh-4.5rem)] md:h-[calc(100vh-10.5rem)] min-h-[28rem] md:rounded-3xl overflow-hidden md:border border-slate-200/70 bg-white/40">
          {/* Folders (desktop) */}
          <aside className="hidden md:flex flex-col w-56 shrink-0 p-3 gap-3 overflow-y-auto">
            {!ro && composeButton}
            {folderNav}
            {!ro && <div className="border-t border-slate-200/70 pt-3">{toolsNav}</div>}
          </aside>
          {/* List */}
          <section className={`${selectedId ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-[22rem] lg:w-[26rem] shrink-0 md:border-x border-slate-200/70 bg-white/80 min-h-0`}>{listPane}</section>
          {/* Mail */}
          <section className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 min-h-0 bg-slate-50/60`}>{reader}</section>
        </div>
      </div>

      {/* Phone: write button */}
      {/* (.liquid-glass-button is position: relative, so the wrapper is the fixed one.)
          Above the assistant button in the corner. */}
      {!selectedId && !ro && (
        <div className="md:hidden fixed right-4 z-40" style={{ bottom: 'calc(9.5rem + env(safe-area-inset-bottom))' }}>
          <button
            type="button"
            onClick={() => setCompose({ accountId: accountFilter || undefined })}
            className="liquid-glass-button rounded-2xl px-5 py-3.5 text-sm font-semibold text-white bg-sky-600 inline-flex items-center gap-2 shadow-lg"
          >
            <Pencil className="w-4 h-4" /> Write
          </button>
        </div>
      )}

      {/* Phone: folders drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-[85] liquid-glass-backdrop" onClick={() => setDrawer(false)}>
          <div className="absolute inset-y-0 left-0 w-[78%] max-w-xs" onClick={(e) => e.stopPropagation()}>
            <div className="liquid-glass liquid-glass-in h-full rounded-r-[32px] p-4 flex flex-col gap-3 overflow-y-auto" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900 flex items-center gap-2"><Mail className="w-5 h-5 text-sky-600" /> Credence Mail</span>
                <button type="button" onClick={() => setDrawer(false)} className="liquid-glass-chip p-1.5 rounded-full text-slate-600" aria-label="Close"><X className="w-4 h-4" /></button>
              </div>
              {accounts.length > 1 && (
                <select
                  value={accountFilter}
                  onChange={(e) => { setAccountFilter(Number(e.target.value)); setSelectedId(null); setDrawer(false); }}
                  className="text-sm px-3 py-2 rounded-xl bg-white/80 border border-slate-200"
                >
                  <option value={0}>All mailboxes</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.emailAddress}</option>)}
                </select>
              )}
              <div className="liquid-glass-inset rounded-[24px] p-2">{folderNav}</div>
              {!ro && <div className="liquid-glass-inset rounded-[24px] p-2 pt-3">{toolsNav}</div>}
              {!ro && (
                <button type="button" onClick={() => { setDrawer(false); setMailboxes(true); }} className="text-sm px-3 py-2 rounded-xl text-slate-700 hover:bg-black/5 inline-flex items-center gap-2">
                  <Server className="w-4 h-4" /> Mailboxes
                </button>
              )}
              {onBack && (
                <button type="button" onClick={onBack} className="mt-auto text-sm px-3 py-2 rounded-xl text-slate-700 hover:bg-black/5 inline-flex items-center gap-2">
                  <ArrowLeft className="w-4 h-4" /> {ro ? 'Close this mailbox' : 'Back to CredenceHR'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {mailboxes && (
        <MailboxesPopup
          token={token}
          userName={user.name}
          accounts={accounts}
          onClose={() => setMailboxes(false)}
          onChanged={() => {
            void loadStatus();
            setAccountFilter(0);
          }}
        />
      )}

      {compose && (
        <MailCompose
          token={token}
          accounts={accounts}
          signatures={settings?.signatures || []}
          templates={templates}
          init={compose}
          onClose={() => {
            setCompose(null);
            refreshRef.current();
          }}
          onDone={(text) => say(text)}
        />
      )}

      {tool?.kind === 'settings' && settings && (
        <MailSettingsPopup
          token={token}
          userName={user.name}
          settings={settings}
          startTab={tool.tab}
          onClose={() => setTool(null)}
          onSaved={(st) => {
            setMailTimeZone(st.timezone);
            setSettings(st);
            say('Settings saved.');
            // Dates in the list follow the new time zone.
            setList((prev) => (prev ? { ...prev } : prev));
          }}
        />
      )}
      {tool?.kind === 'rules' && (
        <MailRulesPopup token={token} prefill={tool.prefill} onClose={() => setTool(null)} onChanged={loadRuleLabels} />
      )}
      {tool?.kind === 'templates' && <MailTemplatesPopup token={token} onClose={() => setTool(null)} onChanged={setTemplates} />}
      {tool?.kind === 'contacts' && (
        <MailContactsPopup
          token={token}
          prefill={tool.prefill}
          onClose={() => setTool(null)}
          onWrite={(email) => {
            setTool(null);
            setCompose({ accountId: accountFilter || undefined, to: email });
          }}
        />
      )}
      {tool?.kind === 'planner' && (
        <MailPlannerPopup
          token={token}
          startTab={tool.tab}
          fromMail={tool.fromMail}
          onClose={() => setTool(null)}
          onOpenMail={(id) => {
            setTool(null);
            setSelectedId(id);
          }}
        />
      )}
      {tool?.kind === 'analytics' && <MailAnalyticsPopup token={token} onClose={() => setTool(null)} />}

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[95] px-4 w-full max-w-sm pointer-events-none" style={{ bottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
          <div className={`pointer-events-auto rounded-2xl px-4 py-2.5 text-sm shadow-lg text-center ${toast.tone === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white'}`}>{toast.text}</div>
        </div>
      )}
    </div>
  );
};

export default CredenceMail;
