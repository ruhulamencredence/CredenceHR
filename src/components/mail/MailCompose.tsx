/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> write a mail (new, reply, reply all, forward, or an open
// draft). Laid out like Gmail's compose window (asked for by the users): a
// window docked at the bottom right that can be minimised or made full size,
// To with Cc / Bcc, a formatting bar and the blue Send button with Schedule
// send; the whole screen on a phone. Saves itself as a draft while you write
// and when closed.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  X, Send, Paperclip, Bold, Italic, Underline, List, ListOrdered, Link2, Quote, RemoveFormatting, Clock, Trash2, Loader2, ChevronDown, FileText, PenLine,
  Minus, Maximize2, Minimize2, ArrowLeft, Type, Undo2, Redo2, AlignLeft
} from 'lucide-react';
import { confirmDialog } from '../../lib/confirmDialog';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { useKeyboardInset } from '../../lib/useKeyboardInset';
import { SearchSelect } from '../Combobox';
import {
  AddressSuggestion, DirectoryPerson, MailAccount, MailAttachment, MailSignature, MailTemplate, OutgoingFile, fetchAttachment, fileToDataUrl, formatBytes,
  loadDirectory, loadMailGroups, mailFetch, type ComposeGroups
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


type Suggestion = {
  name: string;
  email: string;
  sub: string;
  tag: string;
  employeeId?: string;
  designation?: string;
  department?: string;
  // A group: central (its one address goes in) or one's own (every member goes in).
  key?: string;
  members?: string[];
};
const SHOW_MAX = 150;

// To / Cc / Bcc: type any address, or pick from the list — groups, employees
// (all of them, from the dropdown button or as you type), your contacts and
// people you've written with. Each address shows as a chip with the person's
// name (tap it for the full address), wrapping onto more lines; while not
// being edited, two lines at most and "+N more".
const AddressField: React.FC<{ token: string; label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; right?: React.ReactNode }> = ({
  token, label, value, onChange, autoFocus, right
}) => {
  const [book, setBook] = useState<AddressSuggestion[]>([]);
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [groups, setGroups] = useState<ComposeGroups | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = (value.split(/[,;]/).pop() || '').trim();
  const chosen = useMemo(() => new Set(value.split(/[,;]/).map((x) => (/<([^>]+)>/.exec(x)?.[1] || x).trim().toLowerCase()).filter(Boolean)), [value]);

  useEffect(() => {
    if (open && !people) void loadDirectory(token).then(setPeople);
    if (open && !groups) void loadMailGroups(token).then(setGroups);
  }, [open, people, groups, token]);

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
    const byEmail = new Map((people || []).map((p) => [p.email, p]));
    // Groups first: they're what people usually look for by name.
    for (const g of groups?.central || []) {
      if (seen.has(g.email)) continue;
      if (q && !`${g.name} ${g.email}`.toLowerCase().includes(q)) continue;
      seen.add(g.email);
      out.push({ name: g.name, email: g.email, sub: `${g.count} ${g.count === 1 ? 'person' : 'people'}`, tag: 'Group', key: `g:${g.email}` });
    }
    for (const g of groups?.mine || []) {
      if (q && !g.name.toLowerCase().includes(q)) continue;
      const left = g.members.filter((m) => !chosen.has(m.toLowerCase()));
      if (!left.length) continue;
      out.push({ name: g.name, email: '', sub: `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'} — adds each one`, tag: 'My group', key: `m:${g.id}`, members: left });
    }
    for (const b of book) {
      if (seen.has(b.email)) continue;
      seen.add(b.email);
      // A contact or recent address that is an Employee shows as one.
      const p = byEmail.get(b.email.toLowerCase());
      out.push(
        p
          ? { name: p.name, email: p.email, sub: '', tag: b.source === 'contact' ? 'Contact' : 'Recent', employeeId: p.employeeId, designation: p.designation, department: p.department }
          : { name: b.name, email: b.email, sub: '', tag: b.source === 'contact' ? 'Contact' : 'Recent' }
      );
    }
    for (const p of people || []) {
      if (seen.has(p.email)) continue;
      // Name, email, Employee ID, designation or department.
      if (q && !`${p.name} ${p.email} ${p.employeeId || ''} ${p.designation} ${p.department}`.toLowerCase().includes(q)) continue;
      seen.add(p.email);
      out.push({ name: p.name, email: p.email, sub: '', tag: 'Employee', employeeId: p.employeeId, designation: p.designation, department: p.department });
    }
    return out;
  }, [book, people, groups, current, chosen]);
  const shown = list.slice(0, SHOW_MAX);
  useEffect(() => setActive(0), [current]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // The field's value stays "a@x.com, b@y.com, <what is being typed>"; each
  // finished address shows as a chip with the person's name.
  const parts = value.split(/[,;]/);
  const committed = parts.slice(0, -1).map((x) => x.trim()).filter(Boolean);
  const join = (list: string[], typed = '') => (list.length ? `${list.join(', ')}, ` : '') + typed;
  const commitTyped = () => {
    if (current) onChange(join([...committed, current]));
  };
  const pick = (sug: Suggestion) => {
    onChange(join([...committed, ...(sug.members ? sug.members : [sug.email])]));
    // Stays open for the next one.
    inputRef.current?.focus();
  };
  const removeAt = (i: number) => onChange(join(committed.filter((_, k) => k !== i), current));

  // Names for the chips: employees (directory), groups, "Name <address>".
  useEffect(() => {
    if (committed.length && !people) void loadDirectory(token).then(setPeople);
    if (committed.length && !groups) void loadMailGroups(token).then(setGroups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.length > 0, people, groups, token]);
  const byEmail = useMemo(() => new Map((people || []).map((p) => [p.email.toLowerCase(), p])), [people]);
  const chipOf = (raw: string) => {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
    const email = (m ? m[2] : raw).trim();
    const person = byEmail.get(email.toLowerCase());
    const group = (groups?.central || []).find((g) => g.email.toLowerCase() === email.toLowerCase());
    const name = person?.name || group?.name || (m && m[1].trim()) || '';
    const kind: 'person' | 'group' | 'other' = person ? 'person' : group ? 'group' : 'other';
    const detail = person
      ? [person.employeeId && `ID ${person.employeeId}`, person.designation, person.department].filter(Boolean).join(' · ')
      : group
      ? `Group · ${group.count} ${group.count === 1 ? 'person' : 'people'}`
      : '';
    return { email, name, label: name || email, kind, detail };
  };

  // Not being edited: at most two lines of chips, the rest as "+N more".
  const [focused, setFocused] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [openChip, setOpenChip] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chipsKey = committed.join('|');
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => setLimit(null), [chipsKey, width, focused]);
  useLayoutEffect(() => {
    if (focused || limit !== null || !boxRef.current) return;
    const chips = [...boxRef.current.querySelectorAll<HTMLElement>('[data-chip]')];
    const tops = [...new Set(chips.map((c) => c.offsetTop))].sort((x, y) => x - y);
    if (tops.length <= 2) return;
    const firstHidden = chips.findIndex((c) => c.offsetTop > tops[1]);
    // The "+N more" pill (about 80px) goes after the last chip of line two
    // when it fits there, else that chip makes way for it.
    const lastRight = chips[firstHidden - 1].getBoundingClientRect().right;
    const fits = lastRight + 86 <= boxRef.current.getBoundingClientRect().right;
    setLimit(Math.max(1, fits ? firstHidden : firstHidden - 1));
  }, [focused, limit, chipsKey, width]);
  const visible = !focused && limit !== null ? limit : committed.length;
  useEffect(() => {
    if (openChip === null) return;
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpenChip(null);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [openChip]);

  const palette = ['#2563eb', '#059669', '#7c3aed', '#db2777', '#0891b2', '#ea580c', '#16a34a', '#9333ea', '#0d9488', '#be123c', '#4f46e5', '#ca8a04'];
  const colourOf = (email: string) => palette[[...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % palette.length];

  return (
    <div className="relative flex items-start gap-2 border-b border-slate-200 mx-4">
      <span className="text-sm text-slate-500 shrink-0 pt-2 w-7">{label}</span>
      <div
        ref={boxRef}
        className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 py-1.5 cursor-text"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {committed.slice(0, visible).map((raw, i) => {
          const c = chipOf(raw);
          const tone =
            c.kind === 'group' ? 'bg-violet-50 ring-1 ring-violet-200' : c.kind === 'other' ? 'bg-orange-50 ring-1 ring-orange-200' : 'bg-slate-100 hover:bg-slate-200';
          return (
            <span key={`${raw}-${i}`} data-chip className={`relative inline-flex items-center gap-1.5 max-w-full h-7 pl-0.5 pr-1 rounded-full text-[13px] text-slate-800 ${tone}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setOpenChip(openChip === i ? null : i)}
                title={[c.name, c.email, c.detail].filter(Boolean).join('\n')}
                className="inline-flex items-center gap-1.5 min-w-0"
              >
                <span
                  className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white"
                  style={{ background: c.kind === 'other' ? '#fb923c' : c.kind === 'group' ? '#7c3aed' : colourOf(c.email) }}
                >
                  {(c.label.trim()[0] || '?').toUpperCase()}
                </span>
                <span className="truncate max-w-[220px]">{c.label}</span>
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpenChip(null);
                  removeAt(i);
                }}
                aria-label={`Remove ${c.label}`}
                className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-slate-500 hover:bg-slate-300 hover:text-slate-900"
              >
                <X className="w-3 h-3" />
              </button>
              {openChip === i && (
                <span className="absolute left-0 top-full mt-1.5 z-30 w-max max-w-[min(80vw,360px)] rounded-lg bg-slate-800 text-white px-3 py-2 shadow-xl text-left">
                  <span className="block text-xs font-semibold">{c.name || c.email}</span>
                  <span className="block text-[11px] text-slate-200 break-all">{c.email}</span>
                  {c.detail && <span className="block text-[11px] text-slate-300">{c.detail}</span>}
                </span>
              )}
            </span>
          );
        })}
        {visible < committed.length && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => inputRef.current?.focus()}
            className="h-7 px-2 rounded-full text-xs font-semibold text-blue-700 hover:bg-blue-50"
          >
            +{committed.length - visible} more
          </button>
        )}
        <input
          ref={inputRef}
          value={parts[parts.length - 1].replace(/^\s+/, '')}
          autoFocus={autoFocus}
          onChange={(e) => {
            const typed = e.target.value;
            // A full address followed by a space becomes a chip (like a comma).
            if (/\s$/.test(typed) && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(typed.trim())) onChange(join([...committed, typed.trim()]));
            else onChange(join(committed, typed));
            setOpen(true);
          }}
          // The list opens from the button, or as soon as something is typed.
          onFocus={() => {
            setFocused(true);
            if (current) setOpen(true);
          }}
          onBlur={() => {
            setFocused(false);
            // A typed address left in the box becomes a chip.
            if (current.includes('@')) commitTyped();
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return setOpen(false);
            if (e.key === 'Backspace' && !current && committed.length) {
              e.preventDefault();
              return onChange(join(committed.slice(0, -1)));
            }
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault();
              return setOpen(true);
            }
            // Enter keeps what was typed only when it is a whole address (a
            // name half typed before the list loaded stays in the box).
            if (e.key === 'Enter' && current && (!open || !shown.length)) {
              e.preventDefault();
              if (current.includes('@')) commitTyped();
              return;
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
          aria-label={label}
          placeholder={label === 'To' && !committed.length ? 'Recipients — name, email or Employee ID' : ''}
          // Takes no line of its own while the field isn't being edited.
          className={`bg-transparent h-7 text-sm focus:outline-none placeholder:text-slate-500 ${focused || !committed.length || current ? 'flex-1 min-w-[80px]' : 'w-1 min-w-0 flex-none'}`}
        />
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((v) => !v);
          inputRef.current?.focus();
        }}
        className="p-1 mt-1.5 rounded-lg text-slate-500 hover:bg-black/5 hover:text-slate-800 shrink-0"
        aria-label={`Choose ${label} from employees`}
        aria-expanded={open}
        title="Choose from employees"
      >
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {right && <span className="pt-2 shrink-0">{right}</span>}
      {open && (
        <div ref={listRef} className="absolute left-6 right-0 top-full mt-1 z-20 rounded-lg bg-white shadow-xl ring-1 ring-black/10 overflow-y-auto max-h-72" onMouseDown={(e) => e.preventDefault()}>
          {!people && !book.length ? (
            <div className="px-3 py-3 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading employees…</div>
          ) : !shown.length ? (
            <div className="px-3 py-3 text-xs text-slate-500">{current ? `No one matches “${current}” — press Enter to use the address as typed.` : 'Everyone is added already.'}</div>
          ) : (
            <>
              {shown.map((sug, i) => (
                <button
                  type="button"
                  key={sug.key || sug.email}
                  data-i={i}
                  onClick={() => pick(sug)}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 ${i === active ? 'bg-[#e8f0fe]' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className="text-sm font-medium text-slate-800 truncate">{sug.name}</span>
                      {sug.employeeId && <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-slate-100 text-slate-600 shrink-0">ID {sug.employeeId}</span>}
                    </span>
                    {(sug.designation || sug.department) && (
                      <span className="block text-xs text-slate-600 truncate">
                        {sug.designation}
                        {sug.designation && sug.department && <span className="text-slate-400"> · </span>}
                        {sug.department}
                      </span>
                    )}
                    <span className="block text-xs text-slate-500 truncate">
                      {sug.email}
                      {sug.sub && <span className="text-slate-400">{sug.email ? ' · ' : ''}{sug.sub}</span>}
                    </span>
                  </span>
                  <span className={`text-[10px] shrink-0 ${sug.key ? 'font-semibold px-1.5 py-px rounded bg-violet-50 text-violet-700' : 'text-slate-400'}`}>{sug.tag}</span>
                </button>
              ))}
              {list.length > SHOW_MAX && <div className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">{list.length - SHOW_MAX} more — type a name, Employee ID, department or designation to find them.</div>}
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
  // Which recipients get it inside CredenceHR and which through the mail
  // server (MailRoutes.ts "Internal delivery") — shown under the addresses.
  const [route, setRoute] = useState<{
    internal: string[];
    external: string[];
    ourOutside: string[];
    reasons: Record<string, string>;
    groups: { email: string; name: string; count: number; denied: boolean }[];
  } | null>(null);
  useEffect(() => {
    if (!accountId || !(to + cc + bcc).trim()) return setRoute(null);
    let gone = false;
    const t = setTimeout(() => {
      mailFetch<{ internal: string[]; external: string[]; ourDomains: string[]; enabled: boolean; reasons?: Record<string, string>; groups?: { email: string; name: string; count: number; denied: boolean }[] }>(token, '/route-preview', { method: 'POST', body: { accountId, to, cc, bcc } })
        .then((r) => {
          if (gone) return;
          const ours = new Set(r.ourDomains.map((d) => d.toLowerCase()));
          // Ours that still go through the server — each with its reason.
          const reasons = r.reasons || {};
          setRoute({ internal: r.internal, external: r.external, ourOutside: r.external.filter((x) => ours.has(x.split('@')[1] || '') || (reasons[x] && reasons[x] !== 'outside address')), reasons, groups: r.groups || [] });
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

  const toolBtn = 'p-1.5 rounded-full text-slate-600 hover:bg-slate-100 hover:text-slate-900 shrink-0';
  const account = accounts.find((a) => a.id === accountId);
  const title = init.draftId ? 'Draft' : init.inReplyTo ? 'Reply' : init.forwardFrom ? 'Forward' : 'New Message';
  const shownTitle = subject.trim() || title;
  // Gmail-like window: docked at the bottom right (the mail list stays
  // usable), minimised to its title bar, or full size over a dimmed page.
  // On a phone it is the whole screen.
  const [mode, setMode] = useState<'normal' | 'min' | 'max'>('normal');

  // Computer: the window can be dragged bigger or smaller from its left edge,
  // top edge or top-left corner (it sits at the bottom right). The size is
  // remembered on this device; double-click the corner for the usual size.
  const SIZE_KEY = 'credence_compose_size';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
      return v && v.w > 0 && v.h > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const fit = (w: number, h: number) => ({
    w: Math.round(Math.min(Math.max(w, 380), window.innerWidth - 32)),
    h: Math.round(Math.min(Math.max(h, 320), window.innerHeight - 16))
  });
  const winRef = useRef<HTMLDivElement>(null);
  const startResize = (dir: 'x' | 'y' | 'xy') => (e: React.PointerEvent) => {
    if (e.button !== 0 || !winRef.current) return;
    e.preventDefault();
    const r = winRef.current.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    let last = { w: r.width, h: r.height };
    const move = (ev: PointerEvent) => {
      last = fit(dir === 'y' ? start.w : start.w + (start.x - ev.clientX), dir === 'x' ? start.h : start.h + (start.y - ev.clientY));
      setSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(last));
      } catch {
        // storage unavailable — the size lasts until the window closes
      }
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resetSize = () => {
    setSize(null);
    try {
      localStorage.removeItem(SIZE_KEY);
    } catch {
      // ignore
    }
  };
  // A remembered size never larger than this screen.
  const sized = wide && mode === 'normal' && size ? fit(size.w, size.h) : null;
  const [formatBar, setFormatBar] = useState(true);
  const [showBcc, setShowBcc] = useState(!!init.bcc);
  const [showCcOnly, setShowCcOnly] = useState(!!init.cc);
  const ccOpen = showCcOnly;
  const bccOpen = showBcc;

  const headerBtn = 'p-1 rounded hover:bg-black/10 text-slate-700';
  const fmt = (name: string, Icon: React.ComponentType<{ className?: string }>, label: string, value?: string) => (
    <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(name, value)} aria-label={label} title={label}>
      <Icon className="w-4 h-4" />
    </button>
  );

  const header = (
    <div
      className={`flex items-center gap-2 pl-4 pr-2 h-10 bg-[#f2f6fc] shrink-0 ${mode === 'max' ? 'rounded-t-2xl' : 'sm:rounded-t-xl'} ${mode === 'min' ? 'cursor-pointer' : ''}`}
      onClick={mode === 'min' ? () => setMode('normal') : undefined}
    >
      <button type="button" onClick={() => void close()} className="sm:hidden p-1 -ml-2 rounded-full hover:bg-black/10" aria-label="Back">
        <ArrowLeft className="w-5 h-5 text-slate-700" />
      </button>
      <h3 className="flex-1 min-w-0 text-sm font-medium text-slate-800 truncate">{shownTitle}</h3>
      {savedNote && mode !== 'min' && <span className="hidden sm:inline text-[11px] text-slate-500 shrink-0">{savedNote}</span>}
      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setMode(mode === 'min' ? 'normal' : 'min')} className={`hidden sm:block ${headerBtn}`} aria-label={mode === 'min' ? 'Open' : 'Minimise'} title={mode === 'min' ? 'Open' : 'Minimise'}>
          <Minus className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => setMode(mode === 'max' ? 'normal' : 'max')} className={`hidden sm:block ${headerBtn}`} aria-label={mode === 'max' ? 'Exit full screen' : 'Full screen'} title={mode === 'max' ? 'Exit full screen' : 'Full screen'}>
          {mode === 'max' ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        <button type="button" onClick={() => void close()} className={`hidden sm:block ${headerBtn}`} aria-label="Save & close" title="Save & close">
          <X className="w-4 h-4" />
        </button>
        {/* Phone: attach and send live in the top bar, like the Gmail app. */}
        <button type="button" onClick={() => fileRef.current?.click()} className="sm:hidden p-2 rounded-full hover:bg-black/10" aria-label="Attach files">
          <Paperclip className="w-5 h-5 text-slate-700" />
        </button>
        <button type="button" disabled={!!busy || !account} onClick={() => void send(false)} className="sm:hidden p-2 rounded-full hover:bg-black/10 disabled:opacity-50" aria-label="Send">
          {busy === 'send' ? <Loader2 className="w-5 h-5 animate-spin text-[#0b57d0]" /> : <Send className="w-5 h-5 text-[#0b57d0]" />}
        </button>
      </div>
    </div>
  );

  const fieldRow = 'flex items-center gap-2 border-b border-slate-200 mx-4';
  const body = (
    <>
      {accounts.length > 1 && (
        <div className={fieldRow}>
          <span className="text-sm text-slate-500 shrink-0">From</span>
          <SearchSelect value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className="flex-1 min-w-0 bg-transparent py-2 text-sm focus:outline-none">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} &lt;{a.emailAddress}&gt;
              </option>
            ))}
          </SearchSelect>
        </div>
      )}
      <AddressField
        token={token}
        label="To"
        value={to}
        onChange={setTo}
        autoFocus={!init.to && !init.inReplyTo}
        right={
          (!ccOpen || !bccOpen) && (
            <span className="flex items-center gap-2 shrink-0 text-sm text-slate-600">
              {!ccOpen && (
                <button type="button" onClick={() => setShowCcOnly(true)} className="hover:underline">
                  Cc
                </button>
              )}
              {!bccOpen && (
                <button type="button" onClick={() => setShowBcc(true)} className="hover:underline">
                  Bcc
                </button>
              )}
            </span>
          )
        }
      />
      {ccOpen && <AddressField token={token} label="Cc" value={cc} onChange={setCc} />}
      {bccOpen && <AddressField token={token} label="Bcc" value={bcc} onChange={setBcc} />}
      {route && (route.internal.length > 0 || route.external.length > 0 || route.groups.length > 0) && (
        <div className="mx-4 py-1 border-b border-slate-200 text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5" title={[...route.internal.map((x) => `${x}: inside CredenceHR`), ...route.external.map((x) => `${x}: through the mail server`)].join('\n')}>
          {route.groups.map((g) =>
            g.denied ? (
              <span key={g.email} className="basis-full text-rose-700">
                {g.name} ({g.email}): you can't write to this group — ask Mail Administration to let you.
              </span>
            ) : (
              <span key={g.email} className="text-violet-700">
                Group {g.name}: {g.count} {g.count === 1 ? 'person' : 'people'}
              </span>
            )
          )}
          {route.internal.length > 0 && <span className="text-emerald-700">{route.internal.length === 1 && !route.external.length ? 'Delivered inside CredenceHR' : `${route.internal.length} inside CredenceHR`}</span>}
          {route.external.length > 0 && (
            <span>
              {route.internal.length ? `${route.external.length} through the mail server` : 'Through the mail server'}
            </span>
          )}
          {route.ourOutside.map((x) => (
            <span key={x} className="basis-full text-amber-700">
              {x}: through the mail server — {route.reasons[x] || 'not on Credence Mail'}
            </span>
          ))}
        </div>
      )}
      <div className={fieldRow}>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="flex-1 min-w-0 bg-transparent py-2 text-sm focus:outline-none placeholder:text-slate-500" />
      </div>

      <div className="flex-1 min-h-[10rem] overflow-y-auto">
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={markDirty}
          onPaste={() => setTimeout(markDirty, 0)}
          className="mail-editor min-h-full px-4 py-3 text-sm text-slate-800 focus:outline-none [&_blockquote]:border-l-[3px] [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_img]:max-w-full"
        />
        {(kept.length > 0 || files.length > 0 || busy === 'files') && (
          <div className="px-4 pb-3 flex flex-col gap-1.5">
            {kept.map((k) => (
              <span key={`k${k.idx}`} className="flex items-center gap-2 rounded bg-[#f5f5f5] px-3 py-1.5 text-sm text-slate-700 max-w-md">
                <Paperclip className="w-3.5 h-3.5 shrink-0 text-slate-500" /> <span className="truncate flex-1 font-medium text-[#0b57d0]">{k.name}</span> <span className="text-xs text-slate-500 shrink-0">({formatBytes(k.size)})</span>
                <button type="button" onClick={() => setKept((p) => p.filter((x) => x.idx !== k.idx))} className="p-0.5 rounded-full hover:bg-black/10 shrink-0" aria-label={`Remove ${k.name}`}><X className="w-3.5 h-3.5" /></button>
              </span>
            ))}
            {files.map((f, i) => (
              <span key={`f${i}`} className="flex items-center gap-2 rounded bg-[#f5f5f5] px-3 py-1.5 text-sm text-slate-700 max-w-md">
                <Paperclip className="w-3.5 h-3.5 shrink-0 text-slate-500" /> <span className="truncate flex-1 font-medium text-[#0b57d0]">{f.name}</span> <span className="text-xs text-slate-500 shrink-0">({formatBytes(f.size)})</span>
                <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="p-0.5 rounded-full hover:bg-black/10 shrink-0" aria-label={`Remove ${f.name}`}><X className="w-3.5 h-3.5" /></button>
              </span>
            ))}
            {busy === 'files' && <span className="inline-flex items-center gap-1 text-xs text-slate-500 py-1"><Loader2 className="w-3 h-3 animate-spin" /> Adding the attachments…</span>}
          </div>
        )}
      </div>

      {error && <div className="mx-4 mb-2 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700">{error}</div>}
      {linkOpen && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 shadow-sm">
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
            className="flex-1 min-w-0 text-sm px-1 py-0.5 bg-transparent focus:outline-none"
          />
          <button type="button" onClick={applyLink} className="text-xs font-semibold text-[#0b57d0] px-2 py-1 rounded hover:bg-blue-50">OK</button>
          <button type="button" onClick={() => setLinkOpen(false)} className="p-1 rounded-full hover:bg-black/5" aria-label="Cancel"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {formatBar && (
        <div className="mx-3 mb-1 flex items-center gap-0.5 rounded-lg bg-[#f2f6fc] px-1 py-0.5 overflow-x-auto">
          {fmt('undo', Undo2, 'Undo')}
          {fmt('redo', Redo2, 'Redo')}
          <span className="w-px h-5 bg-slate-300 mx-1 shrink-0" />
          {fmt('bold', Bold, 'Bold')}
          {fmt('italic', Italic, 'Italic')}
          {fmt('underline', Underline, 'Underline')}
          <span className="w-px h-5 bg-slate-300 mx-1 shrink-0" />
          {fmt('justifyLeft', AlignLeft, 'Align left')}
          {fmt('insertOrderedList', ListOrdered, 'Numbered list')}
          {fmt('insertUnorderedList', List, 'Bulleted list')}
          {fmt('formatBlock', Quote, 'Quote', 'blockquote')}
          {fmt('removeFormat', RemoveFormatting, 'Remove formatting')}
        </div>
      )}
      {scheduleOpen && (
        <div className="mx-4 mb-2 rounded-lg border border-slate-200 shadow-sm p-3 flex flex-wrap items-center gap-2">
          <Clock className="w-4 h-4 text-slate-500" />
          <span className="text-sm text-slate-700">Schedule send</span>
          <input
            type="datetime-local"
            value={scheduleAt}
            min={localDateTime(new Date(Date.now() + 2 * 60_000))}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="text-sm px-2 py-1 rounded border border-slate-300 focus:outline-none focus:border-[#0b57d0]"
          />
          <button type="button" disabled={!!busy} onClick={() => void send(true)} className="rounded-full px-4 py-1.5 text-sm font-medium text-white bg-[#0b57d0] hover:bg-[#0a4ebb] disabled:opacity-60 inline-flex items-center gap-1.5">
            {busy === 'schedule' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Schedule send
          </button>
          <button type="button" onClick={() => setScheduleOpen(false)} className="text-sm text-slate-600 px-2 py-1 rounded hover:bg-slate-100">Cancel</button>
        </div>
      )}
      <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />

      <div className="flex items-center gap-1 px-3 py-2.5 shrink-0" style={{ paddingBottom: 'max(0.625rem, var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
        <div className="hidden sm:flex items-center rounded-full overflow-hidden shrink-0 mr-2">
          <button type="button" disabled={!!busy || !account} onClick={() => void send(false)} className="pl-6 pr-4 py-2 text-sm font-medium text-white bg-[#0b57d0] hover:bg-[#0a4ebb] hover:shadow disabled:opacity-60 inline-flex items-center gap-2">
            {busy === 'send' && <Loader2 className="w-4 h-4 animate-spin" />} Send
          </button>
          <button type="button" disabled={!!busy} onClick={() => setScheduleOpen((v) => !v)} className="px-2 py-2 text-white bg-[#0b57d0] hover:bg-[#0a4ebb] disabled:opacity-60 border-l border-white/30" aria-label="More send options" title="Schedule send">
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
        <button type="button" className={`${toolBtn} ${formatBar ? 'bg-slate-100' : ''}`} onClick={() => setFormatBar((v) => !v)} aria-label="Formatting options" title="Formatting options" aria-pressed={formatBar}>
          <Type className="w-4 h-4" />
        </button>
        <button type="button" className={toolBtn} onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files"><Paperclip className="w-4 h-4" /></button>
        <button type="button" className={toolBtn} onMouseDown={(e) => e.preventDefault()} onClick={openLink} aria-label="Insert link" title="Insert link"><Link2 className="w-4 h-4" /></button>
        <button type="button" className={`sm:hidden ${toolBtn}`} onClick={() => setScheduleOpen((v) => !v)} aria-label="Schedule send" title="Schedule send"><Clock className="w-4 h-4" /></button>
        {templates.length > 0 && (
          <label className={`${toolBtn} relative flex items-center`} title="Templates">
            <FileText className="w-4 h-4" />
            <SearchSelect value="" onChange={(e) => insertTemplate(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Insert a template">
              <option value="">Template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </SearchSelect>
          </label>
        )}
        {signatures.length > 0 && (
          <label className={`${toolBtn} relative flex items-center`} title={`Signature: ${signatures.find((x) => x.id === sigId)?.name || 'none'}`}>
            <PenLine className="w-4 h-4" />
            <SearchSelect value={sigId} onChange={(e) => changeSignature(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Signature">
              <option value="">No signature</option>
              {signatures.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </SearchSelect>
          </label>
        )}
        <div className="flex-1" />
        <button type="button" disabled={!!busy} onClick={() => void saveDraft(false)} className="sm:hidden text-xs font-medium text-slate-600 px-2 py-1.5 rounded-full hover:bg-slate-100 disabled:opacity-50">
          {busy === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" onClick={() => void discard()} className={`${toolBtn} hover:text-rose-600`} aria-label="Discard draft" title="Discard draft">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </>
  );

  // One element tree for every mode, so the editor (and what's written in
  // it) is never thrown away when the window is minimised or made full size.
  return (
    <>
      {mode === 'max' && <div className="fixed inset-0 z-[89] liquid-glass-backdrop" onClick={() => setMode('normal')} />}
      <div
        ref={winRef}
        // phones: full screen, so start below the status bar (--native-safe-area-inset-top is set
        // by the Android app, where env() reads 0)
        className={`fixed z-[90] bg-white flex flex-col overflow-hidden max-sm:pt-[var(--native-safe-area-inset-top,env(safe-area-inset-top,0px))] ${
          mode === 'max'
            ? 'inset-0 sm:inset-x-8 sm:inset-y-[6vh] sm:mx-auto sm:max-w-5xl sm:rounded-2xl shadow-2xl'
            : `inset-0 sm:inset-auto sm:right-4 sm:bottom-0 sm:rounded-t-xl shadow-[0_8px_30px_rgba(0,0,0,0.25)] ${mode === 'min' ? 'sm:w-72 sm:h-10' : 'sm:w-[560px] sm:h-[min(620px,calc(100vh-5rem))]'}`
        }`}
        style={{ ...(keyboardInset ? { paddingBottom: keyboardInset } : {}), ...(sized ? { width: sized.w, height: sized.h } : {}) }}
      >
        {wide && mode === 'normal' && (
          <>
            <div onPointerDown={startResize('x')} className="absolute left-0 top-3 bottom-0 w-1.5 cursor-ew-resize z-10 hover:bg-blue-500/20" aria-hidden="true" />
            <div onPointerDown={startResize('y')} className="absolute top-0 left-3 right-0 h-1.5 cursor-ns-resize z-10 hover:bg-blue-500/20" aria-hidden="true" />
            <div
              onPointerDown={startResize('xy')}
              onDoubleClick={resetSize}
              title="Drag to resize · double-click for the usual size"
              className="absolute left-0 top-0 w-4 h-4 cursor-nwse-resize z-20 group"
            >
              <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 m-0.5 text-slate-400 group-hover:text-blue-600" aria-hidden="true">
                <path d="M1 9 L9 1 M1 5 L5 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
              </svg>
            </div>
          </>
        )}
        {header}
        <div className={mode === 'min' ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>{body}</div>
      </div>
    </>
  );
};
