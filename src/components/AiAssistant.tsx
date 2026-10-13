/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Credence Assistant" — the floating AI helper (AiAssistantRoutes.ts).
// A round sparkle button sits above the Chat button on the website and above
// the bottom bar on phones; it opens a liquid-glass chat card. Answers can
// carry buttons that open the page they talk about (onNavigate).
//
// Shown to every account unless HR switched it off for them in Module Access
// (users.can_use_ai_assistant); the API checks the same switch.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarCheck, CheckCircle2, Loader2, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import type { User } from '../types';

interface Action { label: string; nav: string }
// A leave application the Assistant filled in (AiAssistantRoutes.ts LeaveDraft).
// Nothing is sent until the person presses "জমা দিন" on the card.
interface LeaveDraft {
  kind: 'leave_application';
  leave_type: string;
  start_date: string;
  end_date: string;
  is_half_day: boolean;
  purpose: string;
  today: string;
  types: { value: string; label: string; balance: number | null; reliever_required: boolean }[];
  relievers: { id: number; name: string }[];
}
interface Msg { role: 'user' | 'assistant'; text: string; actions?: Action[]; draft?: LeaveDraft; draftDone?: 'submitted' | 'cancelled' }

const dayCountOf = (from: string, to: string, half: boolean) => {
  if (!from || !to || to < from) return 0;
  const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  return half ? Math.max(0.5, days - 0.5) : days;
};

const LeaveDraftCard: React.FC<{ token: string; draft: LeaveDraft; onDone: (result: 'submitted' | 'cancelled', note?: string) => void }> = ({ token, draft, onDone }) => {
  const [type, setType] = useState(draft.leave_type);
  const [from, setFrom] = useState(draft.start_date);
  const [to, setTo] = useState(draft.end_date || draft.start_date);
  const [half, setHalf] = useState(draft.is_half_day);
  const [purpose, setPurpose] = useState(draft.purpose);
  const [reliever, setReliever] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const t = draft.types.find((x) => x.value === type);
  // Same rule as the Leave Application form and the server: Sick Leave and a
  // backdated application never need a Reliever.
  const needsReliever = !!t?.reliever_required && type !== 'sick' && !!from && from >= draft.today;
  const days = dayCountOf(from, to, half);
  const field = 'w-full rounded-xl bg-white/70 border border-white/80 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-violet-300';

  const submit = async () => {
    if (!from || !to) return setError('তারিখ দিন।');
    if (to < from) return setError('শেষ তারিখ শুরুর আগে হতে পারে না।');
    if (!purpose.trim()) return setError('কারণ লিখুন।');
    if (needsReliever && !reliever) return setError('Reliever বেছে নিন।');
    setSaving(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/leave-applications'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          leave_type: type,
          start_date: from,
          end_date: to,
          day_count: days,
          is_half_day: half,
          include_extra_work_dates: false,
          is_foreign_leave: false,
          purpose: purpose.trim(),
          reliever_id: needsReliever ? Number(reliever) : null
        })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'আবেদন জমা হয়নি।');
      onDone('submitted', `${t?.label || type}, ${from}${to !== from ? ` – ${to}` : ''} (${days} দিন)`);
    } catch (e: any) {
      setError(e.message || 'আবেদন জমা হয়নি।');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2.5 rounded-2xl bg-white/55 border border-white/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-800">
        <CalendarCheck className="w-4 h-4" /> ছুটির আবেদন — দেখে নিন
      </div>
      <label className="block text-[11px] text-slate-500">
        ছুটির ধরন
        <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
          {draft.types.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}{x.balance != null ? ` (বাকি ${x.balance})` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-slate-500">
          শুরু
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} className={field} />
        </label>
        <label className="block text-[11px] text-slate-500">
          শেষ
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} className="accent-violet-600" /> Half day
        <span className="ml-auto text-[11px] text-slate-500">{days > 0 ? `মোট ${days} দিন` : ''}</span>
      </label>
      {needsReliever && (
        <label className="block text-[11px] text-slate-500">
          Reliever (আপনার অনুপস্থিতিতে কাজ দেখবেন)
          <select value={reliever} onChange={(e) => setReliever(e.target.value)} className={field}>
            <option value="">— বেছে নিন —</option>
            {draft.relievers.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-[11px] text-slate-500">
        কারণ
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={300} className={`${field} resize-none`} />
      </label>
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={saving} className="liquid-glass-button flex-1 rounded-full py-2 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} জমা দিন
        </button>
        <button type="button" onClick={() => onDone('cancelled')} disabled={saving} className="liquid-glass-chip rounded-full px-4 py-2 text-xs text-slate-700">
          বাতিল
        </button>
      </div>
    </div>
  );
};

interface Props {
  token: string;
  user: User | null;
  onNavigate: (nav: string) => void;
  hidden?: boolean;
}

// **bold** and line breaks — all the formatting the answers use.
const RichText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split('\n').map((line, i) => (
      <span key={i} className="block min-h-[0.5em]">
        {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? <strong key={j} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong> : <React.Fragment key={j}>{part}</React.Fragment>
        )}
      </span>
    ))}
  </>
);

export const AiAssistant: React.FC<Props> = ({ token, user, onNavigate, hidden }) => {
  const allowed = !!user && !user.is_onboarding && (user.role === 'superadmin' || user.can_use_ai_assistant !== false);
  const storeKey = user ? `credence_assistant_${user.id}` : '';
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const raw = storeKey ? sessionStorage.getItem(storeKey) : null;
      return raw ? (JSON.parse(raw) as Msg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [engine, setEngine] = useState<'local' | 'gemini' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      if (storeKey) sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-30)));
    } catch {
      // storage unavailable — the conversation just isn't kept across reloads
    }
  }, [msgs, storeKey]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    fetch(apiUrl('/api/assistant/status'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSuggestions(d.suggestions || []);
        setEngine(d.engine || 'local');
      })
      .catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 150);
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!allowed) return null;

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    const history = msgs.slice(-10).map((m) => ({
      role: m.role,
      text: m.text + (m.draftDone === 'submitted' ? ' [The user submitted this leave application.]' : m.draftDone === 'cancelled' ? ' [The user cancelled this draft.]' : m.draft ? ' [Draft shown, not submitted yet.]' : '')
    }));
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch(apiUrl('/api/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, history })
      });
      const d = await r.json().catch(() => null);
      const reply = r.ok && d?.reply ? d.reply : d?.error || 'দুঃখিত, এখন উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।';
      setMsgs((m) => [...m, { role: 'assistant', text: reply, actions: r.ok ? d?.actions || [] : [], draft: r.ok && d?.draft ? d.draft : undefined }]);
    } catch {
      setMsgs((m) => [...m, { role: 'assistant', text: 'সংযোগে সমস্যা হয়েছে। ইন্টারনেট দেখে আবার চেষ্টা করুন।' }]);
    } finally {
      setBusy(false);
    }
  };

  const finishDraft = (index: number, result: 'submitted' | 'cancelled', note?: string) => {
    setMsgs((m) => {
      const next = m.map((x, i) => (i === index ? { ...x, draftDone: result } : x));
      next.push(
        result === 'submitted'
          ? { role: 'assistant', text: `✅ আবেদন জমা হয়েছে — ${note}। এখন এটা অনুমোদনের অপেক্ষায়; অবস্থা জানতে আমাকে জিজ্ঞেস করুন বা Leave Application খুলুন।`, actions: [{ label: 'Leave Application খুলুন', nav: 'self:leaveApplication' }] }
          : { role: 'assistant', text: 'ঠিক আছে, খসড়াটা বাতিল করলাম — কিছু জমা হয়নি।' }
      );
      return next;
    });
  };

  const go = (nav: string) => {
    setOpen(false);
    onNavigate(nav);
  };

  const firstName = (user?.name || '').split(' ')[0];

  return (
    <>
      {/* .liquid-glass-button sets position: relative, so the wrapper is what's fixed. */}
      {!open && !hidden && (
        <div className="fixed z-50 right-4 md:right-7 bottom-[calc(88px+env(safe-area-inset-bottom,0px))] md:bottom-[100px]">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Credence Assistant"
            aria-label="Open Credence Assistant"
            className="w-12 h-12 rounded-full liquid-glass-button flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform"
          >
            <Sparkles className="w-5 h-5" />
          </button>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[80] liquid-glass-backdrop flex items-end sm:items-center md:items-end justify-center md:justify-end p-2 sm:p-4 md:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="Credence Assistant"
            className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-md flex flex-col overflow-hidden"
            style={{ height: 'min(640px, 88vh)' }}
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-3">
              <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-violet-700 shrink-0">
                <Sparkles className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900 leading-tight">Credence Assistant</h3>
                <p className="text-[11px] text-slate-500 truncate">
                  {engine === 'gemini' ? 'AI (Gemini) · ' : ''}আপনার ছুটি, হাজিরা, claim আর app-এর সাহায্য
                </p>
              </div>
              {msgs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setMsgs([])}
                  title="নতুন করে শুরু"
                  aria-label="Clear conversation"
                  className="liquid-glass-chip p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close assistant"
                className="liquid-glass-chip p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3 space-y-3">
              {msgs.length === 0 && (
                <div className="liquid-glass-inset rounded-[24px] px-4 py-4">
                  <p className="text-sm text-slate-800">
                    আসসালামু আলাইকুম{firstName ? `, ${firstName}` : ''}! আমি আপনার নিজের তথ্য দেখে উত্তর দিতে পারি, আর app-এ কোন কাজ কোথায় তা দেখিয়ে দিতে পারি।
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1.5">আমি শুধু দেখি আর পথ দেখাই — কিছু জমা, অনুমোদন বা বদল করি না।</p>
                  {suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => ask(s)}
                          className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs text-violet-800 hover:text-violet-950"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {msgs.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-[20px] rounded-br-md px-3.5 py-2 text-sm text-white bg-violet-600 shadow-sm whitespace-pre-wrap break-words">{m.text}</div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[92%] liquid-glass-inset rounded-[20px] rounded-bl-md px-3.5 py-2.5 text-sm text-slate-700 break-words">
                      <RichText text={m.text} />
                      {m.draft && !m.draftDone && <LeaveDraftCard token={token} draft={m.draft} onDone={(r, note) => finishDraft(i, r, note)} />}
                      {m.draft && m.draftDone === 'submitted' && (
                        <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> জমা দেওয়া হয়েছে</p>
                      )}
                      {m.actions && m.actions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {m.actions.map((a) => (
                            <button
                              key={a.nav}
                              type="button"
                              onClick={() => go(a.nav)}
                              className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1"
                            >
                              {a.label}
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}

              {busy && (
                <div className="flex justify-start">
                  <div className="liquid-glass-inset rounded-[20px] rounded-bl-md px-3.5 py-2.5 text-sm text-slate-500 inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> দেখছি…
                  </div>
                </div>
              )}
            </div>

            <form
              className="px-4 pb-4 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              <div className="liquid-glass-inset rounded-[24px] flex items-end gap-2 pl-4 pr-1.5 py-1.5">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void ask(input);
                    }
                  }}
                  rows={1}
                  maxLength={1000}
                  placeholder="প্রশ্ন লিখুন… (বাংলা / English)"
                  className="flex-1 resize-none bg-transparent outline-none text-sm text-slate-900 placeholder:text-slate-400 py-2 max-h-28"
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="liquid-glass-button w-9 h-9 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default AiAssistant;
