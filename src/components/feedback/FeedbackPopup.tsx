/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> Give feedback (server: FeedbackRoutes.ts; the account
// needs users.can_give_feedback, a Superadmin always). A 1–5 star rating,
// what kind (problem / idea / general), which part of the app, the details
// and an optional screenshot. The page it was sent from, phone / tablet /
// computer, app or website and the version go with it on their own.
// Also the "How do you like the app?" question asked once after 7 days
// (FeedbackPrompt below).

import React, { useEffect, useRef, useState } from 'react';
import { Star, Bug, Lightbulb, MessageSquareHeart, ImagePlus, X, Loader2, CheckCircle2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from '../mail/MailPopup';
import { apiUrl } from '../../lib/api';
import type { User } from '../../types';

export const canGiveFeedback = (u?: Pick<User, 'role' | 'can_give_feedback' | 'is_onboarding'> | null) =>
  !!u && !u.is_onboarding && (u.role === 'superadmin' || !!u.can_give_feedback);

// 16px text on phones so iOS doesn't zoom in on a field.
const fieldCls = inputCls.replace('text-sm', 'text-base sm:text-sm');
export const FEEDBACK_AREAS = ['Dashboard', 'Leave', 'Attendance', 'Payroll / Payslip', 'Claims & Bills', 'Approvals', 'Chat', 'Notices', 'PEPM / MPR', 'Assets & Vehicles', 'Profile & Login', 'Other'];
const KINDS = [
  { key: 'bug', label: 'Problem', icon: Bug },
  { key: 'idea', label: 'Idea', icon: Lightbulb },
  { key: 'general', label: 'General', icon: MessageSquareHeart }
] as const;
type Kind = (typeof KINDS)[number]['key'];

// What goes with every piece of feedback on its own.
async function context() {
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const device = touch && w < 768 ? 'phone' : touch && w < 1100 ? 'tablet' : 'computer';
  const native = Capacitor.isNativePlatform();
  let version = `web ${typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : ''}`.trim();
  if (native) {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      version = `${info.version} (${info.build})`;
    } catch {
      version = 'app';
    }
  }
  return { page: `${window.location.pathname}${window.location.search}`.slice(0, 255), device, client: native ? 'app' : 'web', app_version: version };
}

export async function sendFeedback(token: string, body: Record<string, any>) {
  const res = await fetch(apiUrl('/api/feedback'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, ...(await context()) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not send your feedback');
  return data;
}

export const Stars: React.FC<{ value: number; onChange: (v: number) => void; size?: string }> = ({ value, onChange, size = 'w-9 h-9' }) => (
  <div className="flex items-center justify-center gap-1.5" role="radiogroup" aria-label="Rating">
    {[1, 2, 3, 4, 5].map((n) => (
      <button key={n} type="button" onClick={() => onChange(n === value ? 0 : n)} role="radio" aria-checked={n === value} aria-label={`${n} star${n === 1 ? '' : 's'}`} className="p-0.5 transition-transform active:scale-90">
        <Star className={`${size} ${n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} strokeWidth={1.5} />
      </button>
    ))}
  </div>
);
const STAR_WORDS = ['', 'Very poor', 'Poor', 'Okay', 'Good', 'Excellent'];

export const FeedbackPopup: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [rating, setRating] = useState(0);
  const [kind, setKind] = useState<Kind>('general');
  const [area, setArea] = useState('');
  const [message, setMessage] = useState('');
  const [shot, setShot] = useState<{ base64: string; mime: string; url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

  const pickShot = (f?: File | null) => {
    setError('');
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(f.type)) return setError('The screenshot must be an image (PNG / JPG / WEBP).');
    if (f.size > 3 * 1024 * 1024) return setError('The screenshot must be under 3 MB.');
    const reader = new FileReader();
    reader.onload = () => setShot({ base64: String(reader.result).split(',')[1] || '', mime: f.type, url: URL.createObjectURL(f), name: f.name });
    reader.readAsDataURL(f);
  };
  const ready = kind === 'bug' ? !!message.trim() : !!rating || !!message.trim();
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await sendFeedback(token, {
        rating: rating || null,
        kind,
        module: area,
        message,
        screenshot_base64: shot?.base64,
        screenshot_mimetype: shot?.mime,
        source: 'button'
      });
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <Popup title="Thank you!" icon={<CheckCircle2 className="w-4 h-4" />} size="md" onClose={onClose} footer={<button type="button" className={primaryBtn} onClick={onClose}>Close</button>}>
        <div className="text-center py-4 space-y-2">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
          <p className="text-sm text-slate-700">Your feedback reached the team. It helps make the app better.</p>
        </div>
      </Popup>
    );

  return (
    <Popup
      title="Give feedback"
      icon={<MessageSquareHeart className="w-4 h-4" />}
      size="md"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void send()} disabled={busy || !ready}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Send
          </button>
        </>
      }
    >
      <div className="space-y-4 text-left">
        <div className="liquid-glass-inset rounded-[24px] py-3 px-2 text-center">
          <div className="text-xs font-medium text-slate-600 mb-1.5">How do you rate the app?</div>
          <Stars value={rating} onChange={setRating} />
          <div className="text-xs text-slate-500 mt-1 h-4">{STAR_WORDS[rating]}</div>
        </div>
        <div>
          <span className={labelCls}>What is it about?</span>
          <div className="grid grid-cols-3 gap-1.5">
            {KINDS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setKind(key)}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-xl text-xs font-semibold border ${kind === key ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white/80 border-slate-200 text-slate-700'}`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls}>Which part of the app?</label>
          <select className={fieldCls} value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Choose (optional)</option>
            {FEEDBACK_AREAS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{kind === 'bug' ? 'What went wrong? (needed)' : kind === 'idea' ? 'Your idea' : 'Tell us more (optional)'}</label>
          <textarea
            className={`${fieldCls} min-h-[96px]`}
            value={message}
            maxLength={4000}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={kind === 'bug' ? 'What were you doing, and what happened?' : kind === 'idea' ? 'What would make your work easier?' : ''}
          />
        </div>
        <div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => pickShot(e.target.files?.[0])} />
          {shot ? (
            <div className="liquid-glass-inset rounded-[20px] p-2 flex items-center gap-3">
              <img src={shot.url} alt="Screenshot" className="w-16 h-16 object-cover rounded-xl" />
              <span className="flex-1 min-w-0 text-xs text-slate-600 truncate">{shot.name}</span>
              <button type="button" onClick={() => setShot(null)} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center" aria-label="Remove screenshot">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-slate-300 text-sm text-slate-600 hover:bg-white/60">
              <ImagePlus className="w-4 h-4" /> Add a screenshot (optional)
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-500">The page you are on, your device and the app version are sent with it, to help find the problem.</p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// "How do you like the app?" — asked once, a week after the account first
// opened the app (the server decides when). Later = in another week; Don't
// ask again = never.
export const FeedbackPrompt: React.FC<{ token: string }> = ({ token }) => {
  const [show, setShow] = useState(false);
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let off = false;
    // Not on top of the first seconds of work.
    const t = setTimeout(() => {
      fetch(apiUrl('/api/feedback/prompt'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : { show: false }))
        .then((d) => !off && setShow(!!d.show))
        .catch(() => {});
    }, 8000);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [token]);
  const answer = (action: 'later' | 'never') => {
    setShow(false);
    void fetch(apiUrl('/api/feedback/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action })
    }).catch(() => {});
  };
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await sendFeedback(token, { rating, kind: 'general', message, source: 'prompt' });
      setDone(true);
      setTimeout(() => setShow(false), 1800);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!show) return null;
  return (
    <Popup
      title="How do you like the app?"
      icon={<MessageSquareHeart className="w-4 h-4" />}
      size="md"
      onClose={() => (done ? setShow(false) : answer('later'))}
      footer={
        done ? undefined : (
          <>
            <button type="button" className={ghostBtn} onClick={() => answer('never')} disabled={busy}>Don't ask again</button>
            <button type="button" className={ghostBtn} onClick={() => answer('later')} disabled={busy}>Later</button>
            <button type="button" className={primaryBtn} onClick={() => void send()} disabled={busy || !rating}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Send
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="text-center py-4 space-y-2">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
          <p className="text-sm text-slate-700">Thank you for your rating!</p>
        </div>
      ) : (
        <div className="space-y-3 text-left">
          <p className="text-sm text-slate-600 text-center">You have been using the app for a while — how is it going?</p>
          <div className="liquid-glass-inset rounded-[24px] py-3 px-2 text-center">
            <Stars value={rating} onChange={setRating} size="w-10 h-10" />
            <div className="text-xs text-slate-500 mt-1 h-4">{STAR_WORDS[rating]}</div>
          </div>
          {rating > 0 && (
            <textarea
              className={`${fieldCls} min-h-[72px]`}
              value={message}
              maxLength={4000}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={rating <= 3 ? 'What should we improve? (optional)' : 'What do you like most? (optional)'}
            />
          )}
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </div>
      )}
    </Popup>
  );
};

// Mounted once in App.tsx for an account that may give feedback: the
// "Give feedback" entries elsewhere (the phone's More menu) open the popup
// with a 'credence:open-feedback' event, and the 7-day question rides along.
export const FeedbackHost: React.FC<{ token: string }> = ({ token }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('credence:open-feedback', onOpen);
    return () => window.removeEventListener('credence:open-feedback', onOpen);
  }, []);
  return (
    <>
      <FeedbackPrompt token={token} />
      {open && <FeedbackPopup token={token} onClose={() => setOpen(false)} />}
    </>
  );
};
