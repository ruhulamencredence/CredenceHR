/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Turn on desktop notifications" card (website only, see src/lib/webPush.ts).
// Shown after sign-in while this browser hasn't been asked yet; "Not now"
// hides it for a week. Browsers need a click before they show their own
// permission prompt, hence the card.

import React, { useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { enableWebPush, webPushPermission } from '../lib/webPush';

const SNOOZE_DAYS = 7;
const snoozeKey = (userId: number) => `credence_webpush_snooze_${userId}`;

export const WebPushPrompt: React.FC<{ token: string; userId: number }> = ({ token, userId }) => {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (webPushPermission() !== 'default') return;
    let snoozedUntil = 0;
    try {
      snoozedUntil = Number(localStorage.getItem(snoozeKey(userId)) || 0);
    } catch {}
    if (Date.now() < snoozedUntil) return;
    // Let the page settle first.
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [userId]);

  if (!show) return null;

  const later = () => {
    try {
      localStorage.setItem(snoozeKey(userId), String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000));
    } catch {}
    setShow(false);
  };
  const turnOn = async () => {
    setBusy(true);
    setNote('Turning on…');
    const r = await enableWebPush(token, () =>
      setNote('Waiting for your browser — click "Allow". No box? Click the bell or lock icon at the right/left of the address bar and allow notifications.')
    );
    setBusy(false);
    if (r.status === 'granted') {
      setNote('Done — you will get desktop notifications, even with this tab closed.');
      setTimeout(() => setShow(false), 3000);
    } else if (r.status === 'denied') {
      setNote('Notifications are blocked for this site. Allow them from the lock icon next to the address, then reload.');
    } else if (r.status === 'default') {
      later();
    } else if (r.status === 'failed') {
      setNote((r as { reason: string }).reason);
    } else {
      setNote("This browser can't show desktop notifications here (it needs the HTTPS address).");
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Desktop notifications"
      className="fixed z-[60] bottom-5 left-5 w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-slate-200 bg-white shadow-xl p-4"
    >
      <button type="button" onClick={later} aria-label="Not now" className="absolute top-2.5 right-2.5 p-1 text-slate-400 hover:text-slate-700">
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3 pr-4">
        <span className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
          <BellRing className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-900">Get desktop notifications</div>
          <p className="text-xs text-slate-500 mt-0.5">
            New chat messages, approvals, leave and claims pop up on your computer — even when CredenceHR isn't open.
          </p>
        </div>
      </div>
      {note && <p className="text-xs text-slate-700 mt-3">{note}</p>}
      {!busy && !note?.startsWith('Done') && (
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={later} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
            Not now
          </button>
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {note ? 'Try again' : 'Turn on'}
          </button>
        </div>
      )}
    </div>
  );
};
