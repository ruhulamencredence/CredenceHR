/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat -> Group / Community info, the WhatsApp-style parts: the group photo,
// name and description (editing follows the group's "Edit group info"
// setting), the two admin settings, Mute notifications and Starred messages.
// Every change is checked again by the server (ChatRoutes.ts roomRules).

import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Camera, Check, Copy, Link as LinkIcon, Loader2, Pencil, RotateCcw, Share2, Shield, Star, Timer, Trash2, Users } from 'lucide-react';
import { MailPopup as Popup, inputCls, primaryBtn, ghostBtn, Toggle } from '../mail/MailPopup';
import { apiUrl } from '../../lib/api';
import { formatDate } from '../../lib/formatDate';
import type { ChatMessage, ChatRoom } from '../../types';

// ---- Group photo ------------------------------------------------------------
// One object URL per (room, photo version), shared by every place that shows it.
const photoUrls = new Map<string, Promise<string | null>>();
function groupPhotoUrl(token: string, roomId: number, version: number): Promise<string | null> {
  const key = `${roomId}:${version}`;
  let p = photoUrls.get(key);
  if (!p) {
    p = fetch(apiUrl(`/api/chat/rooms/${roomId}/avatar?v=${version}`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null);
    photoUrls.set(key, p);
  }
  return p;
}

export const GroupAvatar: React.FC<{ token: string; room: Pick<ChatRoom, 'id' | 'type' | 'has_avatar' | 'avatar_version'>; color: string; className?: string; iconClass?: string }> = ({
  token,
  room,
  color,
  className = 'w-12 h-12',
  iconClass = 'w-5 h-5'
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const has = !!Number(room.has_avatar);
  const v = Number(room.avatar_version || 0);
  useEffect(() => {
    let off = false;
    setUrl(null);
    if (has) groupPhotoUrl(token, room.id, v).then((u) => !off && setUrl(u));
    return () => {
      off = true;
    };
  }, [token, room.id, has, v]);
  return url ? (
    <img src={url} alt="" className={`${className} rounded-full object-cover shrink-0`} />
  ) : (
    <div className={`${className} rounded-full flex items-center justify-center text-white shrink-0`} style={{ background: color }}>
      {room.type === 'community' ? <Shield className={iconClass} /> : <Users className={iconClass} />}
    </div>
  );
};

// A picked picture, made square-ish and at most 640 px, as JPEG.
async function shrinkPhoto(file: File): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file is not a picture.'));
    i.src = URL.createObjectURL(file);
  });
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const out = Math.min(640, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the picture.');
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
  URL.revokeObjectURL(img.src);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture.'))), 'image/jpeg', 0.86));
}

const send = async (token: string, path: string, method: string, body?: any, raw?: Blob) => {
  const res = await fetch(apiUrl(path), {
    method,
    headers: raw ? { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: raw || (body ? JSON.stringify(body) : undefined)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

// ---- Photo + name + description at the top of Group info --------------------
export const GroupHeader: React.FC<{
  token: string;
  room: ChatRoom;
  color: string;
  memberCount: number;
  canEditInfo: boolean;
  description: string;
  createdBy?: string | null;
  createdAt?: string;
  onChanged: () => void;
  confirm: (m: string) => Promise<boolean>;
}> = ({ token, room, color, memberCount, canEditInfo, description, createdBy, createdAt, onChanged, confirm }) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<'title' | 'description' | null>(null);
  const [draft, setDraft] = useState('');
  const kind = room.type === 'community' ? 'Community' : 'Group';
  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      onChanged();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="p-5 text-center">
      <div className="relative w-24 h-24 mx-auto mb-3">
        <GroupAvatar token={token} room={room} color={color} className="w-24 h-24" iconClass="w-9 h-9" />
        {canEditInfo && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
            className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-violet-600 text-white flex items-center justify-center border-2 border-white shadow disabled:opacity-60"
            title="Change group photo"
            aria-label="Change group photo"
          >
            {busy === 'photo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void run('photo', async () => send(token, `/api/chat/rooms/${room.id}/avatar`, 'PUT', undefined, await shrinkPhoto(f)));
          }}
        />
      </div>
      {canEditInfo && !!Number(room.has_avatar) && (
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            if (await confirm(`Remove the ${kind.toLowerCase()} photo?`)) void run('photo', () => send(token, `/api/chat/rooms/${room.id}/avatar`, 'DELETE'));
          }}
          className="text-[11px] text-rose-600 hover:underline mb-2 inline-flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" /> Remove photo
        </button>
      )}

      {editing === 'title' ? (
        <div className="flex items-center gap-2 max-w-xs mx-auto">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={150} autoFocus className={inputCls} aria-label={`${kind} name`} />
          <button
            type="button"
            disabled={!!busy || !draft.trim()}
            onClick={async () => {
              if (await run('title', () => send(token, `/api/chat/rooms/${room.id}`, 'PATCH', { title: draft }))) setEditing(null);
            }}
            className="w-9 h-9 shrink-0 rounded-full bg-violet-600 text-white flex items-center justify-center disabled:opacity-50"
            aria-label="Save name"
          >
            {busy === 'title' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1.5">
          <div className="font-semibold text-lg text-slate-900">{room.title || kind}</div>
          {canEditInfo && (
            <button type="button" onClick={() => { setDraft(room.title || ''); setEditing('title'); }} className="p-1 text-slate-400 hover:text-violet-600" aria-label={`Edit ${kind} name`} title="Edit name">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      <div className="text-xs text-slate-400">
        {kind} · {memberCount} members
      </div>

      <div className="mt-3 text-left">
        {editing === 'description' ? (
          <div className="space-y-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} rows={4} autoFocus className={inputCls} placeholder={`Add a ${kind.toLowerCase()} description`} aria-label={`${kind} description`} />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400">{draft.length}/1000</span>
              <div className="flex gap-2">
                <button type="button" className={ghostBtn} onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  className={primaryBtn}
                  onClick={async () => {
                    if (await run('description', () => send(token, `/api/chat/rooms/${room.id}`, 'PATCH', { description: draft }))) setEditing(null);
                  }}
                >
                  {busy === 'description' && <Loader2 className="w-4 h-4 animate-spin" />} Save
                </button>
              </div>
            </div>
          </div>
        ) : description ? (
          <button
            type="button"
            disabled={!canEditInfo}
            onClick={() => { setDraft(description); setEditing('description'); }}
            className="w-full text-left rounded-xl px-3 py-2 hover:bg-slate-50 disabled:hover:bg-transparent"
          >
            <div className="text-[11px] font-semibold uppercase text-slate-400 flex items-center gap-1">Description {canEditInfo && <Pencil className="w-3 h-3" />}</div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{description}</p>
          </button>
        ) : canEditInfo ? (
          <button type="button" onClick={() => { setDraft(''); setEditing('description'); }} className="w-full text-left rounded-xl px-3 py-2 text-sm text-violet-600 hover:bg-violet-50">
            + Add {kind.toLowerCase()} description
          </button>
        ) : null}
        {(createdBy || createdAt) && (
          <p className="px-3 mt-1 text-[11px] text-slate-400">
            Created{createdBy ? ` by ${createdBy}` : ''}
            {createdAt ? `, ${formatDate(createdAt)}` : ''}
          </p>
        )}
      </div>
      {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 text-left">{error}</div>}
    </div>
  );
};

// ---- Group settings (admins) ---------------------------------------------------
export const GroupSettings: React.FC<{ token: string; roomId: number; infoAdminsOnly: boolean; sendAdminsOnly: boolean; onChanged: () => void }> = ({
  token,
  roomId,
  infoAdminsOnly,
  sendAdminsOnly,
  onChanged
}) => {
  const [error, setError] = useState('');
  const set = async (body: any) => {
    setError('');
    try {
      await send(token, `/api/chat/rooms/${roomId}`, 'PATCH', body);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-xs font-semibold uppercase text-slate-400">Group settings</div>
      <Toggle checked={infoAdminsOnly} onChange={(v) => void set({ info_admins_only: v })} label="Only admins can edit group info" hint="Name, photo and description" />
      <Toggle checked={sendAdminsOnly} onChange={(v) => void set({ send_admins_only: v })} label="Only admins can send messages" hint="Members can still read and react" />
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
    </div>
  );
};

// ---- Mute notifications --------------------------------------------------------
export const isMuted = (r?: Pick<ChatRoom, 'muted_until'> | null) => !!r?.muted_until && new Date(String(r.muted_until).replace(' ', 'T')).getTime() > Date.now();
const mutedLabel = (until: string) => {
  const d = new Date(String(until).replace(' ', 'T'));
  if (d.getFullYear() >= 9000) return 'Muted always';
  return `Muted until ${formatDate(until)} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

export const MuteRow: React.FC<{ token: string; room: ChatRoom; onChanged: () => void }> = ({ token, room, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<'8h' | '1w' | 'always'>('8h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const muted = isMuted(room);
  const save = async (key: string) => {
    setBusy(true);
    setError('');
    try {
      await send(token, `/api/chat/rooms/${room.id}/mute`, 'PUT', { for: key });
      onChanged();
      setOpen(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => (muted ? void save('off') : setOpen(true))}
        disabled={busy}
        className="w-full px-4 py-3 flex items-center gap-3 text-sm text-slate-800 hover:bg-slate-50 text-left"
      >
        {muted ? <BellOff className="w-4 h-4 text-slate-500" /> : <Bell className="w-4 h-4 text-slate-500" />}
        <span className="flex-1">
          {muted ? 'Unmute notifications' : 'Mute notifications'}
          {muted && <span className="block text-[11px] text-slate-400">{mutedLabel(String(room.muted_until))}</span>}
        </span>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
      </button>
      {error && !open && <div className="mx-4 mb-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {open && (
        <Popup
          title="Mute notifications"
          icon={<BellOff className="w-4 h-4" />}
          size="md"
          onClose={() => !busy && setOpen(false)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={() => void save(choice)} disabled={busy}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Mute
              </button>
            </>
          }
        >
          <p className="text-xs text-slate-500 mb-3">You won't get notifications for this chat. Its messages still arrive and show as unread here.</p>
          <div className="liquid-glass-inset rounded-[20px] overflow-hidden divide-y divide-slate-200/60">
            {(
              [
                ['8h', '8 hours'],
                ['1w', '1 week'],
                ['always', 'Always']
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-3 px-4 py-3 text-sm cursor-pointer">
                <input type="radio" name="mute-for" checked={choice === k} onChange={() => setChoice(k)} className="accent-violet-600" />
                {label}
              </label>
            ))}
          </div>
          {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </Popup>
      )}
    </>
  );
};

// ---- Starred messages ------------------------------------------------------------
const starPreview = (m: ChatMessage) =>
  m.content || (m.message_type === 'image' ? '📷 Photo' : m.message_type === 'audio' ? '🎤 Voice message' : `📎 ${m.attachment_filename || 'File'}`);

export const StarredPopup: React.FC<{ token: string; roomId?: number | null; meId: number; roomName?: (roomId: number) => string; onClose: () => void; onOpen: (m: ChatMessage) => void }> = ({
  token,
  roomId,
  meId,
  roomName,
  onClose,
  onOpen
}) => {
  const [rows, setRows] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    fetch(apiUrl(`/api/chat/starred${roomId ? `?roomId=${roomId}` : ''}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Could not load starred messages');
        setRows(Array.isArray(d) ? d : []);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, roomId]);
  return (
    <Popup title="Starred messages" icon={<Star className="w-4 h-4" />} size="md" onClose={onClose}>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-2">{error}</div>}
      {rows === null && !error ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          <Star className="w-8 h-8 mx-auto mb-2 text-slate-300" />
          No starred messages. Tap and hold a message, then Star, to find it here later.
        </div>
      ) : (
        <div className="liquid-glass-inset rounded-[20px] overflow-hidden divide-y divide-slate-200/60 max-h-[60vh] overflow-y-auto">
          {(rows || []).map((m) => (
            <div key={m.id} className="flex items-start gap-2 px-3 py-2.5">
              <button type="button" onClick={() => onOpen(m)} className="flex-1 min-w-0 text-left">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span className="font-semibold text-slate-700 truncate">
                    {m.sender_id === meId ? 'You' : m.sender_name}
                    {!roomId && roomName ? ` · ${roomName(m.room_id)}` : ''}
                  </span>
                  <span className="shrink-0">{formatDate(m.created_at)}</span>
                </div>
                <p className="text-sm text-slate-800 line-clamp-3 break-words">{starPreview(m)}</p>
              </button>
              <button
                type="button"
                title="Unstar"
                aria-label="Unstar"
                onClick={async () => {
                  try {
                    await send(token, `/api/chat/messages/${m.id}/star`, 'POST', { starred: false });
                    setRows((prev) => (prev || []).filter((x) => x.id !== m.id));
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
                className="p-1.5 text-amber-500 hover:text-slate-400"
              >
                <Star className="w-4 h-4 fill-current" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Popup>
  );
};

// ---- Disappearing messages ----------------------------------------------------
const DISAPPEAR_OPTIONS: [number, string][] = [
  [0, 'Off'],
  [86400, '24 hours'],
  [604800, '7 days'],
  [7776000, '90 days']
];
export const disappearLabel = (secs?: number) => (DISAPPEAR_OPTIONS.find(([s]) => s === Number(secs || 0)) || DISAPPEAR_OPTIONS[0])[1];

export const DisappearRow: React.FC<{ token: string; roomId: number; value: number; canEdit: boolean; onChanged: () => void }> = ({ token, roomId, value, canEdit, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => {
          setChoice(value);
          setError('');
          setOpen(true);
        }}
        className="w-full px-4 py-3 flex items-center gap-3 text-sm text-slate-800 hover:bg-slate-50 disabled:hover:bg-transparent text-left"
      >
        <Timer className="w-4 h-4 text-slate-500" />
        <span className="flex-1">
          Disappearing messages
          <span className="block text-[11px] text-slate-400">{disappearLabel(value)}{!canEdit ? ' · only admins can change it' : ''}</span>
        </span>
      </button>
      {open && (
        <Popup
          title="Disappearing messages"
          icon={<Timer className="w-4 h-4" />}
          size="md"
          onClose={() => !busy && setOpen(false)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className={primaryBtn}
                disabled={busy || choice === value}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await send(token, `/api/chat/rooms/${roomId}`, 'PATCH', { disappear_seconds: choice });
                    onChanged();
                    setOpen(false);
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </>
          }
        >
          <p className="text-xs text-slate-500 mb-3">New messages in this chat will disappear for everyone after the time you choose. Messages sent before this stay.</p>
          <div className="liquid-glass-inset rounded-[20px] overflow-hidden divide-y divide-slate-200/60">
            {DISAPPEAR_OPTIONS.map(([secs, label]) => (
              <label key={secs} className="flex items-center gap-3 px-4 py-3 text-sm cursor-pointer">
                <input type="radio" name="disappear" checked={choice === secs} onChange={() => setChoice(secs)} className="accent-violet-600" />
                {label}
              </label>
            ))}
          </div>
          {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </Popup>
      )}
    </>
  );
};

// ---- Invite link (group admins) ---------------------------------------------------
export const inviteUrl = (code: string) => `${window.location.origin}/chat?invite=${encodeURIComponent(code)}`;
// A pasted link or a bare code -> the code.
export const inviteCodeFrom = (text: string): string | null => {
  const t = text.trim();
  const m = t.match(/[?&]invite=([A-Za-z0-9_-]{10,40})/) || t.match(/^([A-Za-z0-9_-]{10,40})$/);
  return m ? m[1] : null;
};

export const InviteLinkRow: React.FC<{ token: string; roomId: number; code: string | null | undefined; onChanged: () => void; confirm: (m: string) => Promise<boolean> }> = ({
  token,
  roomId,
  code,
  onChanged,
  confirm
}) => {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(code || null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setCurrent(code || null), [code]);
  const make = async (reset = false) => {
    setBusy(reset ? 'reset' : 'make');
    setError('');
    try {
      const d = await send(token, `/api/chat/rooms/${roomId}/invite`, 'POST', { reset });
      setCurrent(d.code);
      onChanged();
      if (reset) setNote('A new link was made. The old one no longer works.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const link = current ? inviteUrl(current) : '';
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNote('');
          setOpen(true);
          if (!current) void make();
        }}
        className="w-full px-4 py-3 flex items-center gap-3 text-sm text-slate-800 hover:bg-slate-50 text-left"
      >
        <LinkIcon className="w-4 h-4 text-slate-500" />
        <span className="flex-1">Invite via link</span>
      </button>
      {open && (
        <Popup title="Invite via link" icon={<LinkIcon className="w-4 h-4" />} size="md" onClose={() => !busy && setOpen(false)}>
          <p className="text-xs text-slate-500 mb-3">Anyone in the company who has Chat and this link can join the group. Only share it with people you trust.</p>
          <div className="liquid-glass-inset rounded-[20px] px-3 py-2.5 text-xs text-slate-700 break-all min-h-[40px]">{busy === 'make' ? 'Making the link…' : link || '—'}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!link}
              className={primaryBtn}
              onClick={async () => {
                try {
                  if ((navigator as any).share) await (navigator as any).share({ title: 'Join my group on CredenceHR', url: link });
                  else {
                    await navigator.clipboard.writeText(link);
                    setNote('Link copied.');
                  }
                } catch {
                  // share sheet closed
                }
              }}
            >
              <Share2 className="w-4 h-4" /> Share
            </button>
            <button
              type="button"
              disabled={!link}
              className={ghostBtn}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setNote('Link copied.');
                } catch {
                  setNote('Copy it from the box above.');
                }
              }}
            >
              <Copy className="w-4 h-4 inline mr-1" /> Copy
            </button>
            <button
              type="button"
              disabled={!!busy || !link}
              className={ghostBtn}
              onClick={async () => {
                if (await confirm('Reset the invite link? The current link stops working.')) void make(true);
              }}
            >
              {busy === 'reset' ? <Loader2 className="w-4 h-4 inline animate-spin" /> : <RotateCcw className="w-4 h-4 inline mr-1" />} Reset link
            </button>
            <button
              type="button"
              disabled={!!busy || !link}
              className={`${ghostBtn} text-rose-600`}
              onClick={async () => {
                if (!(await confirm('Turn off the invite link? Nobody can join with it any more.'))) return;
                setBusy('off');
                try {
                  await send(token, `/api/chat/rooms/${roomId}/invite`, 'DELETE');
                  setCurrent(null);
                  onChanged();
                  setOpen(false);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy('');
                }
              }}
            >
              Turn off
            </button>
          </div>
          {note && <div className="mt-2 text-xs text-emerald-700">{note}</div>}
          {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </Popup>
      )}
    </>
  );
};

// ---- Join with an invite link ---------------------------------------------------------
export const JoinInvitePopup: React.FC<{ token: string; initialCode?: string | null; onClose: () => void; onJoined: (roomId: number) => void }> = ({ token, initialCode, onClose, onJoined }) => {
  const [text, setText] = useState(initialCode || '');
  const [preview, setPreview] = useState<{ id: number; title: string; type: string; description: string; member_count: number; already_member: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const code = inviteCodeFrom(text);
  useEffect(() => {
    setPreview(null);
    setError('');
    if (!code) return;
    let off = false;
    fetch(apiUrl(`/api/chat/invite/${code}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (off) return;
        if (!r.ok) setError(d.error || 'This invite link is not valid.');
        else setPreview(d);
      })
      .catch(() => !off && setError("Couldn't reach the server."));
    return () => {
      off = true;
    };
  }, [token, code]);
  return (
    <Popup
      title="Join a group"
      icon={<LinkIcon className="w-4 h-4" />}
      size="md"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn}
            disabled={busy || !preview}
            onClick={async () => {
              if (!preview || !code) return;
              if (preview.already_member) return onJoined(preview.id);
              setBusy(true);
              setError('');
              try {
                const d = await send(token, `/api/chat/invite/${code}/join`, 'POST');
                onJoined(Number(d.id));
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {preview?.already_member ? 'Open group' : 'Join group'}
          </button>
        </>
      }
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the invite link" aria-label="Invite link" className={inputCls} autoFocus={!initialCode} />
      {preview && (
        <div className="mt-3 liquid-glass-inset rounded-[20px] px-4 py-3">
          <div className="font-semibold text-slate-900">{preview.title}</div>
          <div className="text-xs text-slate-500">
            {preview.type === 'community' ? 'Community' : 'Group'} · {preview.member_count} members{preview.already_member ? ' · you are already in it' : ''}
          </div>
          {preview.description && <p className="mt-1 text-xs text-slate-600 whitespace-pre-wrap line-clamp-4">{preview.description}</p>}
        </div>
      )}
      {error && <div className="mt-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
    </Popup>
  );
};
