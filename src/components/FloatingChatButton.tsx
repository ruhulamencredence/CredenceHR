/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';

interface FloatingChatButtonProps {
  token: string;
  onOpenChat: () => void;
  // Hidden while the in-app Chat popup itself is already open.
  hidden?: boolean;
}

// A plain speech bubble (with its tail) in the theme colour and three white
// dots inside — the simple, familiar "chat" sign. (It used to hold the app's
// house + people glyph, which read as busy at this size.)
const ChatBubbleLogo: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <svg viewBox="0 0 100 100" className={className} style={style} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M52 6C29.36 6 11 22.66 11 43.2c0 11.1 5.36 21.06 13.86 27.9-.46 5.9-2.2 10.86-5.4 15.2-.86 1.16.1 2.8 1.54 2.6 7.1-1 13.06-3.86 17.9-7.36 4 1.06 8.24 1.66 12.68 1.66C74.64 82.6 93 65.94 93 45.4S74.64 6 52 6Z"
      fill="currentColor"
    />
    <circle cx="35" cy="45" r="6" fill="#FFFFFF" />
    <circle cx="52" cy="45" r="6" fill="#FFFFFF" />
    <circle cx="69" cy="45" r="6" fill="#FFFFFF" />
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
  const [attention, setAttention] = useState(false);

  const triggerAttention = useCallback(() => {
    setAttention(true);
    setTimeout(() => setAttention(false), 900);
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      // The header badge and the floating button ask at the same moment:
      // one request serves both (dedupedFetchJson).
      const data = await dedupedFetchJson(apiUrl('/api/chat/unread-count'), token);
      if (!data) return;
      setUnreadCount(Number(data?.count || 0));
    } catch {
      // Offline or server unreachable — silently skip, retried on next poll/event.
    }
  }, [token]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    const socket = getChatSocket();
    // A real new message both refreshes the count and wiggles the button
    // right away, instead of waiting for the idle nudge below.
    const onNewMessage = () => {
      fetchUnreadCount();
      triggerAttention();
    };
    socket?.on('receive_message', onNewMessage);
    socket?.on('message_read', fetchUnreadCount);
    return () => {
      clearInterval(interval);
      socket?.off('receive_message', onNewMessage);
      socket?.off('message_read', fetchUnreadCount);
    };
  }, [fetchUnreadCount, triggerAttention]);

  // Every so often, nudge the button with a brief wiggle on its own —
  // a quiet attention-getter for anyone who hasn't noticed it yet.
  useEffect(() => {
    const interval = setInterval(triggerAttention, 15000);
    return () => clearInterval(interval);
  }, [triggerAttention]);

  if (hidden) return null;

  return (
    <>
      <style>{`
        @keyframes chrChatNudge {
          0%, 100% { transform: scale(1) rotate(0deg); }
          20% { transform: scale(1.15) rotate(-8deg); }
          40% { transform: scale(1.05) rotate(6deg); }
          60% { transform: scale(1.12) rotate(-4deg); }
          80% { transform: scale(1) rotate(2deg); }
        }
        .chr-chat-nudge { animation: chrChatNudge 0.9s ease-in-out; }
        @media (prefers-reduced-motion: reduce) {
          .chr-chat-nudge { animation: none; }
        }
      `}</style>
      <button
        type="button"
        onClick={onOpenChat}
        title="Chat"
        aria-label="Open chat"
        className={`hidden md:flex fixed bottom-6 right-6 z-50 w-14 h-14 items-center justify-center rounded-full hover:scale-105 active:scale-95 transition-transform ${attention ? 'chr-chat-nudge' : ''}`}
        style={{ color: 'var(--g-accent)' }}
      >
        <ChatBubbleLogo
          className="w-full h-full"
          style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.22))' }}
        />

        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </>
  );
};