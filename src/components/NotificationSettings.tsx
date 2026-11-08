/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Profile -> Notifications: why this phone / browser does or doesn't get
// notifications, a "Turn on" button and a "Send a test" that shows the push
// service's own answer (src/lib/webPush.ts, server WebPushService.ts).

import React, { useState } from 'react';
import { BellRing, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import { apiUrl } from '../lib/api';
import { enableWebPush, webPushPermission, webPushSupported } from '../lib/webPush';
import { isIOSDevice, isStandalone } from './AddToHomeScreen';

const Check: React.FC<{ ok: boolean; text: string }> = ({ ok, text }) => (
  <div className="flex items-start gap-2 text-sm text-slate-700">
    {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />}
    <span>{text}</span>
  </div>
);

export const NotificationSettings: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const ios = isIOSDevice();
  const homeScreen = isStandalone();
  const supported = webPushSupported();
  const permission = webPushPermission();
  void tick;

  const turnOn = async () => {
    setBusy(true);
    setMsg('');
    const r = await enableWebPush(token);
    setBusy(false);
    setTick((t) => t + 1);
    if (r.status === 'granted') setMsg('Turned on. Tap "Send a test" to check.');
    else if (r.status === 'denied') setMsg(ios ? 'Blocked. Open the iPhone Settings → Notifications → CredenceHR and allow them.' : 'Blocked for this site — allow notifications from the lock icon next to the address.');
    else if (r.status === 'failed') setMsg((r as { reason: string }).reason);
    else setMsg('Not turned on.');
  };

  const test = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(apiUrl('/api/web-push/test'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Test failed');
      if (!d.available) setMsg("The server can't send notifications (no push key).");
      else if (!d.results.length) setMsg('This account has no phone/browser turned on yet. Tap "Turn on" first.');
      else
        setMsg(
          d.results
            .map((r: any) => (r.ok ? `Sent via ${r.host} — it should arrive in a few seconds.` : `${r.host}: failed (${r.status}) ${r.error || ''}`))
            .join('\n')
        );
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popup title="Notifications" icon={<BellRing className="w-4 h-4" />} size="md" onClose={onClose} footer={<button type="button" className={ghostBtn} onClick={onClose}>Close</button>}>
      <div className="space-y-4 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-4 space-y-2">
          {ios && <Check ok={homeScreen} text={homeScreen ? 'Opened from the Home Screen icon' : 'Open CredenceHR from its Home Screen icon — the iPhone allows notifications only there'} />}
          <Check ok={window.isSecureContext} text={window.isSecureContext ? 'Secure (https) address' : 'Needs the https:// address'} />
          <Check ok={supported} text={supported ? 'This browser can show notifications' : ios ? 'Needs iOS 16.4 or newer, opened from the Home Screen' : 'This browser cannot show notifications'} />
          <Check ok={permission === 'granted'} text={permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked in settings' : 'Not allowed yet'} />
        </div>
        <div className="flex gap-2">
          <button type="button" className={primaryBtn} onClick={() => void turnOn()} disabled={busy || !supported}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Turn on
          </button>
          <button type="button" className={ghostBtn} onClick={() => void test()} disabled={busy}>
            Send a test
          </button>
        </div>
        {msg && <div className="text-xs px-3 py-2 rounded-xl bg-slate-50 text-slate-700 whitespace-pre-wrap break-words">{msg}</div>}
      </div>
    </Popup>
  );
};
