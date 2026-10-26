/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Assistant live support, client side (server: AssistantSupportRoutes.ts).
//   LiveChat      — the person who asked for a human, inside the Assistant.
//   SupportInbox  — agents (every Superadmin, plus accounts with
//                   can_handle_assistant_support): the queue, the chat,
//                   Accept / Transfer / End.
// Live updates come over the Chat socket ("assistant_support" events); the
// lists are also re-read when the panel opens, so a missed event only delays.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, CheckCircle2, Headphones, Loader2, Send, UserCheck, XCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';
import { confirmDialog } from '../lib/confirmDialog';

import { SearchSelect } from './Combobox';
export interface SupportSession {
  id: number;
  user_id: number;
  user_name: string | null;
  agent_id: number | null;
  agent_name: string | null;
  status: 'waiting' | 'active' | 'closed';
  topic: string | null;
  created_at: string;
  last_message_at?: string;
  last_body?: string | null;
}
export interface SupportMessage {
  id: number;
  session_id: number;
  sender_id: number | null;
  sender_name: string | null;
  kind: 'user' | 'agent' | 'system';
  body: string;
  created_at: string;
}
export interface SupportEvent {
  session?: SupportSession;
  session_id?: number;
  message?: SupportMessage;
  queue_changed?: boolean;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
export async function supportApi<T = any>(token: string, path: string, body?: any): Promise<T> {
  const r = await fetch(apiUrl(`/api/assistant/support${path}`), { method: body === undefined ? 'GET' : 'POST', headers: auth(token), body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || 'Something went wrong.');
  return d as T;
}

// The Chat socket may connect a moment after this mounts — keep looking.
export function useSupportSocket(handler: (e: SupportEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let socket = getChatSocket();
    const on = (e: SupportEvent) => ref.current(e);
    let timer: ReturnType<typeof setInterval> | null = null;
    const attach = () => {
      socket = getChatSocket();
      if (!socket) return false;
      socket.on('assistant_support', on);
      return true;
    };
    if (!attach()) timer = setInterval(() => attach() && timer && clearInterval(timer), 2000);
    return () => {
      if (timer) clearInterval(timer);
      socket?.off('assistant_support', on);
    };
  }, []);
}

const mergeMessage = (list: SupportMessage[], m?: SupportMessage) => (!m || list.some((x) => x.id === m.id) ? list : [...list, m]);
const timeOf = (s: string) => String(s || '').slice(11, 16);

const Thread: React.FC<{ messages: SupportMessage[]; meId: number }> = ({ messages, meId }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);
  return (
    <div ref={ref} className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3 space-y-2.5">
      {messages.map((m) =>
        m.kind === 'system' ? (
          <p key={m.id} className="text-center text-[11px] text-slate-500 whitespace-pre-wrap px-4">{m.body}</p>
        ) : m.sender_id === meId ? (
          <div key={m.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-[20px] rounded-br-md px-3.5 py-2 text-sm text-white bg-violet-600 shadow-sm whitespace-pre-wrap break-words">
              {m.body}
              <span className="block text-[10px] text-white/70 text-right mt-0.5">{timeOf(m.created_at)}</span>
            </div>
          </div>
        ) : (
          <div key={m.id} className="flex justify-start">
            <div className="max-w-[88%] liquid-glass-inset rounded-[20px] rounded-bl-md px-3.5 py-2 text-sm text-slate-700 whitespace-pre-wrap break-words">
              <span className="block text-[10px] font-semibold text-violet-700 mb-0.5">{m.sender_name || (m.kind === 'agent' ? 'Support' : 'User')}</span>
              {m.body}
              <span className="block text-[10px] text-slate-400 text-right mt-0.5">{timeOf(m.created_at)}</span>
            </div>
          </div>
        )
      )}
    </div>
  );
};

const Composer: React.FC<{ disabled?: boolean; placeholder: string; onSend: (text: string) => Promise<void> }> = ({ disabled, placeholder, onSend }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    try {
      await onSend(t);
      setText('');
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="px-4 pb-4 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="liquid-glass-inset rounded-[24px] flex items-end gap-2 pl-4 pr-1.5 py-1.5">
        <textarea
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          maxLength={2000}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent outline-none text-sm text-slate-900 placeholder:text-slate-400 py-2 max-h-28 disabled:opacity-50"
        />
        <button type="submit" disabled={disabled || sending || !text.trim()} aria-label="Send" className="liquid-glass-button w-9 h-9 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// The person who asked for a human.
// ---------------------------------------------------------------------------
export const LiveChat: React.FC<{
  token: string;
  meId: number;
  session: SupportSession;
  messages: SupportMessage[];
  onChange: (session: SupportSession, messages: SupportMessage[]) => void;
  onBack: () => void;
}> = ({ token, meId, session, messages, onChange, onBack }) => {
  const [error, setError] = useState('');
  const closed = session.status === 'closed';

  const end = async () => {
    if (!(await confirmDialog('End this chat with support?', { title: 'কথোপকথন শেষ করবেন?', confirmLabel: 'শেষ করুন', cancelLabel: 'না' }))) return;
    try {
      const d = await supportApi<{ session: SupportSession }>(token, `/sessions/${session.id}/close`, {});
      const full = await supportApi<{ session: SupportSession; messages: SupportMessage[] }>(token, `/sessions/${session.id}`);
      onChange(d.session, full.messages);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <>
      <div className="mx-4 mb-2 liquid-glass-inset rounded-2xl px-3 py-2 flex items-center gap-2 text-xs">
        <Headphones className="w-4 h-4 text-violet-700 shrink-0" />
        <span className="flex-1 text-slate-700">
          {session.status === 'waiting' && 'Support-এর কেউ যোগ দেওয়ার অপেক্ষায়… এর মধ্যে লিখে রাখতে পারেন।'}
          {session.status === 'active' && <>সরাসরি কথা বলছেন: <strong className="text-slate-900">{session.agent_name}</strong></>}
          {closed && 'কথোপকথন শেষ হয়েছে।'}
        </span>
        {!closed && (
          <button type="button" onClick={end} className="liquid-glass-chip rounded-full px-2.5 py-1 text-[11px] text-rose-700">
            শেষ করুন
          </button>
        )}
      </div>
      <Thread messages={messages} meId={meId} />
      {error && <p className="px-5 text-[11px] text-rose-600">{error}</p>}
      {closed ? (
        <div className="px-4 pb-4 pt-1">
          <button type="button" onClick={onBack} className="liquid-glass-button w-full rounded-full py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-1.5">
            <ArrowLeft className="w-4 h-4" /> Assistant-এ ফিরে যান
          </button>
        </div>
      ) : (
        <Composer
          placeholder="Support-কে লিখুন…"
          onSend={async (body) => {
            setError('');
            try {
              const d = await supportApi<{ message: SupportMessage }>(token, `/sessions/${session.id}/messages`, { body });
              onChange(session, mergeMessage(messages, d.message));
            } catch (e: any) {
              setError(e.message);
            }
          }}
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Agents: queue + conversation + Accept / Transfer / End.
// ---------------------------------------------------------------------------
const STATUS_CHIP: Record<string, string> = {
  waiting: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-slate-100 text-slate-600'
};
const STATUS_BN: Record<string, string> = { waiting: 'অপেক্ষায়', active: 'চলছে', closed: 'শেষ' };

export const SupportInbox: React.FC<{
  token: string;
  meId: number;
  focusId: number | null;
  onFocusHandled: () => void;
  onQueueCount: (waiting: number) => void;
}> = ({ token, meId, focusId, onFocusHandled, onQueueCount }) => {
  const [list, setList] = useState<SupportSession[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [session, setSession] = useState<SupportSession | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [agents, setAgents] = useState<{ id: number; name: string }[] | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [note, setNote] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openRef = useRef<number | null>(null);
  openRef.current = openId;

  const loadList = useCallback(async () => {
    try {
      const rows = await supportApi<SupportSession[]>(token, '/queue');
      setList(rows);
      onQueueCount(rows.filter((r) => r.status === 'waiting').length);
    } catch (e: any) {
      setError(e.message);
      setList([]);
    }
  }, [token, onQueueCount]);

  const openSession = useCallback(
    async (id: number) => {
      setOpenId(id);
      setShowTransfer(false);
      setError('');
      try {
        const d = await supportApi<{ session: SupportSession; messages: SupportMessage[] }>(token, `/sessions/${id}`);
        setSession(d.session);
        setMessages(d.messages);
      } catch (e: any) {
        setError(e.message);
      }
    },
    [token]
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (focusId) {
      void openSession(focusId);
      onFocusHandled();
    }
  }, [focusId, openSession, onFocusHandled]);

  useSupportSocket((e) => {
    if (e.queue_changed || e.session) void loadList();
    const sid = e.session?.id ?? e.session_id;
    if (sid && sid === openRef.current) {
      if (e.session) setSession(e.session);
      if (e.message) setMessages((m) => mergeMessage(m, e.message));
    }
  });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (openId && session) {
    const mine = session.agent_id === meId;
    const open = session.status !== 'closed';
    return (
      <>
        <div className="mx-4 mb-2 liquid-glass-inset rounded-2xl px-3 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setOpenId(null); setSession(null); void loadList(); }} className="liquid-glass-chip p-1 rounded-full text-slate-600" aria-label="Back to inbox">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900 truncate">{session.user_name}</p>
              <p className="text-[11px] text-slate-500 truncate">
                {session.topic ? `${session.topic} · ` : ''}
                {session.status === 'active' ? `সাথে আছেন: ${session.agent_name}` : STATUS_BN[session.status]}
              </p>
            </div>
            <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${STATUS_CHIP[session.status]}`}>{STATUS_BN[session.status]}</span>
          </div>
          {open && (
            <div className="flex flex-wrap gap-1.5">
              {session.status === 'waiting' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(async () => { const d = await supportApi(token, `/sessions/${session.id}/accept`, {}); setSession(d.session); setMessages(d.messages); })}
                  className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1"
                >
                  <UserCheck className="w-3.5 h-3.5" /> Accept
                </button>
              )}
              {(mine || session.status === 'active') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(async () => { setShowTransfer((v) => !v); if (!agents) setAgents(await supportApi(token, '/agents')); })}
                  className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs text-violet-800 inline-flex items-center gap-1"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer
                </button>
              )}
              {(mine || session.status === 'active') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(async () => {
                    if (!(await confirmDialog(`End this chat with ${session.user_name}?`, { title: 'কথোপকথন শেষ করবেন?', confirmLabel: 'শেষ করুন', cancelLabel: 'না' }))) return;
                    const d = await supportApi(token, `/sessions/${session.id}/close`, {});
                    setSession(d.session);
                  })}
                  className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs text-rose-700 inline-flex items-center gap-1"
                >
                  <XCircle className="w-3.5 h-3.5" /> End
                </button>
              )}
            </div>
          )}
          {showTransfer && open && (
            <div className="space-y-1.5">
              <SearchSelect value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-full rounded-xl bg-white/70 border border-white/80 px-2.5 py-1.5 text-xs text-slate-900 outline-none">
                <option value="">— কার কাছে পাঠাবেন —</option>
                {(agents || []).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </SearchSelect>
              {agents && agents.length === 0 && <p className="text-[11px] text-slate-500">আর কেউ live support-এ নেই। Module Access থেকে কাউকে "Assistant live support" দিন।</p>}
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="নোট (ঐচ্ছিক)" className="w-full rounded-xl bg-white/70 border border-white/80 px-2.5 py-1.5 text-xs text-slate-900 outline-none" />
              <button
                type="button"
                disabled={busy || !transferTo}
                onClick={() => act(async () => {
                  const d = await supportApi(token, `/sessions/${session.id}/transfer`, { to_user_id: Number(transferTo), note });
                  setSession(d.session);
                  setShowTransfer(false);
                  setTransferTo('');
                  setNote('');
                })}
                className="liquid-glass-button w-full rounded-full py-1.5 text-xs font-semibold disabled:opacity-40"
              >
                Transfer করুন
              </button>
            </div>
          )}
        </div>
        <Thread messages={messages} meId={meId} />
        {error && <p className="px-5 pb-1 text-[11px] text-rose-600">{error}</p>}
        {open && mine ? (
          <Composer
            placeholder={`${session.user_name || 'User'}-কে লিখুন…`}
            onSend={async (body) => {
              setError('');
              try {
                const d = await supportApi<{ message: SupportMessage }>(token, `/sessions/${session.id}/messages`, { body });
                setMessages((m) => mergeMessage(m, d.message));
              } catch (e: any) {
                setError(e.message);
              }
            }}
          />
        ) : (
          <p className="px-5 pb-4 text-[11px] text-slate-500 text-center">
            {!open ? 'কথোপকথন শেষ হয়েছে।' : session.status === 'waiting' ? 'উত্তর দিতে আগে Accept করুন।' : `${session.agent_name} এই chat দেখছেন।`}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-2">
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      {list === null ? (
        <p className="text-center text-xs text-slate-500 py-8"><Loader2 className="w-4 h-4 animate-spin inline" /> লোড হচ্ছে…</p>
      ) : list.length === 0 ? (
        <div className="liquid-glass-inset rounded-[24px] px-4 py-6 text-center">
          <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
          <p className="text-sm text-slate-700 mt-2">কেউ অপেক্ষায় নেই।</p>
          <p className="text-[11px] text-slate-500 mt-1">কেউ Assistant-এ মানুষের সাথে কথা বলতে চাইলে এখানে আসবে, alert-ও পাবেন।</p>
        </div>
      ) : (
        list.map((s) => (
          <button key={s.id} type="button" onClick={() => openSession(s.id)} className="w-full text-left liquid-glass-inset rounded-2xl px-3.5 py-2.5 hover:bg-white/70 transition-colors">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 truncate flex-1">{s.user_name}</span>
              <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${STATUS_CHIP[s.status]}`}>{STATUS_BN[s.status]}</span>
            </div>
            <p className="text-[11px] text-slate-500 truncate">
              {s.topic ? `${s.topic} · ` : ''}
              {s.status === 'active' ? (s.agent_id === meId ? 'আপনার সাথে' : `সাথে: ${s.agent_name}`) : ''}
            </p>
            {s.last_body && <p className="text-xs text-slate-600 truncate mt-0.5">{s.last_body.split('\n')[0]}</p>}
          </button>
        ))
      )}
    </div>
  );
};
