/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';
import chrLogo from '../assets/chr-logo.svg';

interface FloatingChatButtonProps {
  token: string;
  onOpenChat: () => void;
  // Hidden while the in-app Chat page itself is open (native only — on web
  // onOpenChat always opens /chat in a new tab, so this is never true there,
  // but the prop still works either way).
  hidden?: boolean;
}

// Web-only floating launcher (bottom-right, above everything else) for Chat
// — Navbar's ChatBell up top still exists and does the exact same thing,
// this is just a second, always-visible way in, the same "docked messenger
// bubble" pattern most web apps put in the corner. Icon is the app's own
// C-HR mark (chr-logo.svg) with a small white chat-bubble badge overlaid at
// the corner, same unread-count badge/polling logic as ChatBell.
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
      className="hidden md:flex fixed bottom-6 right-6 z-50 w-14 h-14 items-center justify-center rounded-[18px] shadow-[0_10px_28px_-6px_rgba(60,20,148,0.45)] border border-white/40 overflow-hidden hover:scale-105 active:scale-95 transition-transform"
    >
      <img src={chrLogo} alt="" className="w-full h-full object-cover" />

      {/* Chat-bubble badge — same "app icon + feature glyph" docked-widget
          look a messenger launcher uses, so the button reads as "Chat"
          at a glance even before anyone notices the app icon underneath. */}
      <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white shadow-md flex items-center justify-center border-2 border-white">
        <MessageCircle className="w-3.5 h-3.5 text-[#7F4FE0]" fill="currentColor" strokeWidth={0} />
      </span>

      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
};
