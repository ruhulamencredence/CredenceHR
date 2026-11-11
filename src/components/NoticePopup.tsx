import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { LottieLight } from './LazyLottie';
import { CheckCircle2, X } from 'lucide-react';
import { ActiveNotice, User } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { NOTICES_CHANGED_EVENT } from '../lib/noticesLive';
import { NoticeContent, NoticeCover, CoverChips, PRIORITY_TILE, PRIORITY_STYLE, noticeWhen, readMinutes } from './notice/NoticeParts';
import { NoticeDetail } from './notice/NoticeDetail';
import { Paperclip } from 'lucide-react';
// Loaded only when a tracking notice is shown (it carries the tracking
// animation), so it stays out of the main bundle.
const TrackingNoticeCard = lazy(() => import('./TrackingNoticeCard').then((m) => ({ default: m.TrackingNoticeCard })));

interface NoticePopupProps {
  token: string;
  user: User;
}

// Shows any Notice(s) a Superadmin/Admin has published for THIS user, as a modal
// right after they land on their dashboard post-login, and live while the app
// is open (fetched again on 'notices:changed'). Walks through the queue one at a time —
// dismissing one immediately reveals the next, if there is one, without another
// server round trip.
export const NoticePopup: React.FC<NoticePopupProps> = ({ token, user }) => {
  const [queue, setQueue] = useState<ActiveNotice[]>([]);
  const [dismissing, setDismissing] = useState(false);
  // Drives the slide-up of the bottom sheet each time a notice appears.
  const [entered, setEntered] = useState(false);

  // Notices this session already closed (their dismiss call may still be on
  // its way), so a refresh racing it doesn't bring one back.
  const closedIds = useRef(new Set<number>());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(apiUrl('/api/notices/active'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data)) return;
        const fresh = (data as ActiveNotice[]).filter((n) => !closedIds.current.has(n.id));
        // Keep the one on screen where it is; new ones join the queue.
        setQueue((prev) => {
          const kept = prev.filter((p) => fresh.some((n) => n.id === p.id));
          const added = fresh.filter((n) => !kept.some((p) => p.id === n.id));
          return added.length === 0 && kept.length === prev.length ? prev : [...kept, ...added];
        });
      } catch {
        // Offline or server unreachable — silently skip; checked again on the
        // next refresh (socket reconnect, app back in front) or login.
      }
    };
    void load();
    // Live: a Notice published while the app is open (Socket.IO, see
    // chatSocket.ts), a tapped notice push, or the app coming back to front.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener(NOTICES_CHANGED_EVENT, load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTICES_CHANGED_EVENT, load);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue[0] || null;
  // "Read full": the notice opened in full over the sheet.
  const [full, setFull] = useState(false);
  // For the "1 of 3" dots: how many this session has gone through.
  const [done, setDone] = useState(0);
  useEffect(() => setFull(false), [current?.id]);
  useEffect(() => {
    setEntered(false);
    if (!current) return;
    const t = setTimeout(() => setEntered(true), 20);
    return () => clearTimeout(t);
  }, [current?.id]);
  useBackButtonClose(!!current && !full, () => {
    if (current) (current.require_ack ? remindLater(current.id) : handleDismiss(current.id));
  });

  // Shown = opened (for "Who has read it").
  const seenSent = useRef(new Set<number>());
  useEffect(() => {
    if (!current || seenSent.current.has(current.id) || current.source === 'tracking') return;
    seenSent.current.add(current.id);
    fetch(apiUrl(`/api/notices/${current.id}/seen`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // "I have read this": the notice stops coming back.
  const acknowledge = async (noticeId: number) => {
    if (dismissing) return;
    setDismissing(true);
    closedIds.current.add(noticeId);
    setQueue((prev) => prev.slice(1));
    setDone((d) => d + 1);
    try {
      await fetch(apiUrl(`/api/notices/${noticeId}/ack`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Not recorded: it simply shows again next time.
    } finally {
      setDismissing(false);
    }
  };
  // "Remind me later": gone for now; it comes back next time the app opens.
  const remindLater = (noticeId: number) => {
    closedIds.current.add(noticeId);
    setQueue((prev) => prev.slice(1));
    setDone((d) => d + 1);
  };

  const handleDismiss = async (noticeId: number) => {
    if (dismissing) return;
    setDismissing(true);
    closedIds.current.add(noticeId);
    // Optimistically advance the queue immediately — a failed dismiss call just
    // means this same notice may show again next login, which is harmless.
    setQueue((prev) => prev.slice(1));
    setDone((d) => d + 1);
    try {
      await fetch(apiUrl(`/api/notices/${noticeId}/dismiss`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Ignore — see comment above.
    } finally {
      setDismissing(false);
    }
  };

  if (!current) return null;

  // Employee Tracking "turn on location" notices get their own set-up card.
  if (current.source === 'tracking') {
    return (
      <Suspense fallback={null}>
        <TrackingNoticeCard notice={current} remaining={queue.length - 1} busy={dismissing} onDone={() => handleDismiss(current.id)} />
      </Suspense>
    );
  }

  const total = done + queue.length;
  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end justify-center">
      {/* Bottom sheet: slides up from the bottom edge. */}
      <div className="w-full max-w-md px-2.5" style={{ paddingBottom: 'max(0.75rem, var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
        <NoticeSheet
          notice={current}
          token={token}
          done={done}
          total={total}
          busy={dismissing}
          className={`transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : 'translate-y-[110%]'}`}
          onAck={() => acknowledge(current.id)}
          onRemind={() => remindLater(current.id)}
          onDismiss={() => handleDismiss(current.id)}
          onReadFull={() => setFull(true)}
        />
      </div>

      {full && (
        <NoticeDetail
          notice={current}
          token={token}
          busy={dismissing}
          onClose={() => setFull(false)}
          onAcknowledge={() => acknowledge(current.id)}
          onDone={() => handleDismiss(current.id)}
        />
      )}
    </div>
  );
};

// The sheet itself (also the composer's phone preview, so both look the same).
export const NoticeSheet: React.FC<{
  notice: ActiveNotice;
  token: string;
  // Position in the queue, for the "1 of 3" dots.
  done: number;
  total: number;
  busy?: boolean;
  coverLocalUrl?: string | null;
  className?: string;
  onAck: () => void | Promise<void>;
  onRemind: () => void;
  onDismiss: () => void;
  onReadFull: () => void;
}> = ({ notice: current, token, done, total, busy, coverLocalUrl, className = '', onAck, onRemind, onDismiss, onReadFull }) => {
  // Whether the text is cut off in the sheet (then "Read full" shows).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return setClipped(false);
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 4);
    check();
    const t = setTimeout(check, 400);
    return () => clearTimeout(t);
  }, [current.id, current.content_html]);
  const lottieSrc: any = current.lottie_json
    ? (() => {
        try {
          return JSON.parse(current.lottie_json as string);
        } catch {
          return null;
        }
      })()
    : current.lottie_url || null;

  // The animation sits in a rounded banner across the sheet, so give its box
  // the animation's own proportions (w / h in the Lottie JSON) — no cropping and
  // no empty bands. A URL-only animation can't be measured up front, so it falls
  // back to 4/3.
  const lottieAspect =
    lottieSrc && typeof lottieSrc === 'object' && lottieSrc.w > 0 && lottieSrc.h > 0
      ? `${lottieSrc.w} / ${lottieSrc.h}`
      : '4 / 3';

  const priority = current.priority || 'important';
  const tile = PRIORITY_TILE[priority];
  const hasCover = (!!current.cover || !!coverLocalUrl) && !lottieSrc;
  const files = current.attachments || [];
  const close = () => (current.require_ack ? onRemind() : onDismiss());
  // Centred like a message when there's no picture; left-aligned under one.
  const centred = !lottieSrc && !hasCover;
  const showFull = clipped || files.length > 0;

  return (
    <div
      role="dialog"
      aria-label={current.title}
      className={`liquid-glass rounded-[34px] max-h-[88vh] overflow-y-auto ${className}`}
    >
      <div className="w-11 h-1 rounded-full bg-slate-300 mx-auto mt-2.5" aria-hidden="true" />
      <button
        type="button"
        onClick={close}
        className={`absolute z-10 w-9 h-9 rounded-full flex items-center justify-center ${
          hasCover || lottieSrc ? 'top-6 right-6 bg-white/25 border border-white/60 backdrop-blur-md text-white' : 'liquid-glass-chip top-3.5 right-3.5 text-slate-600'
        }`}
        aria-label="Close notice"
      >
        <X className="w-4.5 h-4.5" />
      </button>

      {lottieSrc && (
        <div className="mx-3 mt-3 max-h-[36vh] rounded-[24px] overflow-hidden pointer-events-none" style={{ aspectRatio: lottieAspect }}>
          {/* The light player: it never runs a Lottie file's expressions (JavaScript). */}
          <LottieLight src={lottieSrc} autoplay loop className="w-full h-full" />
        </div>
      )}
      {hasCover && (
        <div className="relative mx-3 mt-3 rounded-[24px] overflow-hidden">
          <NoticeCover file={current.cover} localUrl={coverLocalUrl} token={token} className="h-[190px] max-h-[30vh]" />
          <span className="absolute left-3 bottom-3">
            <CoverChips priority={priority} pinned={current.pinned} />
          </span>
        </div>
      )}

      <div className={centred ? 'px-6 text-center' : 'px-5'}>
        {centred && (
          <div
            className={`w-[74px] h-[74px] rounded-[26px] mx-auto mt-6 flex items-center justify-center text-white bg-gradient-to-br ${tile.cls} ${
              priority === 'urgent' ? 'ring-[10px] ring-rose-100 outline outline-[10px] outline-rose-50' : 'ring-[10px] ring-violet-100 outline outline-[10px] outline-violet-50'
            }`}
          >
            <tile.Icon className="w-8 h-8" />
          </div>
        )}
        {centred && (
          <div className="mt-6">
            <span className={`inline-block text-[10.5px] font-extrabold tracking-wider px-2.5 py-1 rounded-full ${priority === 'urgent' ? 'bg-rose-100 text-rose-600' : 'bg-violet-100 text-violet-700'}`}>
              {PRIORITY_STYLE[priority].label.toUpperCase()}
              {current.from_name ? ` · FROM ${current.from_name.toUpperCase()}` : ''}
            </span>
          </div>
        )}
        <h3 className={`text-[21px] font-extrabold tracking-tight text-slate-900 leading-snug ${centred ? 'mt-2.5' : 'mt-3.5 pr-2'}`}>{current.title}</h3>
        {!centred && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-slate-500 mt-1">
            {current.from_name || 'HR'}
            <span className="w-[3px] h-[3px] rounded-full bg-slate-300" />
            {noticeWhen(current.created_at)}
            <span className="w-[3px] h-[3px] rounded-full bg-slate-300" />
            {readMinutes(current.content_html)} min read
          </p>
        )}
        <div
          ref={bodyRef}
          className={`relative overflow-hidden ${centred ? 'max-h-[11.5rem]' : 'max-h-[6.2rem]'}`}
          style={clipped ? { WebkitMaskImage: 'linear-gradient(180deg, #000 60%, transparent)', maskImage: 'linear-gradient(180deg, #000 60%, transparent)' } : undefined}
        >
          <NoticeContent html={current.content_html} token={token} className={`mt-2 text-[14.5px] text-slate-600 ${centred ? 'text-center' : 'text-left'}`} />
        </div>
        {files.length > 0 && (
          <div className={`flex mt-3 ${centred ? 'justify-center' : ''}`}>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-800 bg-violet-50 rounded-[10px] px-2.5 py-1.5">
              <Paperclip className="w-3.5 h-3.5" /> {files.length} file{files.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
        {total > 1 && (
          <div className="mt-3.5">
            <div className="flex gap-1.5 justify-center" aria-hidden="true">
              {Array.from({ length: Math.min(total, 8) }).map((_, i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === Math.min(done, 7) ? 'w-[18px] bg-[color:var(--g-accent,#7F00FF)]' : 'w-1.5 bg-slate-400/60'}`} />
              ))}
            </div>
            <p className="text-center text-[11px] text-slate-500 mt-1">
              {done + 1} of {total} notices
            </p>
          </div>
        )}
      </div>

      <div className="px-4 pt-4 pb-4">
        {current.require_ack ? (
          <>
            <button
              type="button"
              onClick={() => void onAck()}
              disabled={busy}
              className="liquid-glass-button w-full py-3.5 font-semibold rounded-full inline-flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <CheckCircle2 className="w-4.5 h-4.5" /> I have read this
            </button>
            <div className="flex justify-center gap-5 mt-1.5">
              {showFull && (
                <button type="button" onClick={() => onReadFull()} className="py-2 text-sm font-semibold text-[color:var(--g-accent,#7F00FF)]">
                  Read full
                </button>
              )}
              <button type="button" onClick={() => onRemind()} className="py-2 text-sm font-semibold text-slate-500">
                Remind me later
              </button>
            </div>
          </>
        ) : (
          <div className="flex gap-2.5">
            {showFull && (
              <button type="button" onClick={() => onReadFull()} className="liquid-glass-inset flex-1 py-3.5 rounded-full text-[14.5px] font-semibold text-violet-800">
                Read full
              </button>
            )}
            <button type="button" onClick={() => onDismiss()} disabled={busy} className="liquid-glass-button flex-1 py-3.5 font-semibold rounded-full disabled:opacity-50">
              Got it
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
