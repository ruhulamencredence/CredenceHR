/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat — Direct messages, Group chat, and Community spaces (WhatsApp-style).
// Full-screen page, opened the same way ProfilePage.tsx is (see App.tsx's
// showChat/showProfilePage toggle). Backend: ChatRoutes.ts (REST for room
// list/history/members, Socket.IO for live send/typing/presence/read).
//
// Real-time vs REST: text messages go over the socket for lowest latency
// (see chatSocket.ts); image/file messages always POST through the REST
// endpoint (base64 body, same pattern as every other upload in this app —
// see profileRoutes.ts). Either path ends up broadcasting the same
// 'receive_message' socket event to every member's open ChatPanel.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  ArrowLeft, Search, Plus, X, Send, Paperclip, Check, CheckCheck,
  Users, UserPlus, Shield, LogOut, Trash2, MessageSquare, Link as LinkIcon, Mic
} from 'lucide-react';
import { User, ChatRoom, ChatMessage, ChatRoomMember, ChatDirectoryUser, ChatReadReceipt } from '../types';
import { apiUrl } from '../lib/api';
import { connectChatSocket, getChatSocket } from '../lib/chatSocket';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface ChatPanelProps {
  token: string;
  user: User;
  onBack: () => void;
  // Set by App.tsx when a Chat push notification was just tapped — opens
  // straight to that conversation once the room list has loaded. Cleared via
  // onInitialRoomHandled so re-opening Chat later doesn't keep jumping back.
  initialRoomId?: number | null;
  onInitialRoomHandled?: () => void;
  // 'fullscreen' (default): the original behavior — .chat-shell takes over
  // the whole viewport via `position: fixed; inset: 0`, tracking
  // window.visualViewport itself. 'modal': used by App.tsx's docked
  // FloatingChatButton popup, which already renders its own fixed backdrop +
  // sized card (New Leave Application-modal-sized) around this component —
  // here ChatPanel just needs to fill that card (w-full h-full), not the
  // whole screen, so the fixed positioning/visualViewport tracking below is
  // skipped entirely in this mode.
  variant?: 'fullscreen' | 'modal';
}

function timeOnly(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

function formatRecordingTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function roomDisplayName(room: ChatRoom, meId: number): string {
  if (room.type === 'direct') return room.other_participant?.name || 'Unknown';
  return room.title || (room.type === 'community' ? 'Community' : 'Group');
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

const AVATAR_PALETTE = ['#7F00FF', '#059669', '#0891b2', '#d97706', '#dc2626', '#4f46e5', '#be185d', '#0d9488'];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Highlights "@FullName" occurrences that match a CURRENT room member's name
// (inserted via the @mention picker — see insertMention in ChatPanel).
// Longest names first so "@John" doesn't shadow a match for "@John Doe".
function renderMessageContent(content: string, members: ChatRoomMember[]): React.ReactNode {
  if (members.length === 0) return content;
  const names = [...new Set(members.map((m) => m.name))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return content;
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g');
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));
    parts.push(
      <span key={key++} className="font-semibold text-blue-700">
        @{match[1]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts;
}

// Fetches one message's attachment (auth'd — <img src> can't send a Bearer
// header, so this can't just be a plain <img src={apiUrl(...)}>) as an
// object URL. Same fetch/blob/revoke pattern as useProfilePhoto.ts.
// Shared by AttachmentImage and AudioAttachment below — auth'd fetch (an
// <img>/<audio> src can't send a Bearer header on its own) turned into an
// object URL. Same fetch/blob/revoke pattern as useProfilePhoto.ts.
function useAttachmentUrl(token: string, messageId: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/chat/messages/${messageId}/attachment`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        // Offline or attachment gone — bubble just stays a placeholder below.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, messageId]);
  return url;
}

const AttachmentImage: React.FC<{ token: string; messageId: number }> = ({ token, messageId }) => {
  const url = useAttachmentUrl(token, messageId);
  if (!url) return <div className="w-48 h-32 bg-slate-200 rounded-lg animate-pulse" />;
  return (
    <img
      src={url}
      alt="attachment"
      className="max-w-[240px] max-h-[240px] rounded-lg object-cover cursor-pointer"
      onClick={() => window.open(url, '_blank')}
    />
  );
};

// Voice message bubble — the browser's own <audio controls> UI (play/pause,
// scrubber, duration) rather than a hand-built player, same reasoning as
// reusing native <input type="file"> elsewhere in this app instead of a
// custom picker.
const AudioAttachment: React.FC<{ token: string; messageId: number }> = ({ token, messageId }) => {
  const url = useAttachmentUrl(token, messageId);
  if (!url) {
    return (
      <div className="flex items-center gap-2 w-56 h-9 bg-slate-200 rounded-full animate-pulse px-3">
        <Mic className="w-3.5 h-3.5 text-slate-400" />
      </div>
    );
  }
  return <audio controls src={url} className="w-56 max-w-full h-9" />;
};

export const ChatPanel: React.FC<ChatPanelProps> = ({ token, user, onBack, initialRoomId, onInitialRoomHandled, variant = 'fullscreen' }) => {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roomSearch, setRoomSearch] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [typingByRoom, setTypingByRoom] = useState<Record<number, Set<number>>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  const [otherReadMessageId, setOtherReadMessageId] = useState<number | null>(null);
  // Group/community "Seen by ..." — who has read at least this far, for
  // just YOUR most recent message in the room (see fetchSeenBy below).
  // WhatsApp shows this per-message via long-press; here it's shown inline
  // under only the latest own message, which covers the common case
  // ("has everyone seen my last message yet?") without an extra tap.
  const [seenByLastOwnMessage, setSeenByLastOwnMessage] = useState<ChatReadReceipt[]>([]);
  const [seenByRefreshTick, setSeenByRefreshTick] = useState(0);
  // "@" mention autocomplete (group/community only) — the text typed after
  // the most recent unclosed "@" before the cursor, or null when not
  // currently mid-mention. See handleTyping/insertMention below.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Voice message recording — MediaRecorder over getUserMedia({audio:true}).
  // Requires RECORD_AUDIO in AndroidManifest.xml (Capacitor's default
  // WebChromeClient then handles the runtime permission prompt itself, no
  // custom native code needed). Falls back to a plain alert() if denied/
  // unavailable — text/image/file messages are unaffected either way.
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [members, setMembers] = useState<ChatRoomMember[]>([]);
  const [showNewChatModal, setShowNewChatModal] = useState<'direct' | 'group' | 'community' | null>(null);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showLinkGroup, setShowLinkGroup] = useState(false);
  const [directory, setDirectory] = useState<ChatDirectoryUser[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Live-measured viewport size/offset (window.visualViewport), NOT a CSS
  // vh/dvh guess or a hardcoded Navbar-height subtraction — both of those
  // turned out unreliable on the actual device this was tested on (a
  // notch/status-bar inset the CSS math didn't account for, and `position:
  // fixed` not reliably tracking the real viewport once the on-screen
  // keyboard opened). visualViewport reports the ACTUAL visible area
  // directly, keyboard included, so .chat-shell's size/position below is
  // driven by real numbers instead of assumptions. null until the first
  // measurement lands, during which .chat-shell's CSS `inset: 0` fallback
  // (index.css) covers the gap.
  const [viewportSize, setViewportSize] = useState<{ height: number; top: number } | null>(null);

  // Scrolled directly via scrollTop (see scrollMessagesToBottom below), NOT
  // scrollIntoView() on a descendant — scrollIntoView walks up and scrolls
  // EVERY scrollable ancestor needed to bring its target into view, which,
  // if this div's own overflow-y-auto ever isn't enough on its own to
  // satisfy that (e.g. a height miscalculation on some device), escalates to
  // scrolling the outer page/body too — that's what was dragging the app's
  // own header and this panel's conversation header off-screen together.
  // Targeting this container specifically makes that structurally
  // impossible: it can never move anything outside itself.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref mirror of activeRoomId so the socket listeners below (registered
  // once on mount) always see the CURRENT room without needing to
  // re-subscribe every time the user switches chats.
  const activeRoomIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  useBackButtonClose(!!showNewChatModal, () => setShowNewChatModal(null));
  useBackButtonClose(showInfoPanel, () => setShowInfoPanel(false));

  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeRoomId) || null, [rooms, activeRoomId]);

  const fetchRooms = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/chat/rooms'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRooms(await res.json());
    } catch {
      // Offline — room list just stays whatever it last was.
    }
  }, [token]);

  const fetchDirectory = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/chat/directory'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setDirectory(await res.json());
    } catch {
      // Offline — pickers just show nothing until the next open.
    }
  }, [token]);

  const fetchMembers = useCallback(
    async (roomId: number) => {
      try {
        const res = await fetch(apiUrl(`/api/chat/rooms/${roomId}/members`), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) setMembers(await res.json());
      } catch {
        // Offline — info panel just shows the last-known list.
      }
    },
    [token]
  );

  // Connect the socket once (App.tsx also connects it on login — this is a
  // no-op re-entrant call if that already happened, see chatSocket.ts).
  useEffect(() => {
    if (token) connectChatSocket(token);
  }, [token]);

  useEffect(() => {
    fetchRooms();
    fetchDirectory();
  }, [fetchRooms, fetchDirectory]);

  // Live socket listeners — attached once per mount, not per active room, so
  // a message arriving for a room that ISN'T open still updates its unread
  // badge/preview in the sidebar.
  useEffect(() => {
    const socket = getChatSocket();
    if (!socket) return;

    const onReceive = (msg: ChatMessage) => {
      setRooms((prev) => {
        const idx = prev.findIndex((r) => r.id === msg.room_id);
        if (idx === -1) {
          fetchRooms(); // a room we're not tracking yet (e.g. just added) — full refresh
          return prev;
        }
        const next = [...prev];
        const isActive = msg.room_id === activeRoomIdRef.current;
        next[idx] = {
          ...next[idx],
          last_message_id: msg.id,
          last_message_content: msg.content,
          last_message_type: msg.message_type,
          last_message_sender_id: msg.sender_id,
          last_message_at: msg.created_at,
          unread_count: isActive || msg.sender_id === user.id ? next[idx].unread_count : next[idx].unread_count + 1
        };
        const [room] = next.splice(idx, 1);
        next.unshift(room);
        return next;
      });
      if (msg.room_id === activeRoomIdRef.current) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        if (msg.sender_id !== user.id) socket.emit('mark_read', { roomId: msg.room_id, messageId: msg.id });
      }
    };
    const onTyping = ({ roomId, userId, isTyping }: { roomId: number; userId: number; isTyping: boolean }) => {
      setTypingByRoom((prev) => {
        const set = new Set(prev[roomId] || []);
        if (isTyping) set.add(userId);
        else set.delete(userId);
        return { ...prev, [roomId]: set };
      });
    };
    const onRead = ({ roomId, userId, messageId }: { roomId: number; userId: number; messageId: number }) => {
      if (roomId !== activeRoomIdRef.current) return;
      if (userId !== user.id) {
        setOtherReadMessageId((prev) => Math.max(prev || 0, messageId));
      }
      // Someone (including a THIRD member in a group, not just "the other
      // participant" tracked above) just read further — the "Seen by ..."
      // caption on our last own message may need to grow.
      setSeenByRefreshTick((v) => v + 1);
    };
    const onPresence = ({ userId, online }: { userId: number; online: boolean }) => {
      setOnlineUserIds((prev) => {
        const next = new Set(prev);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      });
    };
    const onMembersChanged = ({ roomId }: { roomId: number }) => {
      if (roomId === activeRoomIdRef.current) fetchMembers(roomId);
      fetchRooms();
    };

    socket.on('receive_message', onReceive);
    socket.on('user_typing', onTyping);
    socket.on('message_read', onRead);
    socket.on('presence_change', onPresence);
    socket.on('members_changed', onMembersChanged);
    return () => {
      socket.off('receive_message', onReceive);
      socket.off('user_typing', onTyping);
      socket.off('message_read', onRead);
      socket.off('presence_change', onPresence);
      socket.off('members_changed', onMembersChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRooms, fetchMembers, user.id]);

  const openRoom = useCallback(
    async (roomId: number) => {
      setActiveRoomId(roomId);
      setShowInfoPanel(false);
      setReplyTo(null);
      setOtherReadMessageId(null);
      setMentionQuery(null);
      setLoadingMessages(true);
      getChatSocket()?.emit('join_room', roomId);
      // Members are needed up-front for @mention autocomplete in a group/
      // community, not just when the info panel is opened — see
      // handleTyping/mentionCandidates below.
      const room = rooms.find((r) => r.id === roomId);
      if (room && room.type !== 'direct') fetchMembers(roomId);
      try {
        const res = await fetch(apiUrl(`/api/chat/rooms/${roomId}/messages?limit=50`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data: ChatMessage[] = await res.json();
          setMessages(data);
          const lastId = data[data.length - 1]?.id;
          if (lastId) {
            getChatSocket()?.emit('mark_read', { roomId, messageId: lastId });
            fetch(apiUrl(`/api/chat/rooms/${roomId}/read`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ messageId: lastId })
            }).catch(() => {});
          }
        }
      } finally {
        setLoadingMessages(false);
      }
      setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, unread_count: 0 } : r)));
    },
    [token, rooms, fetchMembers]
  );

  // Push-notification deep link (see App.tsx's pendingChatRoomId) — opens
  // straight to that conversation once the room list has actually loaded
  // and confirms membership, rather than firing blind the instant this
  // component mounts.
  useEffect(() => {
    if (!initialRoomId) return;
    if (rooms.some((r) => r.id === initialRoomId)) {
      openRoom(initialRoomId);
      onInitialRoomHandled?.();
    }
  }, [initialRoomId, rooms, openRoom, onInitialRoomHandled]);

  const lastOwnMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_id === user.id) return messages[i].id;
    }
    return null;
  }, [messages, user.id]);

  useEffect(() => {
    if (!lastOwnMessageId || !activeRoom || activeRoom.type === 'direct') {
      setSeenByLastOwnMessage([]);
      return;
    }
    let cancelled = false;
    fetch(apiUrl(`/api/chat/messages/${lastOwnMessageId}/reads`), { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: ChatReadReceipt[]) => {
        if (!cancelled) setSeenByLastOwnMessage(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lastOwnMessageId, activeRoom, token, seenByRefreshTick]);

  const scrollMessagesToBottom = useCallback((smooth: boolean) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    scrollMessagesToBottom(true);
  }, [messages.length, scrollMessagesToBottom]);

  // window.visualViewport is the standards-based, actually-reliable way to
  // know the real visible area in a WebView, keyboard included — unlike
  // CSS `dvh`/`position:fixed`, it doesn't depend on the WebView correctly
  // propagating a native resize event to layout; it just reports the true
  // numbers whenever they change (keyboard open/close, rotation). Every
  // modern Android WebView supports it, so no feature-detection fallback
  // math is needed beyond the `if (!vv) return` guard below (an
  // unsupported browser just keeps .chat-shell's CSS `inset: 0` instead).
  useEffect(() => {
    if (variant === 'modal') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewportSize({ height: vv.height, top: vv.offsetTop });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [variant]);

  // Locks the OUTER page from scrolling at all while a conversation is open.
  // .chat-shell (index.css) already takes ChatPanel out of the page's normal
  // flow entirely (position: fixed), so this is now mostly a nicety — it
  // freezes whatever page was open behind Chat at its current scroll
  // position instead of it silently jumping around underneath.
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  // Android keyboard covering the message input — window.visualViewport
  // (above) is supposed to track the real visible area on its own, but on
  // several real-device WebViews (confirmed: keyboard opens, the input bar
  // stays hidden underneath it — visualViewport's resize event never fires,
  // or fires with a stale height) it doesn't. Rather than depend on that,
  // ask the Capacitor Keyboard plugin directly for the keyboard's actual
  // height and reserve that much space at the bottom of .chat-shell via
  // padding-bottom (merged into the style below) — this works regardless of
  // whether visualViewport itself is reliable on a given device.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let willShowHandle: { remove: () => void } | undefined;
    let willHideHandle: { remove: () => void } | undefined;
    (async () => {
      try {
        const { Keyboard } = await import('@capacitor/keyboard');
        willShowHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
          setKeyboardHeight(info.keyboardHeight);
          scrollMessagesToBottom(true);
        });
        willHideHandle = await Keyboard.addListener('keyboardWillHide', () => {
          setKeyboardHeight(0);
        });
      } catch {
        // Plugin unavailable — the .chat-shell layout above is still the primary fix.
      }
    })();
    return () => {
      willShowHandle?.remove();
      willHideHandle?.remove();
    };
  }, [scrollMessagesToBottom]);

  const handleTyping = useCallback(
    (text: string, cursorPos: number) => {
      setMessageInput(text);
      if (!activeRoomId) return;
      const socket = getChatSocket();
      socket?.emit('typing', { roomId: activeRoomId, isTyping: true });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        socket?.emit('typing', { roomId: activeRoomId, isTyping: false });
      }, 2000);

      // "@" mention trigger — an "@" at the start of the text or right after
      // whitespace, with only name-shaped characters (and no second "@")
      // between it and the cursor. Matches multi-word names ("@John Doe")
      // without needing to close the mention first.
      if (activeRoom?.type !== 'direct') {
        const beforeCursor = text.slice(0, cursorPos);
        const match = beforeCursor.match(/(?:^|\s)@([a-zA-Z0-9 ]{0,40})$/);
        setMentionQuery(match ? match[1] : null);
      }
    },
    [activeRoomId, activeRoom?.type]
  );

  // Candidates shown in the @mention dropdown — every room member (besides
  // yourself) whose name contains what's typed after "@" so far.
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return members.filter((m) => m.user_id !== user.id && (!q || m.name.toLowerCase().includes(q)));
  }, [mentionQuery, members, user.id]);

  const insertMention = useCallback(
    (name: string) => {
      const input = messageInputRef.current;
      const cursorPos = input?.selectionStart ?? messageInput.length;
      const before = messageInput.slice(0, cursorPos);
      const after = messageInput.slice(cursorPos);
      const newBefore = before.replace(/@([a-zA-Z0-9 ]{0,40})$/, `@${name} `);
      const newText = newBefore + after;
      setMessageInput(newText);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(newBefore.length, newBefore.length);
      });
    },
    [messageInput]
  );

  const sendTextMessage = useCallback(() => {
    const content = messageInput.trim();
    if (!content || !activeRoomId || sending) return;
    setSending(true);
    const socket = getChatSocket();
    const payload = { roomId: activeRoomId, content, replyToId: replyTo?.id || null };
    const finish = () => {
      setSending(false);
      setMessageInput('');
      setReplyTo(null);
      setMentionQuery(null);
    };
    if (socket?.connected) {
      socket.emit('send_message', payload, (ack: { ok: boolean; message?: ChatMessage; error?: string }) => {
        finish();
        if (ack?.ok && ack.message) {
          setMessages((prev) => (prev.some((m) => m.id === ack.message!.id) ? prev : [...prev, ack.message!]));
        }
      });
    } else {
      fetch(apiUrl(`/api/chat/rooms/${activeRoomId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content, messageType: 'text', replyToId: replyTo?.id || null })
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((message: ChatMessage | null) => {
          finish();
          if (message) setMessages((prev) => [...prev, message]);
        })
        .catch(() => finish());
    }
  }, [messageInput, activeRoomId, sending, replyTo, token]);

  // Shared by sendAttachment (image/file picker) and sendAudioMessage
  // (voice recording) below — both end up as a base64 body POSTed to the
  // same REST endpoint (see the module comment's text-over-socket /
  // attachment-over-REST split).
  const uploadAttachmentMessage = useCallback(
    async (params: { blob: Blob; messageType: 'image' | 'file' | 'audio'; filename: string; mimetype: string }) => {
      if (!activeRoomId) return;
      if (params.blob.size > 5 * 1024 * 1024) {
        alert('Attachment must be less than 5MB.');
        return;
      }
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(params.blob);
      });
      try {
        const res = await fetch(apiUrl(`/api/chat/rooms/${activeRoomId}/messages`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messageType: params.messageType,
            attachment_base64: base64,
            attachment_mimetype: params.mimetype,
            attachment_filename: params.filename
          })
        });
        if (res.ok) {
          const message: ChatMessage = await res.json();
          setMessages((prev) => [...prev, message]);
        }
      } catch {
        alert('Could not send — check your connection and try again.');
      }
    },
    [activeRoomId, token]
  );

  const sendAttachment = useCallback(
    (file: File) =>
      uploadAttachmentMessage({
        blob: file,
        messageType: file.type.startsWith('image/') ? 'image' : 'file',
        filename: file.name,
        mimetype: file.type
      }),
    [uploadAttachmentMessage]
  );

  const sendAudioMessage = useCallback(
    (blob: Blob) =>
      uploadAttachmentMessage({
        blob,
        messageType: 'audio',
        filename: 'voice-message.webm',
        mimetype: blob.type || 'audio/webm'
      }),
    [uploadAttachmentMessage]
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      recordedChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      alert('Could not access the microphone — check that this app has microphone permission.');
    }
  }, []);

  // send=false discards the recording (mic X button); send=true uploads it.
  const stopRecording = useCallback(
    (send: boolean) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.onstop = () => {
        recordingStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordingStreamRef.current = null;
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        setIsRecording(false);
        if (send && recordedChunksRef.current.length > 0) {
          const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          void sendAudioMessage(blob);
        }
        recordedChunksRef.current = [];
      };
      recorder.stop();
      mediaRecorderRef.current = null;
    },
    [sendAudioMessage]
  );

  // Never leave the microphone open if this page unmounts mid-recording
  // (e.g. the account taps Back while recording).
  useEffect(() => {
    return () => {
      recordingStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  const createRoom = useCallback(
    async (type: 'direct' | 'group' | 'community', title: string, memberIds: number[]) => {
      try {
        const res = await fetch(apiUrl('/api/chat/rooms'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type, title, memberIds })
        });
        if (res.ok) {
          const room = await res.json();
          setShowNewChatModal(null);
          await fetchRooms();
          openRoom(room.id);
        }
      } catch {
        alert('Could not create the chat — check your connection and try again.');
      }
    },
    [token, fetchRooms, openRoom]
  );

  const filteredRooms = useMemo(() => {
    const q = roomSearch.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => roomDisplayName(r, user.id).toLowerCase().includes(q));
  }, [rooms, roomSearch, user.id]);

  const isRoomAdmin = activeRoom?.my_role === 'admin';
  const typingNamesInActiveRoom = activeRoomId ? [...(typingByRoom[activeRoomId] || [])] : [];
  const isTypingInActiveRoom = typingNamesInActiveRoom.length > 0;

  return (
    <div
      className={variant === 'modal' ? 'flex bg-white w-full h-full min-h-0' : 'chat-shell flex bg-white'}
      style={
        variant === 'fullscreen'
          ? {
              ...(viewportSize ? { top: viewportSize.top, height: viewportSize.height } : null),
              ...(keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null)
            }
          : undefined
      }
    >
      {/* Sidebar: room list */}
      <div className={`w-full md:w-[360px] border-r border-slate-200 flex flex-col ${activeRoomId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-2">
          <button type="button" onClick={onBack} className="p-1.5 -ml-1.5 text-slate-500 hover:bg-slate-100 rounded-lg md:hidden">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="font-bold text-slate-900 text-lg flex-1">Chats</h2>
          <div className="relative group">
            <button type="button" className="p-2 text-slate-600 hover:bg-slate-100 rounded-full">
              <Plus className="w-5 h-5" />
            </button>
            <div className="hidden group-hover:block group-focus-within:block absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg py-1 w-44 z-20">
              <button type="button" onClick={() => setShowNewChatModal('direct')} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-slate-400" /> New Chat
              </button>
              <button type="button" onClick={() => setShowNewChatModal('group')} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2">
                <Users className="w-4 h-4 text-slate-400" /> New Group
              </button>
              <button type="button" onClick={() => setShowNewChatModal('community')} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2">
                <Shield className="w-4 h-4 text-slate-400" /> New Community
              </button>
            </div>
          </div>
        </div>
        <div className="p-3 border-b border-slate-100">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={roomSearch}
              onChange={(e) => setRoomSearch(e.target.value)}
              placeholder="Search chats..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredRooms.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">No chats yet — tap + to start one.</div>
          )}
          {filteredRooms.map((room) => {
            const name = roomDisplayName(room, user.id);
            const isOnline = room.type === 'direct' && room.other_participant && onlineUserIds.has(room.other_participant.id);
            const previewPrefix = room.last_message_sender_id === user.id ? 'You: ' : '';
            const previewText =
              room.last_message_type === 'image'
                ? '📷 Photo'
                : room.last_message_type === 'audio'
                ? '🎤 Voice message'
                : room.last_message_type === 'file'
                ? '📎 File'
                : room.last_message_content || 'No messages yet';
            return (
              <button
                key={room.id}
                type="button"
                onClick={() => openRoom(room.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 border-b border-slate-50 text-left ${
                  activeRoomId === room.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="relative shrink-0">
                  <div
                    className="w-11 h-11 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                    style={{ background: avatarColor(name) }}
                  >
                    {room.type === 'community' ? <Shield className="w-5 h-5" /> : room.type === 'group' ? <Users className="w-5 h-5" /> : initialsOf(name)}
                  </div>
                  {isOnline && <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-white rounded-full" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-semibold text-sm text-slate-900 truncate">{name}</span>
                    {room.last_message_at && <span className="text-[11px] text-slate-400 shrink-0">{timeOnly(room.last_message_at)}</span>}
                  </div>
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-xs text-slate-500 truncate">{previewPrefix}{previewText}</span>
                    {room.unread_count > 0 && (
                      <span className="shrink-0 bg-emerald-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                        {room.unread_count > 99 ? '99+' : room.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main chat window */}
      <div className={`flex-1 flex-col bg-[#F7F8FA] ${activeRoomId ? 'flex' : 'hidden md:flex'}`}>
        {!activeRoom ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2">
            <MessageSquare className="w-12 h-12" />
            <p className="text-sm">Select a chat to start messaging</p>
          </div>
        ) : (
          <>
            <div className="p-3 bg-white border-b border-slate-200 flex items-center gap-3">
              <button type="button" onClick={() => setActiveRoomId(null)} className="p-1.5 -ml-1 text-slate-500 hover:bg-slate-100 rounded-lg md:hidden">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (activeRoom.type !== 'direct') {
                    setShowInfoPanel((v) => !v);
                    fetchMembers(activeRoom.id);
                  }
                }}
                className="flex items-center gap-3 flex-1 min-w-0 text-left"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm shrink-0"
                  style={{ background: avatarColor(roomDisplayName(activeRoom, user.id)) }}
                >
                  {activeRoom.type === 'community' ? <Shield className="w-5 h-5" /> : activeRoom.type === 'group' ? <Users className="w-5 h-5" /> : initialsOf(roomDisplayName(activeRoom, user.id))}
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm text-slate-900 truncate">{roomDisplayName(activeRoom, user.id)}</h3>
                  <span className="text-xs text-slate-500">
                    {isTypingInActiveRoom
                      ? 'typing...'
                      : activeRoom.type === 'direct'
                      ? activeRoom.other_participant && onlineUserIds.has(activeRoom.other_participant.id)
                        ? 'Online'
                        : 'Offline'
                      : 'Tap for group info'}
                  </span>
                </div>
              </button>
            </div>

            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2">
              {loadingMessages && <div className="text-center text-xs text-slate-400 py-4">Loading...</div>}
              {messages.map((msg) => {
                const isMe = msg.sender_id === user.id;
                const isRead = isMe && otherReadMessageId !== null && msg.id <= otherReadMessageId;
                return (
                  <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                    <div className="max-w-[75%] md:max-w-md">
                      {!isMe && activeRoom.type !== 'direct' && (
                        <div className="text-[11px] font-semibold text-slate-500 ml-1 mb-0.5">{msg.sender_name}</div>
                      )}
                      <div
                        className={`px-3 py-2 rounded-2xl text-sm shadow-sm ${
                          isMe ? 'bg-[#D9FDD3] text-slate-800 rounded-br-sm' : 'bg-white text-slate-800 rounded-bl-sm'
                        }`}
                      >
                        {msg.reply_to_id && (
                          <div className="mb-1.5 pl-2 border-l-2 border-slate-300 text-xs text-slate-500">
                            <div className="font-semibold">{msg.reply_to_sender_name}</div>
                            <div className="truncate">{msg.reply_to_content}</div>
                          </div>
                        )}
                        {msg.message_type === 'image' && msg.has_attachment && <AttachmentImage token={token} messageId={msg.id} />}
                        {msg.message_type === 'audio' && msg.has_attachment && <AudioAttachment token={token} messageId={msg.id} />}
                        {msg.message_type === 'file' && msg.has_attachment && (
                          <a
                            href="#"
                            onClick={async (e) => {
                              e.preventDefault();
                              const res = await fetch(apiUrl(`/api/chat/messages/${msg.id}/attachment`), {
                                headers: { Authorization: `Bearer ${token}` }
                              });
                              if (!res.ok) return;
                              const blob = await res.blob();
                              window.open(URL.createObjectURL(blob), '_blank');
                            }}
                            className="flex items-center gap-2 text-blue-700 underline"
                          >
                            <Paperclip className="w-4 h-4" /> {msg.attachment_filename || 'Attachment'}
                          </a>
                        )}
                        {msg.content && <p className="whitespace-pre-wrap break-words">{renderMessageContent(msg.content, members)}</p>}
                        <div className="flex justify-end items-center gap-1 mt-1 text-[10px] text-slate-400">
                          <button
                            type="button"
                            onClick={() => setReplyTo(msg)}
                            className="opacity-0 hover:opacity-100 focus:opacity-100 mr-1 text-slate-400 hover:text-slate-600"
                            title="Reply"
                          >
                            Reply
                          </button>
                          <span>{timeOnly(msg.created_at)}</span>
                          {isMe && (isRead ? <CheckCheck size={14} className="text-blue-500" /> : <Check size={14} />)}
                        </div>
                      </div>
                      {isMe && activeRoom.type !== 'direct' && msg.id === lastOwnMessageId && seenByLastOwnMessage.length > 0 && (
                        <div className="text-[10px] text-slate-400 text-right mr-1 mt-0.5 truncate">
                          Seen by {seenByLastOwnMessage.slice(0, 3).map((r) => r.name.split(' ')[0]).join(', ')}
                          {seenByLastOwnMessage.length > 3 ? ` +${seenByLastOwnMessage.length - 3}` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {replyTo && (
              <div className="px-4 py-2 bg-slate-100 border-t border-slate-200 flex items-center justify-between">
                <div className="text-xs text-slate-600 truncate">
                  Replying to <span className="font-semibold">{replyTo.sender_name}</span>: {replyTo.content || 'attachment'}
                </div>
                <button type="button" onClick={() => setReplyTo(null)} className="p-1 text-slate-400 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="relative p-3 bg-white border-t border-slate-200 flex items-center gap-2">
              {mentionQuery !== null && activeRoom.type !== 'direct' && mentionCandidates.length > 0 && (
                <div className="absolute bottom-full left-3 right-3 mb-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto z-10">
                  {mentionCandidates.map((m) => (
                    <button
                      key={m.user_id}
                      type="button"
                      onClick={() => insertMention(m.name)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 text-left text-sm"
                    >
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0"
                        style={{ background: avatarColor(m.name) }}
                      >
                        {initialsOf(m.name)}
                      </div>
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
              {isRecording ? (
                <>
                  <button
                    type="button"
                    onClick={() => stopRecording(false)}
                    className="p-2 text-rose-500 hover:bg-rose-50 rounded-full shrink-0"
                    title="Discard recording"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                  <div className="flex-1 flex items-center gap-2 py-2.5 px-4 bg-slate-100 rounded-full text-sm text-slate-600">
                    <span className="w-2.5 h-2.5 bg-rose-500 rounded-full animate-pulse shrink-0" />
                    Recording... {formatRecordingTime(recordingSeconds)}
                  </div>
                  <button
                    type="button"
                    onClick={() => stopRecording(true)}
                    className="p-2.5 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 shrink-0"
                    title="Send voice message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf,.doc,.docx,.xlsx"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) sendAttachment(file);
                      e.target.value = '';
                    }}
                  />
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 text-slate-500 hover:bg-slate-100 rounded-full shrink-0">
                    <Paperclip className="w-5 h-5" />
                  </button>
                  <input
                    ref={messageInputRef}
                    type="text"
                    value={messageInput}
                    onChange={(e) => handleTyping(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                    onKeyDown={(e) => e.key === 'Enter' && sendTextMessage()}
                    placeholder={activeRoom.type !== 'direct' ? 'Type a message, @ to mention' : 'Type a message'}
                    className="flex-1 py-2.5 px-4 bg-slate-100 rounded-full border-none focus:outline-none focus:ring-2 focus:ring-blue-600 text-sm"
                  />
                  {messageInput.trim() ? (
                    <button
                      type="button"
                      onClick={sendTextMessage}
                      disabled={sending}
                      className="p-2.5 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 disabled:opacity-40 shrink-0"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={startRecording}
                      className="p-2.5 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 shrink-0"
                      title="Record a voice message"
                    >
                      <Mic className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Group/Community info panel */}
      {showInfoPanel && activeRoom && (
        <div className="w-full md:w-[320px] border-l border-slate-200 bg-white flex flex-col absolute md:relative inset-0 md:inset-auto z-10">
          <div className="p-4 border-b border-slate-200 flex items-center gap-2">
            <button type="button" onClick={() => setShowInfoPanel(false)} className="p-1.5 -ml-1.5 text-slate-500 hover:bg-slate-100 rounded-lg">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h3 className="font-bold text-slate-900">{activeRoom.type === 'community' ? 'Community Info' : 'Group Info'}</h3>
          </div>
          <div className="p-4 border-b border-slate-100 text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-white font-bold text-lg mx-auto mb-2"
              style={{ background: avatarColor(roomDisplayName(activeRoom, user.id)) }}
            >
              {activeRoom.type === 'community' ? <Shield className="w-7 h-7" /> : <Users className="w-7 h-7" />}
            </div>
            <div className="font-semibold text-slate-900">{roomDisplayName(activeRoom, user.id)}</div>
            <div className="text-xs text-slate-400">{members.length} members</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 py-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-slate-400">Members</span>
              {isRoomAdmin && (
                <button type="button" onClick={() => setShowAddMembers(true)} className="text-xs font-semibold text-blue-600 flex items-center gap-1">
                  <UserPlus className="w-3.5 h-3.5" /> Add
                </button>
              )}
            </div>
            {members.map((m) => (
              <div key={m.user_id} className="px-4 py-2 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: avatarColor(m.name) }}>
                  {initialsOf(m.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-900 truncate">{m.name}{m.user_id === user.id ? ' (You)' : ''}</div>
                  {m.role === 'admin' && <div className="text-[11px] text-emerald-600 font-medium">Admin</div>}
                </div>
                {isRoomAdmin && m.user_id !== user.id && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title={m.role === 'admin' ? 'Demote to member' : 'Make admin'}
                      onClick={async () => {
                        await fetch(apiUrl(`/api/chat/rooms/${activeRoom.id}/members/${m.user_id}`), {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ role: m.role === 'admin' ? 'member' : 'admin' })
                        });
                        fetchMembers(activeRoom.id);
                      }}
                      className="p-1 text-slate-400 hover:text-blue-600"
                    >
                      <Shield className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      onClick={async () => {
                        await fetch(apiUrl(`/api/chat/rooms/${activeRoom.id}/members/${m.user_id}`), {
                          method: 'DELETE',
                          headers: { Authorization: `Bearer ${token}` }
                        });
                        fetchMembers(activeRoom.id);
                      }}
                      className="p-1 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {activeRoom.type === 'community' && isRoomAdmin && (
              <button
                type="button"
                onClick={() => setShowLinkGroup(true)}
                className="w-full mt-2 px-4 py-2.5 flex items-center gap-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
              >
                <LinkIcon className="w-4 h-4" /> Link an existing group
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={async () => {
              if (!confirm('Leave this chat?')) return;
              await fetch(apiUrl(`/api/chat/rooms/${activeRoom.id}/members/${user.id}`), {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
              });
              setShowInfoPanel(false);
              setActiveRoomId(null);
              fetchRooms();
            }}
            className="p-4 border-t border-slate-100 flex items-center gap-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
          >
            <LogOut className="w-4 h-4" /> Leave {activeRoom.type === 'community' ? 'Community' : 'Group'}
          </button>
        </div>
      )}

      {/* New Chat / Group / Community modal */}
      {showNewChatModal && (
        <NewRoomModal
          type={showNewChatModal}
          directory={directory}
          onClose={() => setShowNewChatModal(null)}
          onCreate={createRoom}
        />
      )}

      {/* Add members modal (reuses NewRoomModal's picker in "pick only" mode) */}
      {showAddMembers && activeRoom && (
        <MemberPickerModal
          directory={directory.filter((d) => !members.some((m) => m.user_id === d.id))}
          title="Add Members"
          onClose={() => setShowAddMembers(false)}
          onConfirm={async (ids) => {
            await fetch(apiUrl(`/api/chat/rooms/${activeRoom.id}/members`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ userIds: ids })
            });
            setShowAddMembers(false);
            fetchMembers(activeRoom.id);
          }}
        />
      )}

      {/* Link an existing (admin-of-mine) group into this community */}
      {showLinkGroup && activeRoom && (
        <LinkGroupModal
          candidateGroups={rooms.filter((r) => r.type === 'group' && r.my_role === 'admin' && !r.parent_room_id && r.id !== activeRoom.id)}
          onClose={() => setShowLinkGroup(false)}
          onConfirm={async (groupRoomId) => {
            await fetch(apiUrl(`/api/chat/rooms/${activeRoom.id}/subgroups`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ groupRoomId })
            });
            setShowLinkGroup(false);
            fetchRooms();
          }}
        />
      )}
    </div>
  );
};

// Shared "pick people from the directory" list used by both the New Chat/
// Group/Community modal and the Add Members modal below.
const MemberPickerModal: React.FC<{
  directory: ChatDirectoryUser[];
  title: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (ids: number[]) => void;
}> = ({ directory, title, confirmLabel = 'Add', onClose, onConfirm }) => {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useBackButtonClose(true, onClose);

  const filtered = directory.filter((d) => d.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full md:w-96 md:rounded-2xl rounded-t-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3 border-b border-slate-100">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((d) => {
            const isSelected = selected.has(d.id);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(d.id)) next.delete(d.id);
                    else next.add(d.id);
                    return next;
                  })
                }
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: avatarColor(d.name) }}>
                  {initialsOf(d.name)}
                </div>
                <span className="flex-1 text-left text-sm text-slate-900 truncate">{d.name}</span>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300'}`}>
                  {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                </div>
              </button>
            );
          })}
        </div>
        <div className="p-3 border-t border-slate-100">
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
            className="w-full py-2.5 bg-emerald-600 text-white font-semibold rounded-xl disabled:opacity-40"
          >
            {confirmLabel} ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
};

const NewRoomModal: React.FC<{
  type: 'direct' | 'group' | 'community';
  directory: ChatDirectoryUser[];
  onClose: () => void;
  onCreate: (type: 'direct' | 'group' | 'community', title: string, memberIds: number[]) => void;
}> = ({ type, directory, onClose, onCreate }) => {
  const [title, setTitle] = useState('');
  const [step, setStep] = useState<'members' | 'details'>('members');
  const [pendingIds, setPendingIds] = useState<number[]>([]);

  if (type === 'direct') {
    return (
      <MemberPickerModal
        directory={directory}
        title="New Chat"
        confirmLabel="Start Chat"
        onClose={onClose}
        onConfirm={(ids) => ids[0] && onCreate('direct', '', [ids[0]])}
      />
    );
  }

  if (step === 'members') {
    return (
      <MemberPickerModal
        directory={directory}
        title={type === 'group' ? 'New Group: Add Members' : 'New Community: Add Members'}
        confirmLabel="Next"
        onClose={onClose}
        onConfirm={(ids) => {
          setPendingIds(ids);
          setStep('details');
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full md:w-96 md:rounded-2xl rounded-t-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-900 mb-3">{type === 'group' ? 'Name your Group' : 'Name your Community'}</h3>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={type === 'group' ? 'e.g. Finance Team' : 'e.g. Head Office'}
          autoFocus
          className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none mb-4"
        />
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 bg-slate-100 text-slate-700 font-semibold rounded-xl">
            Cancel
          </button>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={() => onCreate(type, title.trim(), pendingIds)}
            className="flex-1 py-2.5 bg-emerald-600 text-white font-semibold rounded-xl disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};

const LinkGroupModal: React.FC<{
  candidateGroups: ChatRoom[];
  onClose: () => void;
  onConfirm: (groupRoomId: number) => void;
}> = ({ candidateGroups, onClose, onConfirm }) => {
  useBackButtonClose(true, onClose);
  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full md:w-96 md:rounded-2xl rounded-t-2xl max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-900">Link an existing group</h3>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {candidateGroups.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-400">
              You need to be an admin of a standalone group (not already linked to a community) to attach it here.
            </div>
          )}
          {candidateGroups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onConfirm(g.id)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 text-left"
            >
              <Users className="w-5 h-5 text-slate-400" />
              <span className="text-sm text-slate-900">{g.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
