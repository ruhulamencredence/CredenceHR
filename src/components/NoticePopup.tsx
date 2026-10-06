import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Lottie } from 'lottie-react';
import { Bell, X } from 'lucide-react';
import { ActiveNotice, User } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
// Loaded only when a tracking notice is shown (it carries the tracking
// animation), so it stays out of the main bundle.
const TrackingNoticeCard = lazy(() => import('./TrackingNoticeCard').then((m) => ({ default: m.TrackingNoticeCard })));

interface NoticePopupProps {
  token: string;
  user: User;
}

// Shows any Notice(s) a Superadmin/Admin has published for THIS user, as a modal
// right after they land on their dashboard post-login. Fetches once per app
// session (not on every navigation) and walks through the queue one at a time —
// dismissing one immediately reveals the next, if there is one, without another
// server round trip.
export const NoticePopup: React.FC<NoticePopupProps> = ({ token, user }) => {
  const [queue, setQueue] = useState<ActiveNotice[]>([]);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/notices/active'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data) && data.length > 0) setQueue(data);
      } catch {
        // Offline or server unreachable — silently skip; not worth blocking the
        // dashboard over, and it'll be checked again next login.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per mount (i.e. once per login), not on every user/token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue[0] || null;
  useBackButtonClose(!!current, () => {
    if (current) handleDismiss(current.id);
  });

  const handleDismiss = async (noticeId: number) => {
    if (dismissing) return;
    setDismissing(true);
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

  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-center justify-center p-4">
      <div role="dialog" aria-label={current.title} className="liquid-glass liquid-glass-in rounded-[32px] max-w-md w-full max-h-[88vh] overflow-y-auto">
        <button
          type="button"
          onClick={() => handleDismiss(current.id)}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full transition-colors"
          aria-label="Close notice"
        >
          <X className="w-4.5 h-4.5" />
        </button>

        <div className="px-6 pt-8 pb-2 flex flex-col items-center text-center">
          {lottieSrc ? (
            <div className="w-32 h-32 mb-3 pointer-events-none">
              <Lottie src={lottieSrc} autoplay loop className="w-full h-full" />
            </div>
          ) : (
            <div className="liquid-glass-inset w-16 h-16 mb-3 rounded-[22px] text-[color:var(--g-accent,#7F00FF)] flex items-center justify-center">
              <Bell className="w-7 h-7" />
            </div>
          )}
          <h3 className="text-lg font-bold text-slate-900">{current.title}</h3>
        </div>

        <div className="px-6 pb-6 pt-2">
          <div
            className="text-sm text-slate-800 leading-relaxed [&_a]:text-blue-700 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
            dangerouslySetInnerHTML={{ __html: current.content_html }}
          />

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
        </div>
      </div>
    </div>
  );
};
