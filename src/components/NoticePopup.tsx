import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Lottie } from 'lottie-react';
import { Bell, X } from 'lucide-react';
import { ActiveNotice, User } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { NOTICES_CHANGED_EVENT } from '../lib/noticesLive';
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
  useEffect(() => {
    setEntered(false);
    if (!current) return;
    const t = setTimeout(() => setEntered(true), 20);
    return () => clearTimeout(t);
  }, [current?.id]);
  useBackButtonClose(!!current, () => {
    if (current) handleDismiss(current.id);
  });

  const handleDismiss = async (noticeId: number) => {
    if (dismissing) return;
    setDismissing(true);
    closedIds.current.add(noticeId);
    // Optimistically advance the queue immediately — a failed dismiss call just
    // means this same notice may show again next login, which is harmless.
    setQueue((prev) => prev.slice(1));
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

  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end justify-center">
      {/* Bottom sheet: slides up from the bottom edge. */}
      <div
        role="dialog"
        aria-label={current.title}
        className={`liquid-glass rounded-t-[32px] rounded-b-none max-w-md w-full max-h-[90vh] overflow-y-auto transition-transform duration-300 ease-out ${
          entered ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <button
          type="button"
          onClick={() => handleDismiss(current.id)}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full transition-colors"
          aria-label="Close notice"
        >
          <X className="w-4.5 h-4.5" />
        </button>

        <div className="w-11 h-1 rounded-full bg-slate-300 mx-auto mt-2.5 mb-3" aria-hidden="true" />

        <div className="px-4">
          {lottieSrc && (
            <div className="w-full max-h-[40vh] rounded-[20px] overflow-hidden pointer-events-none" style={{ aspectRatio: lottieAspect }}>
              <Lottie src={lottieSrc} autoplay loop className="w-full h-full" />
            </div>
          )}

          <div className={`px-2 ${lottieSrc ? 'pt-4' : 'pt-3'}`}>
            {!lottieSrc && (
              <div className="liquid-glass-inset w-14 h-14 mb-3 rounded-[20px] text-[color:var(--g-accent,#7F00FF)] flex items-center justify-center">
                <Bell className="w-6 h-6" />
              </div>
            )}
            <h3 className="text-xl font-bold text-slate-900 text-left">{current.title}</h3>

            <div
              className="mt-1.5 text-sm text-slate-700 leading-relaxed text-left [&_a]:text-blue-700 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
              dangerouslySetInnerHTML={{ __html: current.content_html }}
            />
          </div>

          <button
            type="button"
            onClick={() => handleDismiss(current.id)}
            disabled={dismissing}
            className="liquid-glass-button w-full mt-5 py-3 font-semibold rounded-full disabled:opacity-50"
          >
            Got it
          </button>

          {queue.length > 1 && (
            <p className="mt-2.5 text-center text-[11px] text-slate-500">
              {queue.length - 1} more notice{queue.length - 1 === 1 ? '' : 's'} waiting
            </p>
          )}
          <div className="h-5" />
        </div>
      </div>
    </div>
  );
};