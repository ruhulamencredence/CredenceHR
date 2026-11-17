/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The chat list, each account's own (like WhatsApp): a chat's menu — the ⌄
// on a row (computer) or holding a row (phone) — with Archive, Pin, Mark as
// unread, Favorites, Add to list, Clear chat and Delete chat (Exit group for
// a group), and the filter chips above the list (All, Unread, Favorites and
// the account's own lists). Server: ChatRoutes.ts — PUT /api/chat/rooms/:id/prefs,
// POST /api/chat/rooms/:id/delete-for-me, /api/chat/lists…. Nothing here
// changes anything for the other people in a chat.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Pin, PinOff, MailOpen, Mail, Heart, HeartOff, ListPlus, Eraser, Trash2, LogOut, ChevronRight, Check, Plus, X } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { confirmDialog } from '../../lib/confirmDialog';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import type { ChatRoom } from '../../types';

export interface ChatList {
  id: number;
  name: string;
}

export type ChatChip = 'all' | 'unread' | 'favorites' | `list:${number}`;

export const MAX_PINS = 3;

const call = async (token: string, path: string, method: string, body?: any) => {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Something went wrong — try again.');
  return data;
};

// The account's own lists.
export function useChatLists(token: string) {
  const [lists, setLists] = useState<ChatList[]>([]);
  const load = async () => {
    try {
      const d = await call(token, '/api/chat/lists', 'GET');
      setLists(Array.isArray(d) ? d : []);
    } catch {
      // Chat off or offline: no lists
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const create = async (name: string): Promise<ChatList> => {
    const l = await call(token, '/api/chat/lists', 'POST', { name });
    setLists((x) => [...x, l].sort((a, b) => a.name.localeCompare(b.name)));
    return l;
  };
  const remove = async (id: number) => {
    await call(token, `/api/chat/lists/${id}`, 'DELETE');
    setLists((x) => x.filter((l) => l.id !== id));
  };
  return { lists, create, remove, reload: load };
}

// Unread here means real unread messages or "Mark as unread".
export const isUnread = (r: ChatRoom) => r.unread_count > 0 || !!r.marked_unread;

export const chipMatches = (r: ChatRoom, chip: ChatChip) =>
  chip === 'all' ? true : chip === 'unread' ? isUnread(r) : chip === 'favorites' ? !!r.favorite : (r.list_ids || []).includes(Number(chip.slice(5)));

// Filter chips above the list: All · Unread · Favorites · own lists · + List.
export const ChatListChips: React.FC<{
  chip: ChatChip;
  setChip: (c: ChatChip) => void;
  rooms: ChatRoom[];
  lists: ChatList[];
  onCreate: (name: string) => Promise<ChatList>;
  onRemove: (id: number) => Promise<void>;
}> = ({ chip, setChip, rooms, lists, onCreate, onRemove }) => {
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const unread = rooms.filter((r) => !r.archived && isUnread(r)).length;
  const base = 'shrink-0 px-3 py-1 rounded-full text-xs font-semibold border transition-colors';
  const on = (x: boolean) => (x ? 'border-transparent text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50');
  const accent = (x: boolean) => (x ? { background: 'var(--g-accent, #7f00ff)' } : undefined);
  const save = async () => {
    const name = (adding || '').trim();
    if (!name) return setAdding(null);
    try {
      const l = await onCreate(name);
      setAdding(null);
      setErr('');
      setChip(`list:${l.id}`);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {([['all', 'All'], ['unread', unread ? `Unread ${unread}` : 'Unread'], ['favorites', 'Favorites']] as [ChatChip, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setChip(k)} aria-pressed={chip === k} className={`${base} ${on(chip === k)}`} style={accent(chip === k)}>
            {label}
          </button>
        ))}
        {lists.map((l) => {
          const k = `list:${l.id}` as ChatChip;
          const x = chip === k;
          return (
            <span key={l.id} className={`${base} ${on(x)} inline-flex items-center gap-1`} style={accent(x)}>
              <button type="button" onClick={() => setChip(k)} aria-pressed={x}>
                {l.name}
              </button>
              {x && (
                <button
                  type="button"
                  aria-label={`Delete the list ${l.name}`}
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete the list "${l.name}"? The chats stay; only the list goes.`, { confirmLabel: 'Delete', tone: 'danger' }))) return;
                    await onRemove(l.id).catch(() => {});
                    setChip('all');
                  }}
                  className="-mr-1 p-0.5 rounded-full hover:bg-white/20"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          );
        })}
        {adding === null ? (
          <button type="button" onClick={() => { setAdding(''); setErr(''); }} className={`${base} border-dashed bg-white border-slate-300 text-slate-500 inline-flex items-center gap-1`}>
            <Plus className="w-3 h-3" /> List
          </button>
        ) : (
          <input
            autoFocus
            value={adding}
            maxLength={40}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') setAdding(null);
            }}
            onBlur={() => void save()}
            placeholder="List name"
            aria-label="New list name"
            className="shrink-0 w-28 px-2.5 py-1 rounded-full text-xs border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        )}
      </div>
      {err && <p className="mt-1 text-[11px] text-rose-600">{err}</p>}
    </div>
  );
};

// The menu for one chat: a small glass card next to the ⌄ (computer), or a
// glass sheet from the bottom (phone, `anchor` null).
export const ChatRoomMenu: React.FC<{
  token: string;
  room: ChatRoom;
  roomName: string;
  anchor: DOMRect | null;
  pinnedCount: number;
  lists: ChatList[];
  onCreateList: (name: string) => Promise<ChatList>;
  onClose: () => void;
  // After any change: reload the rooms.
  onChanged: () => void;
  // Delete / Exit took the chat away from the screen.
  onGone: (roomId: number) => void;
  // Clear chat emptied it (starred messages stay).
  onCleared: (roomId: number) => void;
  userId: number;
}> = ({ token, room, roomName, anchor, pinnedCount, lists, onCreateList, onClose, onChanged, onGone, onCleared, userId }) => {
  const [showLists, setShowLists] = useState(false);
  const [newList, setNewList] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [inLists, setInLists] = useState<number[]>(room.list_ids || []);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useBackButtonClose(true, onClose);
  // Lifting the finger after the hold sends a tap that lands on the sheet's
  // backdrop — that one mustn't close it.
  const openedAt = useRef(Date.now());
  const outside = (e: React.MouseEvent) => e.target === e.currentTarget && Date.now() - openedAt.current > 450 && onClose();

  // Computer: keep the card on screen next to the ⌄.
  useLayoutEffect(() => {
    if (!anchor || !cardRef.current) return;
    const w = cardRef.current.offsetWidth;
    const h = cardRef.current.offsetHeight;
    const left = Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8));
    const below = anchor.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 6) : below;
    setPos({ left, top });
  }, [anchor, showLists, newList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const prefs = async (body: any) => {
    try {
      await call(token, `/api/chat/rooms/${room.id}/prefs`, 'PUT', body);
      onChanged();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const toggleList = async (id: number) => {
    const isIn = inLists.includes(id);
    try {
      await call(token, `/api/chat/lists/${id}/rooms/${room.id}`, isIn ? 'DELETE' : 'PUT');
      setInLists((x) => (isIn ? x.filter((y) => y !== id) : [...x, id]));
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const addNewList = async () => {
    const name = (newList || '').trim();
    if (!name) return setNewList(null);
    try {
      const l = await onCreateList(name);
      await call(token, `/api/chat/lists/${l.id}/rooms/${room.id}`, 'PUT');
      setInLists((x) => [...x, l.id]);
      setNewList(null);
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const clear = async () => {
    onClose();
    if (!(await confirmDialog(`Clear "${roomName}"? Its messages are removed for you only (starred ones are kept). Others still see them.`, { confirmLabel: 'Clear chat', tone: 'danger' }))) return;
    await call(token, `/api/chat/rooms/${room.id}/clear`, 'POST', { keepStarred: true }).catch(() => {});
    onCleared(room.id);
    onChanged();
  };
  const remove = async () => {
    onClose();
    if (!(await confirmDialog(`Delete the chat with ${roomName}? Its messages are removed for you only; ${roomName} still sees them. A new message brings the chat back.`, { confirmLabel: 'Delete chat', tone: 'danger' }))) return;
    await call(token, `/api/chat/rooms/${room.id}/delete-for-me`, 'POST').catch(() => {});
    onGone(room.id);
    onChanged();
  };
  const exit = async () => {
    onClose();
    if (!(await confirmDialog(`Exit "${roomName}"? You stop getting its messages and it leaves your list.`, { confirmLabel: 'Exit group', tone: 'danger' }))) return;
    await call(token, `/api/chat/rooms/${room.id}/members/${userId}`, 'DELETE').catch(() => {});
    onGone(room.id);
    onChanged();
  };

  const pinFull = !room.pinned && pinnedCount >= MAX_PINS;
  const item = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-left text-slate-800 hover:bg-white/60 disabled:opacity-40';
  const red = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-left text-rose-600 hover:bg-rose-50/70';
  const ic = 'w-4 h-4 text-slate-500 shrink-0';

  const body = (
    <>
      {!showLists ? (
        <>
          <button type="button" className={item} onClick={() => prefs({ archived: !room.archived })}>
            {room.archived ? <ArchiveRestore className={ic} /> : <Archive className={ic} />} {room.archived ? 'Unarchive chat' : 'Archive chat'}
          </button>
          {!room.archived && (
            <button type="button" className={item} disabled={pinFull} title={pinFull ? `You can pin up to ${MAX_PINS} chats` : undefined} onClick={() => prefs({ pinned: !room.pinned })}>
              {room.pinned ? <PinOff className={ic} /> : <Pin className={ic} />} {room.pinned ? 'Unpin chat' : pinFull ? `Pin chat (${MAX_PINS} pinned)` : 'Pin chat'}
            </button>
          )}
          <button type="button" className={item} onClick={() => prefs({ marked_unread: !isUnread(room) })}>
            {isUnread(room) ? <MailOpen className={ic} /> : <Mail className={ic} />} {isUnread(room) ? 'Mark as read' : 'Mark as unread'}
          </button>
          <button type="button" className={item} onClick={() => prefs({ favorite: !room.favorite })}>
            {room.favorite ? <HeartOff className={ic} /> : <Heart className={ic} />} {room.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
          </button>
          <button type="button" className={item} onClick={() => setShowLists(true)}>
            <ListPlus className={ic} /> <span className="flex-1">Add to list</span> <ChevronRight className="w-4 h-4 text-slate-400" />
          </button>
          <div className="my-1 h-px bg-slate-200/70" />
          <button type="button" className={red} onClick={clear}>
            <Eraser className="w-4 h-4 shrink-0" /> Clear chat
          </button>
          {room.type === 'direct' ? (
            <button type="button" className={red} onClick={remove}>
              <Trash2 className="w-4 h-4 shrink-0" /> Delete chat
            </button>
          ) : (
            <button type="button" className={red} onClick={exit}>
              <LogOut className="w-4 h-4 shrink-0" /> Exit {room.type === 'community' ? 'community' : 'group'}
            </button>
          )}
        </>
      ) : (
        <>
          <button type="button" className={`${item} font-semibold`} onClick={() => setShowLists(false)}>
            <ChevronRight className="w-4 h-4 text-slate-400 rotate-180" /> Add to list
          </button>
          {lists.length === 0 && newList === null && <p className="px-3 py-1.5 text-xs text-slate-500">No lists yet — make one below.</p>}
          {lists.map((l) => {
            const x = inLists.includes(l.id);
            return (
              <button key={l.id} type="button" className={item} onClick={() => toggleList(l.id)} aria-pressed={x}>
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${x ? 'border-transparent text-white' : 'border-slate-400'}`} style={x ? { background: 'var(--g-accent, #7f00ff)' } : undefined}>
                  {x && <Check className="w-3 h-3" />}
                </span>
                {l.name}
              </button>
            );
          })}
          <div className="my-1 h-px bg-slate-200/70" />
          {newList === null ? (
            <button type="button" className={`${item} font-semibold`} style={{ color: 'var(--g-accent, #7f00ff)' }} onClick={() => setNewList('')}>
              <Plus className="w-4 h-4 shrink-0" /> New list
            </button>
          ) : (
            <div className="px-2 py-1.5 flex gap-2">
              <input
                autoFocus
                value={newList}
                maxLength={40}
                onChange={(e) => setNewList(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addNewList()}
                placeholder="List name"
                aria-label="New list name"
                className="flex-1 min-w-0 px-3 py-1.5 rounded-full text-sm border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button type="button" onClick={() => void addNewList()} className="liquid-glass-button rounded-full px-3 text-xs font-semibold">
                Add
              </button>
            </div>
          )}
        </>
      )}
      {err && <p className="px-3 pt-1 text-xs text-rose-600">{err}</p>}
    </>
  );

  return createPortal(
    anchor ? (
      // Computer: a small card next to the ⌄; a click outside closes it.
      <div className="fixed inset-0 z-[200]" onMouseDown={outside}>
        <div ref={cardRef} className="fixed w-60" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
          <div role="menu" aria-label={`${roomName} — chat options`} className="liquid-glass liquid-glass-in rounded-[22px] p-1.5">
            {body}
          </div>
        </div>
      </div>
    ) : (
      // Phone: the same choices as a sheet from the bottom.
      <div className="fixed inset-0 z-[200] liquid-glass-backdrop flex items-end justify-center p-2" onClick={outside}>
        <div className="w-full max-w-md" style={{ paddingBottom: 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))' }}>
          <div role="menu" aria-label={`${roomName} — chat options`} className="liquid-glass liquid-glass-in rounded-[28px] p-2 max-h-[80dvh] overflow-y-auto">
            <div className="w-9 h-1 rounded-full bg-slate-300 mx-auto mt-1 mb-2" />
            <p className="px-3 pb-2 text-sm font-bold text-slate-900 truncate">{roomName}</p>
            {body}
          </div>
        </div>
      </div>
    ),
    document.body
  );
};
