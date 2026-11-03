/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The pieces every notice is drawn with — the login popup, the Notice Board,
// and the composer's preview: the formatted text (with its pictures fetched
// behind the sign-in), the cover picture, the attachments.

import React, { useEffect, useRef, useState } from 'react';
import { FileText, Download, Pin, AlertTriangle, Megaphone } from 'lucide-react';
import { sanitizeNoticeHtml, withLineBreaks, deferNoticeImages } from '../../lib/noticeHtml';
import { noticeFileObjectUrl, downloadNoticeFile, fileSize } from '../../lib/noticeFilesClient';
import type { NoticeFile, NoticePriority } from '../../types';

export const NOTICE_CONTENT_CLASS = 'notice-content';

export const NoticeContent: React.FC<{ html: string; token: string; className?: string }> = ({ html, token, className = '' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const clean = deferNoticeImages(withLineBreaks(sanitizeNoticeHtml(html)));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLImageElement>('img[data-nsrc]').forEach((img) => {
      const u = img.getAttribute('data-nsrc')!;
      noticeFileObjectUrl(token, u)
        .then((src) => {
          img.src = src;
        })
        .catch(() => {
          img.alt = img.alt || 'Picture unavailable';
        });
    });
  }, [clean, token]);
  return <div ref={ref} className={`${NOTICE_CONTENT_CLASS} ${className}`} dangerouslySetInnerHTML={{ __html: clean }} />;
};

export const NoticeCover: React.FC<{ file: NoticeFile | null | undefined; token: string; className?: string; localUrl?: string | null }> = ({
  file,
  token,
  className = '',
  localUrl
}) => {
  const [src, setSrc] = useState<string | null>(localUrl || null);
  useEffect(() => {
    if (localUrl) return setSrc(localUrl);
    if (!file) return setSrc(null);
    let alive = true;
    noticeFileObjectUrl(token, file.url)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [file?.url, token, localUrl]);
  if (!file && !localUrl) return null;
  return src ? <img src={src} alt="" className={`w-full object-cover ${className}`} /> : <div className={`w-full bg-gradient-to-br from-violet-200 to-pink-200 ${className}`} />;
};

export const NoticeAttachments: React.FC<{ files: NoticeFile[]; token: string; compact?: boolean }> = ({ files, token, compact }) => {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!files.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={async () => {
            setBusy(f.id);
            setErr(null);
            try {
              await downloadNoticeFile(token, f);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(null);
            }
          }}
          className={`w-full flex items-center gap-2.5 rounded-xl bg-slate-100/80 hover:bg-slate-200/70 text-left ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
        >
          <FileText className="w-4 h-4 text-violet-600 shrink-0" />
          <span className="text-xs font-semibold text-slate-800 truncate flex-1">{f.name}</span>
          <span className="text-[10.5px] text-slate-500 shrink-0">{fileSize(f.size)}</span>
          <Download className={`w-3.5 h-3.5 text-slate-500 shrink-0 ${busy === f.id ? 'animate-bounce' : ''}`} />
        </button>
      ))}
      {err && <p className="text-[11px] text-rose-600">{err}</p>}
    </div>
  );
};

export const PRIORITY_STYLE: Record<NoticePriority, { label: string; cls: string }> = {
  normal: { label: 'Notice', cls: 'bg-slate-100 text-slate-700' },
  important: { label: 'Important', cls: 'bg-violet-100 text-violet-700' },
  urgent: { label: 'Urgent', cls: 'bg-rose-600 text-white' }
};

export const NoticeBadges: React.FC<{ priority?: NoticePriority; pinned?: boolean }> = ({ priority = 'important', pinned }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${PRIORITY_STYLE[priority].cls}`}>
      {priority === 'urgent' ? <AlertTriangle className="w-3 h-3" /> : <Megaphone className="w-3 h-3" />}
      {PRIORITY_STYLE[priority].label}
    </span>
    {pinned && (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
        <Pin className="w-3 h-3" /> Pinned
      </span>
    )}
  </span>
);

// One notice as people read it — used by the popup, the Notice Board and the
// composer's preview, so all three look the same.
export const NoticeView: React.FC<{
  token: string;
  title: string;
  html: string;
  priority?: NoticePriority;
  pinned?: boolean;
  cover?: NoticeFile | null;
  coverLocalUrl?: string | null;
  attachments?: NoticeFile[];
  meta?: string | null;
  coverClass?: string;
}> = ({ token, title, html, priority, pinned, cover, coverLocalUrl, attachments = [], meta, coverClass = 'h-36' }) => (
  <div>
    {(cover || coverLocalUrl) && <NoticeCover file={cover} localUrl={coverLocalUrl} token={token} className={`${coverClass} rounded-2xl mb-3`} />}
    <div className="mb-1.5">
      <NoticeBadges priority={priority} pinned={pinned} />
    </div>
    <h3 className="text-base font-bold text-slate-900 leading-snug">{title || 'Untitled notice'}</h3>
    {meta && <p className="text-[11px] text-slate-500 mt-0.5">{meta}</p>}
    <NoticeContent html={html} token={token} className="mt-2" />
    <NoticeAttachments files={attachments} token={token} />
  </div>
);
