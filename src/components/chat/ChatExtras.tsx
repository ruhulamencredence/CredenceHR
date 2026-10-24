/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// WhatsApp-style pieces of Chat (ChatPanel.tsx), kept apart so ChatPanel
// doesn't grow further. Backend: ChatRoutes.ts ("WhatsApp-style message
// actions").
//   - Conversation wallpapers (per chat, or a default for every chat).
//   - The message menu (long-press on a phone, the ⌄ button on a computer):
//     quick reactions, Reply, Copy, Delete for me, Delete for everyone.
//   - Reaction chips under a bubble, and who reacted.
//   - Chat profile sections: About, work details, shared media, common
//     groups, the wallpaper picker; and editing one's own About.

import React, { useEffect, useState } from 'react';
import { Reply, Copy, Trash2, Ban, Smile, Loader2, Image as ImageIcon, FileText, Mic, Users, Shield, Mail, Phone, Briefcase, Building2, IdCard, Pencil } from 'lucide-react';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from '../mail/MailPopup';
import { apiUrl } from '../../lib/api';
import { formatDate } from '../../lib/formatDate';
import { CHAT_CONVERSATION_BACKGROUND } from '../../lib/backgroundTheme';
import type { ChatMessage, ChatReaction } from '../../types';

// ---- Wallpapers ---------------------------------------------------------------
// A light doodle tile (chat bubbles, a pencil, a hard hat, stars) like
// WhatsApp's default pattern, in a soft grey on beige.
const DOODLE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140' viewBox='0 0 140 140'%3E%3Cg fill='none' stroke='%23d6cfc4' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 18h28a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H26l-8 7v-7h-4a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z'/%3E%3Cpath d='M92 12l14 14-26 26H66V38z'/%3E%3Cpath d='M20 96a22 22 0 0 1 44 0z M16 96h52 M42 74v-6'/%3E%3Cpath d='M104 80l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z'/%3E%3Ccircle cx='112' cy='126' r='5'/%3E%3Ccircle cx='70' cy='126' r='2'/%3E%3Cpath d='M118 40c6 0 10 4 10 10'/%3E%3C/g%3E%3C/svg%3E\")";

export const CHAT_WALLPAPERS: { id: string; label: string; css: string; swatch: string }[] = [
  {
    // The look Chat always had: Frosted Glass under a soft lavender wash.
    id: 'frosted',
    label: 'Frosted',
    swatch: '#ece6fb',
    css: `radial-gradient(ellipse 60% 50% at 0% 0%, rgba(196,170,255,0.22), transparent 65%), radial-gradient(ellipse 60% 45% at 100% 100%, rgba(232,206,255,0.3), transparent 65%), linear-gradient(180deg, rgba(253,252,255,0.86), rgba(245,240,255,0.86)), ${CHAT_CONVERSATION_BACKGROUND}`
  },
  { id: 'doodle', label: 'Doodle', swatch: '#efeae2', css: `${DOODLE} 0 0 / 140px 140px repeat, #efeae2` },
  { id: 'plain', label: 'Plain', swatch: '#f4f4f5', css: '#f4f4f5' },
  { id: 'mint', label: 'Mint', swatch: '#dff3ea', css: 'linear-gradient(180deg, #eaf8f1 0%, #d9f0e5 100%)' },
  { id: 'sky', label: 'Sky', swatch: '#dcecfb', css: 'linear-gradient(180deg, #edf5fd 0%, #d8e9fa 100%)' },
  { id: 'blush', label: 'Blush', swatch: '#fbe3e8', css: 'linear-gradient(180deg, #fdf0f2 0%, #f8dfe5 100%)' },
  { id: 'lavender', label: 'Lavender', swatch: '#e8e1fb', css: 'linear-gradient(180deg, #f4f0fe 0%, #e5ddfa 100%)' },
  { id: 'sand', label: 'Sand', swatch: '#f3ead9', css: 'linear-gradient(180deg, #faf5ea 0%, #efe4cf 100%)' },
  { id: 'slate', label: 'Slate', swatch: '#dfe5ec', css: 'linear-gradient(180deg, #eef2f6 0%, #dbe2ea 100%)' }
];
export const wallpaperCss = (id?: string | null) => (CHAT_WALLPAPERS.find((w) => w.id === id) || CHAT_WALLPAPERS[0]).css;

export const WallpaperPicker: React.FC<{ token: string; roomId: number; current?: string | null; onChanged: () => void }> = ({ token, roomId, current, onChanged }) => {
  const [forAll, setForAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = async (id: string) => {
    setBusy(true);
    try {
      await fetch(apiUrl(`/api/chat/rooms/${roomId}/wallpaper`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wallpaper: id, forAll })
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const on = current || 'frosted';
  return (
    <div className="px-4 py-3">
      <div className="text-xs font-semibold uppercase text-slate-400 mb-2 flex items-center gap-2">
        Chat wallpaper {busy && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {CHAT_WALLPAPERS.map((w) => (
          <button
            key={w.id}
            type="button"
            disabled={busy}
            onClick={() => void pick(w.id)}
            title={w.label}
            className={`h-14 rounded-xl border ${on === w.id ? 'ring-2 ring-offset-1 ring-violet-500 border-transparent' : 'border-slate-200'}`}
            style={{ background: w.css }}
            aria-label={`${w.label} wallpaper`}
          />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} /> Use for all my chats
      </label>
    </div>
  );
};

// ---- Message menu ---------------------------------------------------------------
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const UNSEND_WINDOW_MS = 48 * 60 * 60 * 1000;

export const MessageMenu: React.FC<{
  token: string;
  msg: ChatMessage;
  meId: number;
  // Group / community admin: may delete anyone's message for everyone.
  isRoomAdmin: boolean;
  onReply: () => void;
  onClose: () => void;
  onReacted: (reactions: ChatReaction[]) => void;
  onHidden: () => void;
  onUnsent: () => void;
  confirm: (message: string) => Promise<boolean>;
}> = ({ token, msg, meId, isRoomAdmin, onReply, onClose, onReacted, onHidden, onUnsent, confirm }) => {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const mine = msg.sender_id === meId;
  const unsent = !!msg.unsent_at;
  const canUnsend = !unsent && ((mine && Date.now() - new Date(msg.created_at).getTime() < UNSEND_WINDOW_MS) || isRoomAdmin);
  const myReaction = (msg.reactions || []).find((r) => r.user_id === meId)?.emoji;
  const call = async (key: string, path: string, body?: any) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };
  const item = (key: string, icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <button
      key={key}
      type="button"
      disabled={!!busy}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-black/5 disabled:opacity-50 ${danger ? 'text-rose-600' : 'text-slate-800'}`}
    >
      {busy === key ? <Loader2 className="w-4 h-4 animate-spin" /> : icon} {label}
    </button>
  );
  const preview = unsent ? 'This message was deleted' : msg.content || (msg.message_type === 'image' ? '📷 Photo' : msg.message_type === 'audio' ? '🎤 Voice message' : `📎 ${msg.attachment_filename || 'File'}`);
  return (
    <Popup title="Message" icon={<Smile className="w-4 h-4" />} size="md" onClose={busy ? () => {} : onClose}>
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[20px] px-3 py-2 text-xs text-slate-600 line-clamp-2">
          <span className="font-semibold text-slate-800">{mine ? 'You' : msg.sender_name}: </span>
          {preview}
        </div>
        {!unsent && (
          <div className="flex items-center justify-between gap-1 liquid-glass-inset rounded-full px-2 py-1.5">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  const data = await call(`react${e}`, `/api/chat/messages/${msg.id}/react`, { emoji: e });
                  if (data) {
                    onReacted(data.reactions || []);
                    onClose();
                  }
                }}
                className={`w-10 h-10 rounded-full text-2xl leading-none flex items-center justify-center transition-transform hover:scale-110 ${myReaction === e ? 'bg-violet-100 ring-1 ring-violet-300' : ''}`}
                aria-label={`React ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="liquid-glass-inset rounded-[20px] overflow-hidden divide-y divide-slate-200/60">
          {!unsent &&
            item('reply', <Reply className="w-4 h-4" />, 'Reply', () => {
              onReply();
              onClose();
            })}
          {!unsent &&
            !!msg.content &&
            item('copy', <Copy className="w-4 h-4" />, 'Copy', () => {
              void navigator.clipboard?.writeText(msg.content || '').catch(() => {});
              onClose();
            })}
          {item('hide', <Trash2 className="w-4 h-4" />, 'Delete for me', async () => {
            if (!(await confirm('Delete this message for you? Others still see it.'))) return;
            if (await call('hide', '/api/chat/messages/hide', { messageIds: [msg.id] })) {
              onHidden();
              onClose();
            }
          }, true)}
          {canUnsend &&
            item('unsend', <Ban className="w-4 h-4" />, mine ? 'Delete for everyone (unsend)' : 'Delete for everyone (as admin)', async () => {
              if (!(await confirm('Delete this message for everyone? It is replaced by "This message was deleted".'))) return;
              if (await call('unsend', `/api/chat/messages/${msg.id}/unsend`)) {
                onUnsent();
                onClose();
              }
            }, true)}
        </div>
        {mine && !unsent && !canUnsend && <p className="text-[11px] text-slate-500">Delete for everyone is only possible within 48 hours of sending.</p>}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// ---- Reactions under a bubble ---------------------------------------------------
export const ReactionChips: React.FC<{ reactions?: ChatReaction[]; meId: number; mine: boolean; onOpen: () => void }> = ({ reactions, meId, mine, onOpen }) => {
  if (!reactions || !reactions.length) return null;
  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
  const iReacted = reactions.some((r) => r.user_id === meId);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`-mt-1.5 relative z-[1] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white border text-xs shadow-sm ${iReacted ? 'border-violet-200' : 'border-slate-200'} ${mine ? 'mr-2' : 'ml-2'}`}
      aria-label="Reactions"
    >
      {[...counts.keys()].slice(0, 3).map((e) => (
        <span key={e} className="leading-none">{e}</span>
      ))}
      {reactions.length > 1 && <span className="ml-0.5 text-[10px] text-slate-500">{reactions.length}</span>}
    </button>
  );
};

export const ReactionsWho: React.FC<{ token: string; msg: ChatMessage; meId: number; onClose: () => void; onReacted: (r: ChatReaction[]) => void }> = ({ token, msg, meId, onClose, onReacted }) => {
  const [busy, setBusy] = useState(false);
  const removeMine = async () => {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/chat/messages/${msg.id}/react`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ emoji: null })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onReacted(data.reactions || []);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup title={`${(msg.reactions || []).length} reaction${(msg.reactions || []).length === 1 ? '' : 's'}`} icon={<Smile className="w-4 h-4" />} size="md" onClose={onClose}>
      <div className="liquid-glass-inset rounded-[20px] divide-y divide-slate-200/60 text-left">
        {(msg.reactions || []).map((r) => (
          <div key={r.user_id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <div>
              <div className="font-medium text-slate-800">{r.user_id === meId ? 'You' : r.name}</div>
              {r.user_id === meId && (
                <button type="button" disabled={busy} onClick={() => void removeMine()} className="text-[11px] text-slate-500 underline">
                  Tap to remove
                </button>
              )}
            </div>
            <span className="text-2xl leading-none">{r.emoji}</span>
          </div>
        ))}
      </div>
    </Popup>
  );
};

// ---- Chat profile ---------------------------------------------------------------
export interface ChatProfile {
  room: { id: number; type: string; title: string | null; created_at: string };
  person: null | { id: number; name: string; username: string; about: string; email: string; phone: string; designation: string; department: string; branch: string; employee_id: string };
  commonGroups: { id: number; type: string; title: string | null }[];
  media: { id: number; message_type: 'image' | 'file' | 'audio'; attachment_filename: string | null; created_at: string; sender_name: string }[];
}

export function useChatProfile(token: string, roomId: number | null, tick: number): ChatProfile | null {
  const [data, setData] = useState<ChatProfile | null>(null);
  useEffect(() => {
    if (!roomId) return;
    let off = false;
    setData(null);
    fetch(apiUrl(`/api/chat/rooms/${roomId}/profile`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !off && setData(d))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [token, roomId, tick]);
  return data;
}

// Name, About and the directory-safe work details (Employee Directory shows
// the same to everyone).
export const PersonDetails: React.FC<{ person: NonNullable<ChatProfile['person']> }> = ({ person }) => {
  const rows: [React.ReactNode, string, string | null][] = [
    [<Briefcase className="w-4 h-4" />, [person.designation, person.department].filter(Boolean).join(' · '), null],
    [<Building2 className="w-4 h-4" />, person.branch, null],
    [<IdCard className="w-4 h-4" />, person.employee_id ? `ID ${person.employee_id}` : '', null],
    [<Mail className="w-4 h-4" />, person.email, person.email ? `mailto:${person.email}` : null],
    [<Phone className="w-4 h-4" />, person.phone, person.phone ? `tel:${person.phone}` : null]
  ];
  return (
    <div className="px-4 py-3 space-y-2">
      <div>
        <div className="text-xs font-semibold uppercase text-slate-400">About</div>
        <div className="text-sm text-slate-800 mt-0.5">{person.about || <span className="text-slate-400">Hey there! I am using Credence Chat.</span>}</div>
      </div>
      {rows
        .filter(([, v]) => !!v)
        .map(([icon, v, href], i) => (
          <div key={i} className="flex items-center gap-3 text-sm text-slate-700">
            <span className="text-slate-400">{icon}</span>
            {href ? (
              <a href={href} className="text-blue-700 hover:underline break-all">{v}</a>
            ) : (
              <span className="break-words">{v}</span>
            )}
          </div>
        ))}
    </div>
  );
};

export const SharedMedia: React.FC<{ media: ChatProfile['media']; renderImage: (id: number) => React.ReactNode; onOpenFile: (id: number) => void }> = ({ media, renderImage, onOpenFile }) => {
  const [tab, setTab] = useState<'media' | 'docs'>('media');
  const images = media.filter((m) => m.message_type === 'image');
  const docs = media.filter((m) => m.message_type !== 'image');
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase text-slate-400">Media, files and voice</div>
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold">
          {(['media', 'docs'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`px-2 py-0.5 rounded-md ${tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
              {k === 'media' ? `Photos ${images.length}` : `Files ${docs.length}`}
            </button>
          ))}
        </div>
      </div>
      {tab === 'media' ? (
        images.length ? (
          <div className="grid grid-cols-3 gap-1.5">
            {images.map((m) => (
              <div key={m.id} className="aspect-square overflow-hidden rounded-lg bg-slate-100 [&_img]:w-full [&_img]:h-full [&_img]:max-w-none [&_img]:max-h-none [&_img]:object-cover">
                {renderImage(m.id)}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 py-2 flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> No photos yet.</p>
        )
      ) : docs.length ? (
        <div className="space-y-1">
          {docs.map((m) => (
            <button key={m.id} type="button" onClick={() => onOpenFile(m.id)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 text-left">
              {m.message_type === 'audio' ? <Mic className="w-4 h-4 text-slate-400 shrink-0" /> : <FileText className="w-4 h-4 text-slate-400 shrink-0" />}
              <div className="min-w-0">
                <div className="text-sm text-slate-800 truncate">{m.message_type === 'audio' ? 'Voice message' : m.attachment_filename || 'File'}</div>
                <div className="text-[11px] text-slate-400">{m.sender_name} · {formatDate(m.created_at)}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400 py-2">No files yet.</p>
      )}
    </div>
  );
};

export const CommonGroups: React.FC<{ groups: ChatProfile['commonGroups']; onOpen: (id: number) => void }> = ({ groups, onOpen }) =>
  groups.length ? (
    <div className="px-4 py-3">
      <div className="text-xs font-semibold uppercase text-slate-400 mb-1">{groups.length} group{groups.length === 1 ? '' : 's'} in common</div>
      {groups.map((g) => (
        <button key={g.id} type="button" onClick={() => onOpen(g.id)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-slate-50 rounded-lg px-1">
          <span className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center">
            {g.type === 'community' ? <Shield className="w-4 h-4" /> : <Users className="w-4 h-4" />}
          </span>
          <span className="text-sm text-slate-800 truncate">{g.title || 'Group'}</span>
        </button>
      ))}
    </div>
  ) : null;

// One's own "About" line (shown on one's chat profile to others).
export const MyAboutPopup: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [about, setAbout] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(apiUrl('/api/chat/me/about'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { about: '' }))
      .then((d) => {
        setAbout(d.about || '');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [token]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/chat/me/about'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ about })
      });
      if (!res.ok) throw new Error('Could not save');
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title="My chat profile"
      icon={<Pencil className="w-4 h-4" />}
      size="md"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void save()} disabled={busy || !loaded}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-2 text-left">
        <label className={labelCls}>About</label>
        <input className={inputCls.replace('text-sm', 'text-base sm:text-sm')} value={about} maxLength={140} onChange={(e) => setAbout(e.target.value)} placeholder="e.g. Site engineer, Park Riveria · Available" />
        <div className="flex flex-wrap gap-1.5">
          {['Available', 'Busy', 'At site', 'In a meeting', 'On leave'].map((s) => (
            <button key={s} type="button" onClick={() => setAbout(s)} className="px-2.5 py-1 rounded-full text-xs border border-slate-200 bg-white/70 hover:bg-white">
              {s}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500">Shown to the people you chat with, on your chat profile.</p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
