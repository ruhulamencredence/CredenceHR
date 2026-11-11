/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One notice, opened in full (from the Notice Board, or "Read full" in the
// login popup): the cover across the top with the title on it, who posted
// it and when, the text, the attachments as cards, and the main action
// ("I have read this" when the notice asks for it, otherwise "Got it")
// pinned to the bottom. Liquid-glass sheet (house style).

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ChevronLeft, Download } from 'lucide-react';
import type { ActiveNotice, NoticeFile } from '../../types';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { downloadNoticeFile, fileSize } from '../../lib/noticeFilesClient';
import { CoverChips, NoticeBadges, NoticeContent, NoticeCover, PRIORITY_TILE, noticeWhenFull, readMinutes } from './NoticeParts';

const initials = (name?: string | null) =>
  String(name || 'HR')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'HR';

const extOf = (f: NoticeFile) => (f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();

export const AttachmentCards: React.FC<{ files: NoticeFile[]; token: string }> = ({ files, token }) => {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!files.length) return null;
  return (
    <div className="space-y-2">
      {files.map((f) => {
        const pdf = /pdf/i.test(f.mimetype);
        return (
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
            className="liquid-glass-inset w-full flex items-center gap-3 rounded-[18px] p-2.5 text-left"
          >
            <span
              className={`w-10 h-11 rounded-[10px] shrink-0 flex items-end justify-center pb-1.5 text-[9.5px] font-extrabold text-white bg-gradient-to-br ${
                pdf ? 'from-rose-400 to-rose-600' : /sheet|excel|csv/i.test(f.mimetype) ? 'from-emerald-400 to-emerald-600' : /word|document/i.test(f.mimetype) ? 'from-sky-400 to-blue-600' : 'from-violet-400 to-violet-600'
              }`}
            >
              {extOf(f)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-slate-800 truncate">{f.name}</span>
              <span className="block text-[11px] text-slate-500">{fileSize(f.size)} · tap to open</span>
            </span>
            <span className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-[color:var(--g-accent,#7F00FF)] shrink-0">
              <Download className={`w-4 h-4 ${busy === f.id ? 'animate-bounce' : ''}`} />
            </span>
          </button>
        );
      })}
      {err && <p className="text-[11px] text-rose-600">{err}</p>}
    </div>
  );
};

// The notice itself — cover with the title on it, who posted it, the text,
// the attachments. Shared by the full view and the composer's preview.
export const NoticeArticle: React.FC<{ notice: ActiveNotice; token: string; coverLocalUrl?: string | null }> = ({ notice: n, token, coverLocalUrl }) => {
  const priority = n.priority || 'important';
  const tile = PRIORITY_TILE[priority];
  const minutes = readMinutes(n.content_html);
  const hero = !!n.cover || !!coverLocalUrl;
  return (
    <>
            {hero ? (
              <div className="relative">
                <NoticeCover file={n.cover} localUrl={coverLocalUrl} token={token} className="h-[300px] md:h-[240px]" />
                <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-indigo-950/80 pointer-events-none" />
                <div className="absolute left-5 right-5 bottom-10 text-white">
                  <CoverChips priority={priority} pinned={n.pinned} />
                  <h2 className="text-2xl font-extrabold leading-tight tracking-tight mt-2 drop-shadow">{n.title}</h2>
                </div>
              </div>
            ) : (
              <div className="px-5 pt-16 pb-2">
                <span className={`w-14 h-14 rounded-[20px] flex items-center justify-center text-white bg-gradient-to-br ${tile.cls}`}>
                  <tile.Icon className="w-6 h-6" />
                </span>
                <div className="mt-4">
                  <NoticeBadges priority={priority} pinned={n.pinned} />
                </div>
                <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-slate-900 mt-2">{n.title}</h2>
              </div>
            )}
            <div className={`relative px-5 pb-6 ${hero ? '-mt-6 pt-5 rounded-t-[28px] bg-[#fbfaff]' : 'pt-3'}`}>
              <div className="flex items-center gap-3 pb-3.5 border-b border-slate-200/70">
                <span className="w-10 h-10 rounded-[13px] shrink-0 flex items-center justify-center text-white text-sm font-extrabold bg-gradient-to-br from-violet-400 to-violet-700">{initials(n.from_name)}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-slate-800 truncate">{n.from_name || 'HR'}</span>
                  <span className="block text-[11.5px] text-slate-500">
                    {noticeWhenFull(n.created_at)} · {minutes} min read
                  </span>
                </span>
              </div>
              <NoticeContent html={n.content_html} token={token} className="notice-content-reading mt-4 text-[15px] leading-relaxed text-slate-700" />
              {(n.attachments || []).length > 0 && (
                <>
                  <p className="text-[11px] font-extrabold tracking-[0.09em] text-slate-400 mt-5 mb-2">ATTACHMENT{(n.attachments || []).length > 1 ? 'S' : ''}</p>
                  <AttachmentCards files={n.attachments || []} token={token} />
                </>
              )}
              {n.require_ack && n.acknowledged_at && (
                <p className="mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> You have read this
                </p>
              )}
            </div>
              </>
  );
};

export const NoticeDetail: React.FC<{
  notice: ActiveNotice;
  token: string;
  onClose: () => void;
  // The bottom button: acknowledge when the notice asks for it.
  onAcknowledge?: () => void | Promise<void>;
  busy?: boolean;
  // Label of the bottom button when no acknowledgement is needed.
  doneLabel?: string;
  onDone?: () => void;
}> = ({ notice: n, token, onClose, onAcknowledge, busy, doneLabel = 'Got it', onDone }) => {
  useBackButtonClose(true, onClose);
  const needsAck = !!n.require_ack && !n.acknowledged_at;
  const hero = !!n.cover;
  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[95] flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="w-full md:max-w-lg h-full md:h-auto md:max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div role="dialog" aria-label={n.title} className="liquid-glass liquid-glass-in rounded-none md:rounded-[32px] h-full md:max-h-[90vh] flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto overscroll-contain bg-[#fbfaff]/90">
            <NoticeArticle notice={n} token={token} />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className={`absolute top-3.5 left-3.5 w-10 h-10 rounded-full flex items-center justify-center z-10 ${hero ? 'bg-white/25 border border-white/60 backdrop-blur-md text-white' : 'liquid-glass-chip text-slate-600'}`}
            style={{ marginTop: 'env(safe-area-inset-top)' }}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="px-4 pt-3 pb-4 shrink-0 bg-[#fbfaff]/90 border-t border-violet-100/70" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            {needsAck && onAcknowledge ? (
              <button type="button" disabled={busy} onClick={() => void onAcknowledge()} className="liquid-glass-button w-full rounded-full py-3.5 font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
                <CheckCircle2 className="w-4.5 h-4.5" /> I have read this
              </button>
            ) : (
              <button type="button" onClick={onDone || onClose} className="liquid-glass-button w-full rounded-full py-3.5 font-semibold">
                {doneLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
