/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Unread Chat messages for the signed-in account: asked on start, every 30 s
// and whenever a message arrives or is read (the same request the header
// badge and the web's floating Chat button make — dedupedFetchJson serves
// them all at once). Off (0) when `token` is empty.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl, dedupedFetchJson } from './api';
import { getChatSocket } from './chatSocket';

export function useChatUnread(token: string | null | undefined): number {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const data = await dedupedFetchJson(apiUrl('/api/chat/unread-count'), token);
      if (data) setCount(Number(data?.count || 0));
    } catch {
      // offline — tried again on the next poll / message
    }
  }, [token]);
  useEffect(() => {
    if (!token) {
      setCount(0);
      return;
    }
    void refresh();
    const t = setInterval(refresh, 30000);
    const socket = getChatSocket();
    socket?.on('receive_message', refresh);
    socket?.on('message_read', refresh);
    return () => {
      clearInterval(t);
      socket?.off('receive_message', refresh);
      socket?.off('message_read', refresh);
    };
  }, [token, refresh]);
  return count;
}
