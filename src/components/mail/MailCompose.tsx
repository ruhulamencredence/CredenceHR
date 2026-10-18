/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> write a mail (new, reply, reply all, forward, or an open
// draft). Liquid-glass popup (CLAUDE.md -> Popup style). Saves itself as a
// draft while you write and when closed; Send now or Send later.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Send, Paperclip, Bold, Italic, Underline, List, ListOrdered, Link2, Quote, RemoveFormatting, Clock, Trash2, Loader2, ChevronDown, FileText, PenLine
} from 'lucide-react';
import { confirmDialog } from '../../lib/confirmDialog';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { useKeyboardInset } from '../../lib/useKeyboardInset';
import {
  AddressSuggestion, MailAccount, MailAttachment, MailSignature, MailTemplate, OutgoingFile, fetchAttachment, fileToDataUrl, formatBytes, mailFetch
} from '../../lib/mailApi';

export interface ComposeInit {
  accountId?: number;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string | null;
  // Open draft being continued, and its saved attachments.
  draftId?: string;
  draftAttachments?: MailAttachment[];
  // Forward: the original's attachments are fetched and sent again.
  forwardFrom?: { messageId: string; attachments: MailAttachment[] };
  scheduledAt?: string | null;
}

// Must stay under the server's JSON limit (server.ts: 25 MB, base64 adds a third).
const MAX_TOTAL = 15 * 1024 * 1024;

const SIG_OPEN = '<div data-credence-signature="1">';
const withSignature = (body: string, sig: MailSignature | null) => {
  const stripped = body.replace(/<div data-credence-signature="1">[\s\S]*?<\/div><!--\/sig-->/, '');
  if (!sig) return stripped;
  const block = `${SIG_OPEN}<br>${sig.content}</div><!--/sig-->`;
  // Above a quoted mail (reply / forward), else at the end.
  const q = stripped.indexOf('<div data-credence-quote="1">');
  return q >= 0 ? stripped.slice(0, q) + block + stripped.slice(q) : stripped + block;
};

const localDateTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Everyone in the Employee Directory with an email (GET /api/mail/directory),
// fetched once per visit and shared by every To / Cc / Bcc field.
export interface DirectoryPerson {
  name: string;
  email: string;
  designation: string;
  department: string;
}
let directoryCache: Promise<DirectoryPerson[]> | null = null;
const loadDirectory = (token: string) => {
  if (!directoryCache) {
    directoryCache = mailFetch<DirectoryPerson[]>(token, '/directory').catch(() => {
      directoryCache = null;
      return [];
    });
  }
  return directoryCache;
};

type Suggestion = { name: string; email: string; sub: string; tag: string };
const SHOW_MAX = 150;

// To / Cc / Bcc: type any address, or pick from the list — employees (all of
// them, from the dropdown button or as you type), your contacts and people
// you've written with. Several addresses, comma between.
const AddressField: React.FC<{ token: string; label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; right?: React.ReactNode }> = ({
  token, label, value, onChange, autoFocus, right
}) => {
  const [book, setBook] = useState<AddressSuggestion[]>([]);
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = (value.split(/[,;]/).pop() || '').trim();
  const chosen = useMemo(() => new Set(value.split(/[,;]/).map((x) => (/<([^>]+)>/.exec(x)?.[1] || x).trim().toLowerCase()).filter(Boolean)), [value]);

  useEffect(() => {
    if (open && !people) void loadDirectory(token).then(setPeople);
  }, [open, people, token]);

  // Own contacts and people written with, as you type.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (current.length < 2) {
      setBook([]);
      return;
    }
    timer.current = setTimeout(() => {
      mailFetch<AddressSuggestion[]>(token, `/address-book?q=${encodeURIComponent(current)}`)
        .then((r) => setBook(r.filter((x) => x.source !== 'colleague')))
        .catch(() => setBook([]));
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [current, token]);

  const list = useMemo(() => {
    const q = current.toLowerCase();
    const out: Suggestion[] = [];
    const seen = new Set<string>(chosen);
    for (const b of book) {
      if (seen.has(b.email)) continue;
      seen.add(b.email);
      out.push({ name: b.name, email: b.email, sub: '', tag: b.source === 'contact' ? 'Contact' : 'Recent' });
    }
    for (const p of people || []) {
      if (seen.has(p.email)) continue;
      if (q && !`${p.name} ${p.email} ${p.designation} ${p.department}`.toLowerCase().includes(q)) continue;
      seen.add(p.email);
      out.push({ name: p.name, email: p.email, sub: [p.designation, p.department].filter(Boolean).join(' · '), tag: 'Employee' });
    }
    return out;
  }, [book, people, current, chosen]);
  const shown = list.slice(0, SHOW_MAX);
  useEffect(() => setActive(0), [current]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (sug: Suggestion) => {
    const parts = value.split(/[,;]/);
    parts[parts.length - 1] = ` ${sug.email}`;
    onChange(`${parts.join(',').replace(/^\s*,?\s*/, '')}, `);
    // Stays open for the next one.
    inputRef.current?.focus();
  };

  return (
    <div className="relative flex items-center gap-2 border-b border-slate-200/70 px-4">
      <span className="text-xs text-slate-500 w-8 shrink-0">{label}</span>
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        // The list opens from the button, or as soon as something is typed.
        onFocus={() => current && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') return setOpen(false);
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            return setOpen(true);
          }
          if (!open || !shown.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % shown.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a - 1 + shown.length) % shown.length);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && current && shown[active]) {
            e.preventDefault();
            pick(shown[active]);
          }
        }}
        type="text"
        inputMode="email"
        autoComplete="off"
        placeholder={label === 'To' ? 'Type an address or pick from the list' : ''}
        className="flex-1 min-w-0 bg-transparent py-2.5 text-sm focus:outline-none placeholder:text-slate-400"
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((v) => !v);
          inputRef.current?.focus();
        }}
        className="p-1 rounded-lg text-slate-500 hover:bg-black/5 hover:text-slate-800 shrink-0"
        aria-label={`Choose ${label} from employees`}
        aria-expanded={open}
        title="Choose from employees"
      >
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {right}
      {open && (
        <div ref={listRef} className="absolute left-12 right-4 top-full mt-1 z-20 rounded-2xl bg-white shadow-xl ring-1 ring-black/5 overflow-y-auto max-h-72" onMouseDown={(e) => e.preventDefault()}>
          {!people && !book.length ? (
            <div className="px-3 py-3 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading employees…</div>
          ) : !shown.length ? (
            <div className="px-3 py-3 text-xs text-slate-500">{current ? `No one matches “${current}” — the address you type is used as it is.` : 'Everyone is added already.'}</div>
          ) : (
            <>
              {shown.map((sug, i) => (
                <button
                  type="button"
                  key={sug.email}
                  data-i={i}
                  onClick={() => pick(sug)}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 ${i === active ? 'bg-sky-50' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800 truncate">{sug.name}</span>
                    <span className="block text-xs text-slate-500 truncate">
                      {sug.email}
                      {sug.sub && <span className="text-slate-400"> · {sug.sub}</span>}
                    </span>
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">{sug.tag}</span>
                </button>
              ))}
              {list.length > SHOW_MAX && <div className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">{list.length - SHOW_MAX} more — type a name, department or designation to find them.</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const MailCompose: React.FC<{
  token: string;
  accounts: MailAccount[];
  signatures: MailSignature[];
  templates?: MailTemplate[];
  init: ComposeInit;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ token, accounts, signatures, templates = [], init, onClose, onDone }) => {
  const defaultSig = signatures.find((s) => s.isDefault) || null;
  const [accountId, setAccountId] = useState<number>(init.accountId || accounts.find((a) => a.isDefault)?.id || accounts[0]?.id);
  const [to, setTo] = useState(init.to || '');
  const [cc, setCc] = useState(init.cc || '');
  const [bcc, setBcc] = useState(init.bcc || '');
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc));
  // Which recipients get it inside CredenceHR and which through the mail
  // server (MailRoutes.ts "Internal delivery") — shown under the addresses.
  const [route, setRoute] = useState<{ internal: string[]; external: string[]; ourOutside: string[] } | null>(null);
  useEffect(() => {
    if (!accountId || !(to + cc + bcc).trim()) return setRoute(null);
    let gone = false;
    const t = setTimeout(() => {
      mailFetch<{ internal: string[]; external: string[]; ourDomains: string[]; enabled: boolean }>(token, '/route-preview', { method: 'POST', body: { accountId, to, cc, bcc } })
        .then((r) => {
          if (gone) return;
          const ours = new Set(r.ourDomains.map((d) => d.toLowerCase()));
          setRoute({ internal: r.internal, external: r.external, ourOutside: r.enabled ? r.external.filter((x) => ours.has(x.split('@')[1] || '')) : [] });
        })
        .catch(() => !gone && setRoute(null));
    }, 500);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [token, accountId, to, cc, bcc]);
  const [subject, setSubject] = useState(init.subject || '');
  const [sigId, setSigId] = useState<string>(init.draftId ? '' : defaultSig?.id || '');
  const [files, setFiles] = useState<(OutgoingFile & { size: number })[]>([]);
  const [kept, setKept] = useState<MailAttachment[]>(init.draftAttachments || []);
  const [draftId, setDraftId] = useState<string | undefined>(init.draftId);
  const [busy, setBusy] = useState<'' | 'send' | 'schedule' | 'draft' | 'files'>('');
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => localDateTime(new Date(init.scheduledAt ? new Date(init.scheduledAt) : Date.now() + 60 * 60_000)));
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const closing = useRef(false);
  // Set when a draft save itself changes the fields (files -> saved ones).
  const skipDirty = useRef(true);
  const linkRange = useRef<Range | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const keyboardInset = useKeyboardInset();

  // The editor's starting content (set once, then the user owns it).
  const startHtml = useMemo(() => {
    const base = init.body || '<div><br></div>';
    return init.draftId ? base : withSignature(base, defaultSig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = startHtml;
    if (!init.to && editorRef.current && init.inReplyTo) {
      editorRef.current.focus();
    }
  }, [startHtml, init.to, init.inReplyTo]);

  // Forward: bring the original's attachments along.
  useEffect(() => {
    const f = init.forwardFrom;
    if (!f || !f.attachments.length) return;
    let cancelled = false;
    setBusy('files');
    (async () => {
      const out: (OutgoingFile & { size: number })[] = [];
      for (const a of f.attachments) {
        try {
          const blob = await fetchAttachment(token, f.messageId, a.idx);
          const dataUrl = await fileToDataUrl(new File([blob], a.name, { type: a.type }));
          out.push({ name: a.name, type: a.type || blob.type, dataUrl, size: blob.size });
        } catch {
          // A missing one is just left out; the user sees the list.
        }
      }
      if (!cancelled) {
        setFiles((prev) => [...out, ...prev]);
        setBusy('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [init.forwardFrom, token]);

  const html = () => editorRef.current?.innerHTML || '';
  const payload = () => ({
    accountId,
    to,
    cc,
    bcc,
    subject,
    body: html(),
    inReplyTo: init.inReplyTo || undefined,
    attachments: files.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })),
    keepAttachments: kept.map((k) => k.idx)
  });
  const totalSize = files.reduce((n, f) => n + f.size, 0) + kept.reduce((n, k) => n + (k.size || 0), 0);

  const saveDraft = useCallback(
    async (quiet: boolean) => {
      if (!accountId) return;
      const p = payload();
      const empty = !p.to.trim() && !p.cc.trim() && !p.bcc.trim() && !p.subject.trim() && !(editorRef.current?.innerText || '').trim() && !files.length;
      if (empty && !draftId) return;
      if (!quiet) setBusy('draft');
      try {
        const saved = await mailFetch<{ id: string; attachments: MailAttachment[] }>(token, '/drafts', { method: 'POST', body: { ...p, id: draftId } });
        setDraftId(saved.id);
        // Saved now: the files live with the draft.
        skipDirty.current = true;
        setKept(saved.attachments || []);
        setFiles([]);
        dirty.current = false;
        setSavedNote('Draft saved');
        if (!quiet) onDone('Draft saved.');
      } catch (e: any) {
        if (!quiet) setError(e.message);
      } finally {
        if (!quiet) setBusy('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountId, to, cc, bcc, subject, files, kept, draftId, token]
  );

  // Saves quietly while writing (every 10 s after a change).
  useEffect(() => {
    const t = setInterval(() => {
      if (dirty.current && !busy && !closing.current) void saveDraft(true);
    }, 10_000);
    return () => clearInterval(t);
  }, [saveDraft, busy]);

  const markDirty = () => {
    dirty.current = true;
    setSavedNote('');
  };
  useEffect(() => {
    // The first run is the starting values, not a change.
    if (skipDirty.current) {
      skipDirty.current = false;
      return;
    }
    markDirty();
  }, [to, cc, bcc, subject, files, kept, accountId]);

  const close = async () => {
    if (busy === 'send' || busy === 'schedule') return;
    closing.current = true;
    if (dirty.current) await saveDraft(true);
    onClose();
  };
  useBackButtonClose(true, () => void close());

  const discard = async () => {
    if (!(await confirmDialog('Discard this mail? It will be deleted.', { tone: 'danger', confirmLabel: 'Discard' }))) return;
    closing.current = true;
    if (draftId) await mailFetch(token, `/messages/${draftId}`, { method: 'DELETE' }).catch(() => undefined);
    onClose();
  };

  const send = async (later: boolean) => {
    setError('');
    if (!to.trim() && !cc.trim() && !bcc.trim()) return setError('Add at least one recipient.');
    if (totalSize > MAX_TOTAL) return setError(`Attachments can be at most ${formatBytes(MAX_TOTAL)} in total.`);
    let scheduledAt: string | undefined;
    if (later) {
      const d = new Date(scheduleAt);
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 60_000) return setError('Pick a time at least a minute from now.');
      scheduledAt = d.toISOString();
    }
    if (!subject.trim() && !(await confirmDialog('Send this mail without a subject?', { confirmLabel: 'Send' }))) return;
    setBusy(later ? 'schedule' : 'send');
    closing.current = true;
    try {
      const sent = await mailFetch<{ delivery?: { internal: number; external: number } }>(token, '/send', { method: 'POST', body: { ...payload(), draftId, scheduledAt } });
      // How it went: inside CredenceHR (our own mailboxes) and / or through the mail server.
      const d = sent?.delivery;
      const how = d && d.internal ? (d.external ? ` ${d.internal} inside CredenceHR, ${d.external} through the mail server.` : ' Delivered inside CredenceHR.') : '';
      onDone(later ? `Will be sent ${new Date(scheduledAt!).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : `Sent.${how}`);
      onClose();
    } catch (e: any) {
      closing.current = false;
      setError(e.message);
      // A failed send is kept in Drafts by the server.
      dirty.current = false;
    } finally {
      setBusy('');
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setError('');
    const added: (OutgoingFile & { size: number })[] = [];
    let total = totalSize;
    for (const f of Array.from(list)) {
      if (total + f.size > MAX_TOTAL) {
        setError(`Attachments can be at most ${formatBytes(MAX_TOTAL)} in total — "${f.name}" was not added.`);
        break;
      }
      total += f.size;
      added.push({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: await fileToDataUrl(f) });
    }
    setFiles((prev) => [...prev, ...added]);
  };

  const cmd = (name: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(name, false, value);
    markDirty();
  };
  const openLink = () => {
    const sel = window.getSelection();
    linkRange.current = sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setLinkUrl('');
    setLinkOpen(true);
  };
  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) return;
    const safe = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    editorRef.current?.focus();
    const sel = window.getSelection();
    if (linkRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(linkRange.current);
    }
    if (sel && sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${safe.replace(/"/g, '&quot;')}">${safe.replace(/</g, '&lt;')}</a>`);
    else document.execCommand('createLink', false, safe);
    markDirty();
  };
  const insertTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t || !editorRef.current) return;
    if (t.subject && !subject.trim()) setSubject(t.subject);
    const ed = editorRef.current;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      ed.focus();
      document.execCommand('insertHTML', false, t.body);
    } else {
      // At the top, above the signature and any quoted mail.
      ed.innerHTML = `<div>${t.body}</div>${ed.innerHTML}`;
    }
    markDirty();
  };
  const changeSignature = (id: string) => {
    setSigId(id);
    if (!editorRef.current) return;
    editorRef.current.innerHTML = withSignature(editorRef.current.innerHTML, signatures.find((s) => s.id === id) || null);
    markDirty();
  };

  const toolBtn = 'p-1.5 rounded-lg text-slate-600 hover:bg-black/5 hover:text-slate-900';
  const account = accounts.find((a) => a.id === accountId);

  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-0 sm:p-4" style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}>
      <div className="w-full sm:max-w-2xl h-[100dvh] sm:h-auto sm:max-h-[90vh] flex" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-t-[32px] sm:rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
            <h3 className="text-base font-bold text-slate-900 truncate">{init.draftId ? 'Draft' : init.inReplyTo ? 'Reply' : init.forwardFrom ? 'Forward' : 'New mail'}</h3>
            <div className="flex items-center gap-2">
              {savedNote && <span className="text-[11px] text-slate-500">{savedNote}</span>}
              <button type="button" onClick={() => void close()} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="mx-3 liquid-glass-inset rounded-[24px] flex-1 min-h-0 flex flex-col overflow-hidden">
            {accounts.length > 1 && (
              <div className="flex items-center gap-2 border-b border-slate-200/70 px-4">
                <span className="text-xs text-slate-500 w-8 shrink-0">From</span>
                <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className="flex-1 bg-transparent py-2.5 text-sm focus:outline-none">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} &lt;{a.emailAddress}&gt;
                    </option>
                  ))}
                </select>
              </div>
            )}
            <AddressField
              token={token}
              label="To"
              value={to}
              onChange={setTo}
              autoFocus={!init.to && !init.inReplyTo}
              right={
                !showCc && (
                  <button type="button" onClick={() => setShowCc(true)} className="text-xs text-slate-500 hover:text-slate-800 shrink-0">
                    Cc / Bcc
                  </button>
                )
              }
            />
            {showCc && <AddressField token={token} label="Cc" value={cc} onChange={setCc} />}
            {showCc && <AddressField token={token} label="Bcc" value={bcc} onChange={setBcc} />}
            {route && (route.internal.length > 0 || route.external.length > 0) && (
              <div className="px-4 py-1.5 border-b border-slate-200/70 text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5" title={[...route.internal.map((x) => `${x}: inside CredenceHR`), ...route.external.map((x) => `${x}: through the mail server`)].join('\n')}>
                {route.internal.length > 0 && <span className="text-emerald-700">{route.internal.length === 1 && !route.external.length ? 'Delivered inside CredenceHR' : `${route.internal.length} inside CredenceHR`}</span>}
                {route.external.length > 0 && (
                  <span>
                    {route.internal.length ? `${route.external.length} through the mail server` : 'Through the mail server'}
                    {route.ourOutside.length > 0 && ` (${route.ourOutside.join(', ')} ${route.ourOutside.length > 1 ? "aren't" : "isn't"} on Credence Mail)`}
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 border-b border-slate-200/70 px-4">
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="flex-1 min-w-0 bg-transparent py-2.5 text-sm font-medium focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-0.5 px-2 py-1 border-b border-slate-200/70 overflow-x-auto">
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')} aria-label="Bold"><Bold className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')} aria-label="Italic"><Italic className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('underline')} aria-label="Underline"><Underline className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')} aria-label="Bulleted list"><List className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertOrderedList')} aria-label="Numbered list"><ListOrdered className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('formatBlock', 'blockquote')} aria-label="Quote"><Quote className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={openLink} aria-label="Link"><Link2 className="w-4 h-4" /></button>
              <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('removeFormat')} aria-label="Clear formatting"><RemoveFormatting className="w-4 h-4" /></button>
              <span className="w-px h-5 bg-slate-200 mx-1 shrink-0" />
              <button type="button" className={toolBtn} onClick={() => fileRef.current?.click()} aria-label="Attach files"><Paperclip className="w-4 h-4" /></button>
              {templates.length > 0 && (
                <label className="ml-auto flex items-center gap-1 text-xs text-slate-500 shrink-0 pl-2">
                  <FileText className="w-3.5 h-3.5" />
                  <select value="" onChange={(e) => insertTemplate(e.target.value)} className="bg-transparent focus:outline-none max-w-[8rem]" aria-label="Insert a template">
                    <option value="">Template</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                </label>
              )}
              {signatures.length > 0 && (
                <label className={`${templates.length ? '' : 'ml-auto '}flex items-center gap-1 text-xs text-slate-500 shrink-0 pl-2`}>
                  <PenLine className="w-3.5 h-3.5" />
                  <select value={sigId} onChange={(e) => changeSignature(e.target.value)} className="bg-transparent focus:outline-none max-w-[9rem]">
                    <option value="">No signature</option>
                    {signatures.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {linkOpen && (
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/70">
                <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <input
                  autoFocus
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyLink();
                    } else if (e.key === 'Escape') setLinkOpen(false);
                  }}
                  placeholder="https://…"
                  className="flex-1 min-w-0 text-sm px-2 py-1 rounded-lg bg-white/80 border border-slate-200 focus:outline-none"
                />
                <button type="button" onClick={applyLink} className="text-xs font-semibold text-sky-700 px-2 py-1 rounded-lg hover:bg-sky-50">Add link</button>
                <button type="button" onClick={() => setLinkOpen(false)} className="p-1 rounded-full hover:bg-black/5" aria-label="Cancel"><X className="w-3.5 h-3.5" /></button>
              </div>
            )}
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />

            <div className="flex-1 min-h-[12rem] overflow-y-auto">
              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={markDirty}
                onPaste={() => setTimeout(markDirty, 0)}
                className="mail-editor min-h-full px-4 py-3 text-sm text-slate-800 focus:outline-none [&_blockquote]:border-l-[3px] [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_img]:max-w-full"
              />
            </div>

            {(kept.length > 0 || files.length > 0 || busy === 'files') && (
              <div className="px-3 py-2 border-t border-slate-200/70 flex flex-wrap gap-1.5">
                {kept.map((k) => (
                  <span key={`k${k.idx}`} className="inline-flex items-center gap-1 rounded-full bg-white/80 ring-1 ring-slate-200 pl-2.5 pr-1 py-1 text-xs text-slate-700 max-w-full">
                    <Paperclip className="w-3 h-3 shrink-0" /> <span className="truncate max-w-[10rem]">{k.name}</span> <span className="text-slate-400">{formatBytes(k.size)}</span>
                    <button type="button" onClick={() => setKept((p) => p.filter((x) => x.idx !== k.idx))} className="p-0.5 rounded-full hover:bg-black/5" aria-label={`Remove ${k.name}`}><X className="w-3 h-3" /></button>
                  </span>
                ))}
                {files.map((f, i) => (
                  <span key={`f${i}`} className="inline-flex items-center gap-1 rounded-full bg-white/80 ring-1 ring-slate-200 pl-2.5 pr-1 py-1 text-xs text-slate-700 max-w-full">
                    <Paperclip className="w-3 h-3 shrink-0" /> <span className="truncate max-w-[10rem]">{f.name}</span> <span className="text-slate-400">{formatBytes(f.size)}</span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="p-0.5 rounded-full hover:bg-black/5" aria-label={`Remove ${f.name}`}><X className="w-3 h-3" /></button>
                  </span>
                ))}
                {busy === 'files' && (
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500 px-2 py-1"><Loader2 className="w-3 h-3 animate-spin" /> Adding the attachments…</span>
                )}
              </div>
            )}
          </div>

          {error && <div className="mx-4 mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {scheduleOpen && (
            <div className="mx-4 mt-2 rounded-2xl liquid-glass-inset p-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-600">Send on</span>
              <input
                type="datetime-local"
                value={scheduleAt}
                min={localDateTime(new Date(Date.now() + 2 * 60_000))}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="text-sm px-2 py-1.5 rounded-xl bg-white/80 border border-slate-200 focus:outline-none"
              />
              <button type="button" disabled={!!busy} onClick={() => void send(true)} className="liquid-glass-button rounded-full px-4 py-1.5 text-xs font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-1.5">
                {busy === 'schedule' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />} Schedule
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void discard()} className="p-2 rounded-full text-slate-500 hover:bg-rose-50 hover:text-rose-600" aria-label="Discard">
                <Trash2 className="w-4 h-4" />
              </button>
              <button type="button" disabled={!!busy} onClick={() => void saveDraft(false)} className="text-xs font-medium text-slate-600 hover:text-slate-900 px-2 py-1.5 rounded-full hover:bg-black/5 disabled:opacity-50">
                {busy === 'draft' ? 'Saving…' : 'Save draft'}
              </button>
            </div>
            <div className="flex items-center rounded-full overflow-hidden">
              <button
                type="button"
                disabled={!!busy || !account}
                onClick={() => void send(false)}
                className="liquid-glass-button rounded-l-full pl-5 pr-4 py-2 text-sm font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-2"
              >
                {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setScheduleOpen((v) => !v)}
                className="liquid-glass-button rounded-r-full px-2.5 py-2 text-white bg-sky-700 disabled:opacity-60 border-l border-white/30"
                aria-label="Send later"
                title="Send later"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
