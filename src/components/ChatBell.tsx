/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';

interface ChatBellProps {
  token: string;
  onOpenChat: () => void;
}

// Navbar chat icon + unread badge — same polling-for-the-badge,
// full-list-only-on-open idea as AlertsBell, except Chat has no dropdown
// here (opening it takes over the whole page, see ChatPanel.tsx), so this
// only ever needs the count. Refreshes on a timer AND on 'receive_message'/
// 'message_read' socket events, so the badge updates live while this account
// is looking at something other than Chat.
export const ChatBell: React.FC<ChatBellProps> = ({ token, onOpenChat }) => {
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

  return (
    <button
      type="button"
      onClick={onOpenChat}
      className="relative p-2 rounded-full hover:bg-black/5 transition-colors"
      style={{ color: 'var(--g-text-muted)' }}
      title="Chat"
      aria-label="Open chat"
    >
      <MessageSquare className="w-[18px] h-[18px]" />
      {unreadCount > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 bg-emerald-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
};
