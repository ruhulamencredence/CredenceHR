/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, LayoutGrid, MessageCircle, UserRound, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';

// The ⋮ button on the right of the blended phone header (Navbar.tsx `blend`
// — My Claims, Leave, My Tasks…): the header there only has room for Back,
// the title and one round button, so Alerts, Chat, Profile and the app menu
// sit in this small liquid-glass card instead. A red dot on the button while
// there is an unread alert or chat message.
export const HeaderMoreMenu: React.FC<{
  token: string;
  showChat: boolean;
  onOpenAlerts: () => void;
  onOpenChat: () => void;
  onOpenProfile: () => void;
  onOpenMenu: () => void;
}> = ({ token, showChat, onOpenAlerts, onOpenChat, onOpenProfile, onOpenMenu }) => {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState(0);
  const [chats, setChats] = useState(0);
  useBackButtonClose(open, () => setOpen(false));

  const count = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return 0;
        const data = await res.json();
        return Number(data?.count || 0);
      } catch {
        return 0; // offline — no badge, tried again on the next poll
      }
    },
    [token]
  );
  const refresh = useCallback(async () => {
    setAlerts(await count('/api/alerts/unread-count?bell=1'));
    if (showChat) setChats(await count('/api/chat/unread-count'));
  }, [count, showChat]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const badge = (n: number) =>
    n > 0 ? <span className="ml-auto min-w-[22px] h-[22px] px-1.5 rounded-full bg-rose-600 text-white text-[11px] font-bold flex items-center justify-center">{n > 99 ? '99+' : n}</span> : null;
  const row = (icon: React.ReactNode, label: string, onClick: () => void, n = 0) => (
    <button type="button" onClick={pick(onClick)} className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left active:bg-white/40">
      <span className="liquid-glass-inset w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ color: 'var(--g-accent)' }}>
        {icon}
      </span>
      <span className="text-[15px] font-semibold" style={{ color: 'var(--g-text)' }}>{label}</span>
      {badge(n)}
    </button>
  );

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="hdr-round relative" aria-label="More" aria-haspopup="dialog" aria-expanded={open}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
        {alerts + chats > 0 && <span className="absolute top-0.5 right-0.5 w-2.5 h-2.5 rounded-full bg-rose-600 ring-2 ring-white" />}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="More">
            <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => setOpen(false)} />
            {/* Positioned by this wrapper — .liquid-glass sets position: relative. */}
            <div className="absolute right-3 w-[min(280px,calc(100vw-24px))]" style={{ top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 60px)' }}>
              <div className="liquid-glass liquid-glass-in rounded-[32px] rounded-tr-md p-2">
                <div className="flex justify-end px-1 pt-1">
                  <button type="button" onClick={() => setOpen(false)} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center" aria-label="Close">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {row(<Bell className="w-[18px] h-[18px]" />, 'Alerts', onOpenAlerts, alerts)}
                {showChat && row(<MessageCircle className="w-[18px] h-[18px]" />, 'Chat', onOpenChat, chats)}
                {row(<UserRound className="w-[18px] h-[18px]" />, 'Profile', onOpenProfile)}
                {row(<LayoutGrid className="w-[18px] h-[18px]" />, 'Menu', onOpenMenu)}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
