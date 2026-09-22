/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';

interface FloatingChatButtonProps {
  token: string;
  onOpenChat: () => void;
  // Hidden while the in-app Chat popup itself is already open.
  hidden?: boolean;
}

// The app's own house/people glyph (see chr-logo.svg's Roof_Glyph +
// People_Glyph) redrawn inside a speech-bubble outline, per the hand-drawn
// reference: one shape reads as "Chat" (the bubble + tail) AND "CredenceHR"
// (the glyph inside it) at once, instead of a generic chat icon plus a
// separate app-icon badge bolted on next to it.
const ChatBubbleLogo: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 100 100" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M52 6C29.36 6 11 22.66 11 43.2c0 11.1 5.36 21.06 13.86 27.9-.46 5.9-2.2 10.86-5.4 15.2-.86 1.16.1 2.8 1.54 2.6 7.1-1 13.06-3.86 17.9-7.36 4 1.06 8.24 1.66 12.68 1.66C74.64 82.6 93 65.94 93 45.4S74.64 6 52 6C52.34 6 52 6 52 6Z"
      fill="currentColor"
    />
    <path
      d="M35 38 L52 24 L69 38"
      stroke="#FFFFFF"
      strokeWidth="7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="41" cy="52" r="8.5" fill="#FFFFFF" />
    <path d="M25 76a16 16 0 0 1 32 0z" fill="#FFFFFF" />
    <circle cx="63" cy="56" r="7" fill="#FFFFFF" />
    <path d="M50 76a13 13 0 0 1 26 0z" fill="#FFFFFF" />
  </svg>
);

// Web-only floating launcher (bottom-right, above everything else) for Chat
// — Navbar's ChatBell up top still exists and does the exact same thing,
// this is just a second, always-visible way in, the same "docked messenger
// bubble" pattern most web apps put in the corner. Opens Chat as an in-page
// popup overlay (see App.tsx's openChatPopup — sets showChat=true, same as
// the native app already does), never a new browser tab, unlike ChatBell's
// own onOpenChat on web.
export const FloatingChatButton: React.FC<FloatingChatButtonProps> = ({ token, onOpenChat, hidden }) => {
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/chat/unread-count'), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      setUnreadCount(Number(data?.count || 0));
    } catch {
      // Offline or server unreachable — silently skip, retried on next poll/event.
    }
  }, [token]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    const socket = getChatSocket();
    socket?.on('receive_message', fetchUnreadCount);
    socket?.on('message_read', fetchUnreadCount);
    return () => {
      clearInterval(interval);
      socket?.off('receive_message', fetchUnreadCount);
      socket?.off('message_read', fetchUnreadCount);
    };
  }, [fetchUnreadCount]);

  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={onOpenChat}
      title="Chat"
      aria-label="Open chat"
      className="hidden md:flex fixed bottom-6 right-6 z-50 w-16 h-16 items-center justify-center rounded-full shadow-[0_10px_28px_-6px_rgba(60,20,148,0.45)] hover:scale-105 active:scale-95 transition-transform"
      style={{ color: 'var(--g-accent)' }}
    >
      <ChatBubbleLogo className="w-full h-full drop-shadow-sm" />

      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
};
