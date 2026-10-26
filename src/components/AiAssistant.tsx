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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarCheck, CheckCircle2, FileSpreadsheet, FileText, Headphones, Loader2, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import type { User } from '../types';
import { downloadAssistantExcel, downloadAssistantPdf, type AssistantReport } from '../lib/assistantReportExport';
import { EmailReportButton, useCanEmailReports } from '../lib/reportEmail';
import { LiveChat, SupportInbox, supportApi, useSupportSocket, type SupportMessage, type SupportSession } from './AssistantSupport';
import { useIsPhone, useScrolling } from '../lib/useScrolling';

import { SearchSelect } from './Combobox';
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
interface Msg { role: 'user' | 'assistant'; text: string; actions?: Action[]; draft?: LeaveDraft; draftDone?: 'submitted' | 'cancelled'; report?: AssistantReport }

// PDF / Excel of the full list behind an answer. The server only sends a
// report to accounts with "Assistant — report PDF / Excel download" ticked.
const ReportButtons: React.FC<{ token: string; report: AssistantReport; preparedBy: string }> = ({ token, report, preparedBy }) => {
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'email' | null>(null);
  const [err, setErr] = useState('');
  const canEmailReports = useCanEmailReports();
  const run = async (kind: 'pdf' | 'xlsx' | 'email') => {
    setBusy(kind);
    setErr('');
    try {
      if (kind === 'pdf') await downloadAssistantPdf(token, report, preparedBy);
      else if (kind === 'email') await downloadAssistantPdf(token, report, preparedBy, 'email');
      else await downloadAssistantExcel(report, preparedBy);
    } catch {
      setErr('ফাইল বানানো যায়নি, আবার চেষ্টা করুন।');
    } finally {
      setBusy(null);
    }
  };
  const btn = 'liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50';
  return (
    <div className="mt-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">পুরো তালিকা ({report.rows.length})</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={!!busy} onClick={() => run('pdf')} className={`${btn} text-rose-700`} aria-label="Download PDF">
          {busy === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} PDF
        </button>
        {canEmailReports && <EmailReportButton onClick={() => run('email')} disabled={!!busy} className={`${btn} text-sky-700`} />}
        <button type="button" disabled={!!busy} onClick={() => run('xlsx')} className={`${btn} text-emerald-700`} aria-label="Download Excel">
          {busy === 'xlsx' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} Excel
        </button>
      </div>
      {err && <p className="text-[11px] text-rose-600 mt-1">{err}</p>}
    </div>
  );
};

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
          <SearchSelect value={reliever} onChange={(e) => setReliever(e.target.value)} className={field}>
            <option value="">— বেছে নিন —</option>
            {draft.relievers.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </SearchSelect>
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
  const isPhone = useIsPhone();
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
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Live support (AssistantSupport.tsx): 'bot' = the Assistant, 'live' = my
  // chat with a human, 'inbox' = agents' queue.
  const [view, setView] = useState<'bot' | 'live' | 'inbox'>('bot');
  const [live, setLive] = useState<{ session: SupportSession; messages: SupportMessage[] } | null>(null);
  const [isAgent, setIsAgent] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [unread, setUnread] = useState(0);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [supportError, setSupportError] = useState('');
  const openRef = useRef(open);
  openRef.current = open;
  const liveRef = useRef(live);
  liveRef.current = live;

  const refreshSupport = useCallback(async () => {
    if (!token || !allowed) return;
    try {
      const a = await supportApi<{ is_agent: boolean; waiting: number }>(token, '/access');
      setIsAgent(a.is_agent);
      setWaiting(a.waiting);
      const mine = await supportApi<{ session: SupportSession | null; messages: SupportMessage[] }>(token, '/mine');
      setLive((cur) => (mine.session ? { session: mine.session, messages: mine.messages } : cur && cur.session.status === 'closed' ? cur : null));
    } catch {
      // live support unavailable — the Assistant itself still works
    }
  }, [token, allowed]);

  useEffect(() => {
    void refreshSupport();
  }, [refreshSupport]);

  useSupportSocket((e) => {
    const cur = liveRef.current;
    const sid = e.session?.id ?? e.session_id;
    if (cur && sid === cur.session.id) {
      setLive((l) => {
        if (!l) return l;
        const messages = e.message && !l.messages.some((m) => m.id === e.message!.id) ? [...l.messages, e.message] : l.messages;
        return { session: e.session || l.session, messages };
      });
      if (e.message && e.message.sender_id !== user?.id && (!openRef.current || view !== 'live')) setUnread((n) => n + 1);
    }
    if (e.queue_changed) {
      supportApi<{ is_agent: boolean; waiting: number }>(token, '/access').then((a) => setWaiting(a.waiting)).catch(() => {});
    }
  });

  // An "assistant_support" alert: agents open the chat in the inbox, the
  // person who asked opens their live chat.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = Number((e as CustomEvent).detail) || null;
      setOpen(true);
      if (isAgent && id && (!liveRef.current || liveRef.current.session.id !== id)) {
        setFocusId(id);
        setView('inbox');
      } else {
        void refreshSupport();
        setView('live');
      }
    };
    window.addEventListener('credence:open-assistant-support', onOpen);
    return () => window.removeEventListener('credence:open-assistant-support', onOpen);
  }, [isAgent, refreshSupport]);

  // The phone More menu's "Credence Assistant" tile (UserPanel.tsx).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('credence:open-assistant', onOpen);
    return () => window.removeEventListener('credence:open-assistant', onOpen);
  }, []);

  useEffect(() => {
    if (open && view === 'live') setUnread(0);
  }, [open, view, live?.messages.length]);

  const startSupport = async () => {
    setSupportError('');
    try {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.text || '';
      const d = await supportApi<{ session: SupportSession; messages: SupportMessage[] }>(token, '/request', {
        topic: lastUser.slice(0, 200),
        context: msgs.slice(-6).map((m) => ({ role: m.role, text: m.text }))
      });
      setLive({ session: d.session, messages: d.messages });
      setView('live');
    } catch (e: any) {
      setSupportError(e.message || 'Support-এর সাথে যোগাযোগ করা গেল না।');
    }
  };

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
      setMsgs((m) => [...m, { role: 'assistant', text: reply, actions: r.ok ? d?.actions || [] : [], draft: r.ok && d?.draft ? d.draft : undefined, report: r.ok && d?.report ? d.report : undefined }]);
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
    if (nav === 'support:request') {
      void startSupport();
      return;
    }
    setOpen(false);
    onNavigate(nav);
  };

  const firstName = (user?.name || '').split(' ')[0];

  return (
    <>
      {/* Phones: a small tab tucked against the right edge instead of a
          round button over the page — drag it up / down (the place is
          remembered), and it slides away while the page scrolls. */}
      {!open && !hidden && isPhone && <EdgeTab count={waiting + unread} onOpen={() => setOpen(true)} />}

      {/* .liquid-glass-button sets position: relative, so the wrapper is what's fixed. */}
      {!open && !hidden && !isPhone && (
        <div className="assistant-fab fixed z-50 right-4 md:right-7 bottom-[calc(88px+env(safe-area-inset-bottom,0px))] md:bottom-[100px]">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Credence Assistant"
            aria-label="Open Credence Assistant"
            className="w-12 h-12 rounded-full liquid-glass-button flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform"
          >
            <Sparkles className="w-5 h-5" />
          </button>
          {waiting + unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white pointer-events-none">
              {waiting + unread}
            </span>
          )}
        </div>
      )}

      {open && (
        <>
        {/* Phones / small tablets: dim + blur behind the sheet, tap it to
            close. On a computer the page stays sharp and usable next to the
            Assistant — no backdrop at all. */}
        <div className="md:hidden fixed inset-0 z-[80] liquid-glass-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
        <div className="fixed inset-0 z-[81] pointer-events-none flex items-end sm:items-center md:items-end justify-center md:justify-end p-2 sm:p-4 md:p-6">
          <div
            role="dialog"
            aria-label="Credence Assistant"
            className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] w-full max-w-md flex flex-col overflow-hidden shadow-2xl"
            style={{ height: 'min(640px, 88vh)' }}
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-3">
              <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-violet-700 shrink-0">
                <Sparkles className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900 leading-tight">{view === 'bot' ? 'Credence Assistant' : view === 'live' ? 'Live support' : 'Support inbox'}</h3>
              </div>
              {view === 'bot' && msgs.length > 0 && (
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

            {(isAgent || live) && (
              <div className="flex gap-1.5 px-4 pb-2">
                <button type="button" onClick={() => setView('bot')} className={`rounded-full px-3 py-1 text-xs ${view === 'bot' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                  Assistant
                </button>
                {live && (
                  <button type="button" onClick={() => setView('live')} className={`rounded-full px-3 py-1 text-xs inline-flex items-center gap-1 ${view === 'live' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                    <Headphones className="w-3.5 h-3.5" /> আমার support chat{unread > 0 && view !== 'live' ? ` (${unread})` : ''}
                  </button>
                )}
                {isAgent && (
                  <button type="button" onClick={() => setView('inbox')} className={`rounded-full px-3 py-1 text-xs ${view === 'inbox' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                    Support inbox{waiting > 0 ? ` (${waiting})` : ''}
                  </button>
                )}
              </div>
            )}

            {view === 'live' && live && user ? (
              <LiveChat
                token={token}
                meId={user.id}
                session={live.session}
                messages={live.messages}
                onChange={(session, messages) => setLive({ session, messages })}
                onBack={() => { setLive(null); setView('bot'); }}
              />
            ) : view === 'inbox' && isAgent && user ? (
              <SupportInbox token={token} meId={user.id} focusId={focusId} onFocusHandled={() => setFocusId(null)} onQueueCount={setWaiting} />
            ) : (
            <>
            <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3 space-y-3">
              {msgs.length === 0 && (
                <div className="liquid-glass-inset rounded-[24px] px-4 py-4">
                  <p className="text-sm text-slate-800">
                    আসসালামু আলাইকুম{firstName ? `, ${firstName}` : ''}! আমি আপনার নিজের তথ্য দেখে উত্তর দিতে পারি, আর app-এ কোন কাজ কোথায় তা দেখিয়ে দিতে পারি।
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1.5">আমি শুধু দেখি আর পথ দেখাই (ছুটির আবেদন আপনি নিজে জমা দেন)। মানুষের সাহায্য লাগলে বলুন "মানুষের সাথে কথা বলতে চাই"।</p>
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
                      {m.report && <ReportButtons token={token} report={m.report} preparedBy={user?.name || ''} />}
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

              {supportError && <p className="text-[11px] text-rose-600 px-1">{supportError}</p>}
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
            </>
            )}
          </div>
        </div>
        </>
      )}
    </>
  );
};

export default AiAssistant;

// ---- the phone edge tab ------------------------------------------------------
const TAB_KEY = 'credence_assistant_tab_y';
const TAB_H = 48;

const EdgeTab: React.FC<{ count: number; onOpen: () => void }> = ({ count, onOpen }) => {
  const scrolling = useScrolling();
  // Distance from the bottom of the screen, so it stays put above the
  // keyboard / bottom bars on any phone height.
  const [bottom, setBottom] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(TAB_KEY));
      if (Number.isFinite(v) && v > 0) return v;
    } catch {
      // storage unavailable — the default place
    }
    return 132;
  });
  const drag = useRef<{ startY: number; startBottom: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const clamp = (b: number) => Math.min(window.innerHeight - TAB_H - 80, Math.max(72, b));
  useEffect(() => {
    const onResize = () => setBottom((b) => clamp(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div
      className="assistant-fab assistant-edge-tab fixed z-50 right-0 transition-transform duration-300 ease-out"
      style={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom, 0px))`, transform: scrolling && !drag.current ? 'translateX(110%)' : 'translateX(0)' }}
    >
      <button
        type="button"
        title="Credence Assistant — drag to move"
        aria-label="Open Credence Assistant"
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startBottom: bottom, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = e.clientY - d.startY;
          if (Math.abs(dy) > 6) d.moved = true;
          if (d.moved) setBottom(clamp(d.startBottom - dy));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          justDragged.current = !!d?.moved;
          if (d?.moved) {
            try {
              localStorage.setItem(TAB_KEY, String(Math.round(bottom)));
            } catch {
              // storage unavailable — the place just isn't remembered
            }
          }
        }}
        onPointerCancel={() => (drag.current = null)}
        // Opens on the click (not on finger-up), so the click that follows a
        // tap doesn't land on the Assistant's backdrop and close it again.
        onClick={() => {
          if (justDragged.current) {
            justDragged.current = false;
            return;
          }
          onOpen();
        }}
        className="liquid-glass-button w-10 rounded-l-2xl rounded-r-none flex items-center justify-center touch-none select-none shadow-lg"
        style={{ height: TAB_H }}
      >
        <Sparkles className="w-[18px] h-[18px]" />
      </button>
      {count > 0 && (
        <span className="absolute -top-1.5 left-[-6px] min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white pointer-events-none">
          {count}
        </span>
      )}
    </div>
  );
};

