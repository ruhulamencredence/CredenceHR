/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> one conversation: every mail of the thread, oldest first,
// the last one open. Reply / Reply all / Forward, star, unread, move, delete.

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Reply, ReplyAll, Forward, Star, Trash2, MailOpen, Mail, ShieldAlert, Inbox, Archive, Paperclip, Download, Loader2, Clock, ChevronDown, ChevronUp, AlertCircle,
  MoreVertical, ListChecks, CalendarPlus, UserPlus, Filter, Ban, FolderInput } from 'lucide-react';
import { MailBody } from './MailBody';
import { AttachmentViewer } from '../AttachmentViewer';
import { MailAttachment, MailMessage, SYSTEM_LABELS, fetchAttachment, formatBytes, fullMailDate, mailPhotoUrl, saveBlob, shortMailDate } from '../../lib/mailApi';

export type ReaderAction =
  | 'reply' | 'replyAll' | 'forward' | 'star' | 'unread' | 'trash' | 'spam' | 'notSpam' | 'archive' | 'inbox' | 'unschedule'
  | 'task' | 'event' | 'contact' | 'rule' | 'block' | 'folder';

const initials = (s: string) =>
  (s || '?')
    .replace(/[^A-Za-zঀ-৿ ]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';
const AVATAR_COLORS = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500', 'bg-teal-500', 'bg-fuchsia-500'];
export const avatarColor = (s: string) => AVATAR_COLORS[[...(s || '')].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

// The person's Employee profile photo when they have one (mailPhotoUrl),
// otherwise their initials on a colour.
export const MailAvatar: React.FC<{ name: string; email: string; size?: 'sm' | 'md' }> = ({ name, email, size = 'md' }) => {
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPhoto(null);
    void mailPhotoUrl(email).then((u) => live && setPhoto(u));
    return () => {
      live = false;
    };
  }, [email]);
  const box = size === 'sm' ? 'w-8 h-8 text-[11px]' : 'w-10 h-10 text-xs';
  if (photo) return <img src={photo} alt={name || email} className={`${box} rounded-full object-cover shrink-0 bg-slate-100`} onError={() => setPhoto(null)} />;
  return (
    <span className={`${box} rounded-full ${avatarColor(email || name)} text-white font-semibold flex items-center justify-center shrink-0`}>
      {initials(name || email)}
    </span>
  );
};

// An image or PDF opens right here (AttachmentViewer — a new tab or the Share
// sheet was the only way before, which is no way to just look at it); the
// small ⬇ saves it as before. Anything else is downloaded on tap.
const viewable = (a: MailAttachment) =>
  /^image\//i.test(a.type) || /pdf/i.test(a.type) || /\.(jpe?g|png|gif|webp|bmp|heic|heif|pdf)$/i.test(a.name);

const AttachmentChip: React.FC<{ token: string; messageId: string; a: MailAttachment; onView?: () => void }> = ({ token, messageId, a, onView }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await saveBlob(await fetchAttachment(token, messageId, a.idx), a.name);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`inline-flex items-stretch rounded-xl border max-w-full overflow-hidden ${err ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
      <button
        type="button"
        onClick={() => (onView ? onView() : void save())}
        title={err || (onView ? `Open ${a.name}` : `Download ${a.name}`)}
        data-testid="mail-attachment"
        className="inline-flex items-center gap-2 px-3 py-2 text-left min-w-0 hover:bg-slate-50"
      >
        <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-slate-800 truncate max-w-[12rem]">{a.name}</span>
          <span className="block text-[10px] text-slate-500">{err || formatBytes(a.size)}</span>
        </span>
        {!onView && (busy ? <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" /> : <Download className="w-3.5 h-3.5 text-slate-400 shrink-0" />)}
      </button>
      {onView && (
        <button
          type="button"
          onClick={() => void save()}
          aria-label={`Download ${a.name}`}
          title={`Download ${a.name}`}
          className="px-2.5 border-l border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50 flex items-center"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        </button>
      )}
    </span>
  );
};

// One mail's attachments; its images / PDFs open in one viewer with ‹ ›.
const MailAttachments: React.FC<{ token: string; messageId: string; list: MailAttachment[] }> = ({ token, messageId, list }) => {
  const shown = list.filter(viewable);
  const [open, setOpen] = useState<number | null>(null); // index in `shown`
  const cur = open != null ? shown[open] : null;
  // Each file is fetched once (the server reads it from the mail server, a
  // few seconds), and the ones either side load while one is being looked at.
  const blobs = useRef(new Map<number, Promise<Blob>>());
  const blobOf = (idx: number) => {
    let p = blobs.current.get(idx);
    if (!p) {
      p = fetchAttachment(token, messageId, idx);
      p.catch(() => blobs.current.delete(idx));
      blobs.current.set(idx, p);
    }
    return p;
  };
  useEffect(() => {
    if (open == null) return;
    for (const k of [open + 1, open - 1]) if (shown[k]) void blobOf(shown[k].idx).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {list.map((a) => (
        <AttachmentChip key={a.idx} token={token} messageId={messageId} a={a} onView={viewable(a) ? () => setOpen(shown.indexOf(a)) : undefined} />
      ))}
      {cur && (
        <AttachmentViewer
          key={cur.idx}
          token={token}
          src=""
          name={cur.name}
          type={cur.type}
          load={() => blobOf(cur.idx)}
          nav={{ index: open!, count: shown.length, onPrev: () => setOpen((i) => Math.max(0, (i ?? 0) - 1)), onNext: () => setOpen((i) => Math.min(shown.length - 1, (i ?? 0) + 1)) }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
};

const OneMail: React.FC<{
  token: string;
  m: MailMessage;
  open: boolean;
  onToggle: () => void;
  isLast: boolean;
  showPictures?: boolean;
  onTrustSender?: (email: string) => void;
}> = ({ token, m, open, onToggle, isLast, showPictures, onTrustSender }) => {
  const [details, setDetails] = useState(false);
  return (
    <div className={`rounded-2xl bg-white border border-slate-200/80 ${open ? '' : 'hover:bg-slate-50'}`}>
      <button type="button" onClick={onToggle} disabled={isLast && open} className="w-full flex items-start gap-3 p-3 sm:p-4 text-left disabled:cursor-default">
        <MailAvatar name={m.from.name} email={m.from.email} />
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900 truncate">{m.from.name}</span>
            <span className="text-[11px] text-slate-500 shrink-0">{open ? fullMailDate(m.date) : shortMailDate(m.date)}</span>
          </span>
          {open ? (
            <span className="block text-xs text-slate-500 truncate">
              {m.from.email} · to {m.to.join(', ') || '—'}
            </span>
          ) : (
            <span className="block text-xs text-slate-500 truncate">{m.snippet}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 sm:px-4 pb-4">
          <div className="flex items-center gap-2 mb-2">
            <button type="button" onClick={() => setDetails((v) => !v)} className="text-[11px] text-slate-500 hover:text-slate-800 inline-flex items-center gap-0.5">
              Details {details ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {m.internal && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" title="Delivered inside CredenceHR — it didn't go through the mail server">
                Internal
              </span>
            )}
          </div>
          {details && (
            <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600 space-y-0.5">
              <div><span className="text-slate-400">From:</span> {m.from.name} &lt;{m.from.email}&gt;</div>
              <div><span className="text-slate-400">To:</span> {m.to.join(', ') || '—'}</div>
              {m.cc.length > 0 && <div><span className="text-slate-400">Cc:</span> {m.cc.join(', ')}</div>}
              {m.bcc.length > 0 && <div><span className="text-slate-400">Bcc:</span> {m.bcc.join(', ')}</div>}
              <div><span className="text-slate-400">Date:</span> {fullMailDate(m.date)}</div>
              {m.internal && <div><span className="text-slate-400">Delivery:</span> inside CredenceHR (not through the mail server)</div>}
            </div>
          )}
          {m.sendError && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-rose-50 text-rose-700 text-xs px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {m.sendError}
            </div>
          )}
          <MailBody html={m.body || ''} autoShowImages={showPictures} sender={m.from.email} onAlwaysShow={onTrustSender && m.from.email ? () => onTrustSender(m.from.email) : undefined} />
          {m.attachments.length > 0 && <MailAttachments token={token} messageId={m.id} list={m.attachments} />}
        </div>
      )}
    </div>
  );
};

export const ReaderSkeleton: React.FC = () => (
  <div className="p-4 sm:p-6 space-y-4" style={{ animation: 'skeleton-in .2s ease both' }}>
    <div className="h-5 w-2/3 rounded bg-slate-200/80" />
    <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-slate-200/80" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-40 rounded bg-slate-200/80" />
          <div className="h-2.5 w-56 rounded bg-slate-100" />
        </div>
      </div>
      {[90, 100, 80, 95, 60].map((w, i) => (
        <div key={i} className="h-3 rounded bg-slate-100" style={{ width: `${w}%` }} />
      ))}
    </div>
  </div>
);

export const MailReader: React.FC<{
  token: string;
  thread: MailMessage[] | null;
  folder: string;
  error: string;
  // Someone else's mailbox opened from Mail Administration: no actions.
  readOnly?: boolean;
  onBack?: () => void;
  onAction: (action: ReaderAction, m: MailMessage) => void;
  // Pictures that show without asking (own mail, our domains, trusted senders).
  picturesOk?: (m: MailMessage) => boolean;
  onTrustSender?: (email: string) => void;
  // My folders on: "Move to folder" in the toolbar.
  canFolders?: boolean;
}> = ({ token, thread, folder, error, readOnly, onBack, onAction, picturesOk, onTrustSender, canFolders }) => {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  const last = thread && thread.length ? thread[thread.length - 1] : null;
  useEffect(() => {
    // The latest mail, and any unread one, start open.
    setOpenIds(new Set((thread || []).filter((m, i, all) => i === all.length - 1 || !m.isRead).map((m) => m.id)));
  }, [thread]);

  if (error) return <div className="p-6 text-sm text-rose-600">{error}</div>;
  if (!thread) return <ReaderSkeleton />;
  if (!last) return <div className="p-6 text-sm text-slate-500">This mail is no longer here.</div>;

  const head = thread[0];
  const ownLabels = [...new Set(thread.flatMap((m) => m.labels))].filter((l) => !SYSTEM_LABELS.has(l) && !/^Folder:\d+$/.test(l));
  const inSpam = last.labels.includes('Spam');
  const inTrash = last.labels.includes('Trash');
  const scheduled = last.labels.includes('Scheduled');
  const actions = !readOnly;
  const btn = 'p-2 rounded-full text-slate-600 hover:bg-black/5 hover:text-slate-900';

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-1 px-2 sm:px-4 py-2 border-b border-slate-200/70 bg-white/60 backdrop-blur-sm sticky top-0 z-10">
        {onBack && (
          <button type="button" onClick={onBack} className={btn} aria-label="Back to the list">
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="flex-1" />
        {actions && !scheduled && (
          <>
            {inSpam ? (
              <button type="button" className={btn} onClick={() => onAction('notSpam', last)} title="Not spam"><Inbox className="w-4 h-4" /></button>
            ) : inTrash ? (
              <button type="button" className={btn} onClick={() => onAction('inbox', last)} title="Move to Inbox"><Inbox className="w-4 h-4" /></button>
            ) : (
              <>
                {folder !== 'Archive' && folder !== 'Sent' && <button type="button" className={btn} onClick={() => onAction('archive', last)} title="Archive"><Archive className="w-4 h-4" /></button>}
                {folder !== 'Sent' && <button type="button" className={btn} onClick={() => onAction('spam', last)} title="Report spam"><ShieldAlert className="w-4 h-4" /></button>}
              </>
            )}
            {canFolders && folder !== 'Drafts' && (
              <button type="button" className={btn} onClick={() => onAction('folder', last)} title="Move to folder" aria-label="Move to folder"><FolderInput className="w-4 h-4" /></button>
            )}
            <button type="button" className={btn} onClick={() => onAction('unread', last)} title={last.isRead ? 'Mark as unread' : 'Mark as read'}>
              {last.isRead ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
            </button>
            <button type="button" className={btn} onClick={() => onAction('star', last)} title={last.isStarred ? 'Unstar' : 'Star'}>
              <Star className={`w-4 h-4 ${last.isStarred ? 'fill-amber-400 text-amber-400' : ''}`} />
            </button>
          </>
        )}
        {actions && <button type="button" className={`${btn} hover:text-rose-600`} onClick={() => onAction('trash', last)} title={inTrash || scheduled ? 'Delete for good' : 'Delete'}>
          <Trash2 className="w-4 h-4" />
        </button>}
        {actions && !scheduled && (
          <div className="relative">
            <button type="button" className={btn} onClick={() => setMore((v) => !v)} aria-label="More" aria-expanded={more} title="More">
              <MoreVertical className="w-4 h-4" />
            </button>
            {more && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMore(false)} />
                <div className="absolute right-0 top-full mt-1 z-30 w-56 rounded-2xl bg-white shadow-xl ring-1 ring-black/5 py-1.5">
                  {(
                    [
                      ['task', 'Add as a task', ListChecks],
                      ['event', 'Add to calendar', CalendarPlus],
                      ['contact', `Add ${head.from.name.split(' ')[0] || 'sender'} to contacts`, UserPlus],
                      ['rule', 'Rule for mail like this', Filter],
                      ['block', `Block ${last.from.email}`, Ban]
                    ] as [ReaderAction, string, React.ComponentType<{ className?: string }>][]
                  ).map(([a, label, Icon]) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => {
                        setMore(false);
                        onAction(a, a === 'contact' || a === 'block' || a === 'rule' ? last : head);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-slate-50 ${a === 'block' ? 'text-rose-600' : 'text-slate-700'}`}
                    >
                      <Icon className="w-4 h-4 shrink-0" /> <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 break-words">{head.subject}</h2>
        {ownLabels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ownLabels.map((l) => (
              <span key={l} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{l}</span>
            ))}
          </div>
        )}
        {scheduled && actions && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-sky-50 text-sky-800 text-xs px-3 py-2.5">
            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> Will be sent {fullMailDate(last.scheduledSendTime)}.</span>
            <button type="button" onClick={() => onAction('unschedule', last)} className="font-semibold underline underline-offset-2">Cancel sending</button>
          </div>
        )}
        <div className="mt-4 space-y-3">
          {thread.map((m) => (
            <OneMail
              key={m.id}
              token={token}
              m={m}
              isLast={m.id === last.id}
              open={openIds.has(m.id)}
              showPictures={picturesOk ? picturesOk(m) : false}
              onTrustSender={readOnly ? undefined : onTrustSender}
              onToggle={() =>
                setOpenIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(m.id)) next.delete(m.id);
                  else next.add(m.id);
                  return next;
                })
              }
            />
          ))}
        </div>
        {actions && !scheduled && !inTrash && (
          <div className="mt-4 flex flex-wrap gap-2 pb-24 md:pb-6">
            <button type="button" onClick={() => onAction('reply', last)} className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Reply className="w-4 h-4" /> Reply
            </button>
            {(last.to.length + last.cc.length > 1) && (
              <button type="button" onClick={() => onAction('replyAll', last)} className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <ReplyAll className="w-4 h-4" /> Reply all
              </button>
            )}
            <button type="button" onClick={() => onAction('forward', last)} className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Forward className="w-4 h-4" /> Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
