/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> MIS -> User Feedback (module "user_feedback"). Everything
// sent from "Give feedback" and the "How do you like the app?" question:
// the average rating, how many of each star and kind, and every piece of
// feedback with who sent it, from where and on which version. A Superadmin
// also turns the question on/off and sets after how many days it is asked.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, Bug, Lightbulb, MessageSquareHeart, Loader2, RefreshCw, Search, Smartphone, Monitor, Tablet, Image as ImageIcon, X, Clock, CheckCircle2, RotateCcw, ArrowUpDown } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from '../mail/MailPopup';
import { confirmDialog } from '../../lib/confirmDialog';

type Row = {
  id: number;
  user_name: string;
  user_email: string;
  rating: number | null;
  kind: 'bug' | 'idea' | 'general';
  module: string | null;
  message: string | null;
  has_screenshot: boolean;
  page: string | null;
  device: string | null;
  client: string | null;
  app_version: string | null;
  source: string;
  created_at: string;
  // pending / done; 'na' = a rating only (nothing to follow up)
  status: 'pending' | 'done' | 'na';
  resolved_at: string | null;
  resolved_by_name: string | null;
  resolve_note: string | null;
  // Minutes since it was sent (or until it was marked Done).
  age_minutes: number;
};
type Data = {
  summary: { total: number; average: number | null; byStars: number[]; byKind: Record<string, number> };
  rows: Row[];
  follow_up: { pending: number; done: number; oldest_pending_minutes: number | null };
  can_resolve: boolean;
  settings: { prompt_enabled: number; prompt_after_days: number };
};

const KIND = {
  bug: { label: 'Problem', icon: Bug, cls: 'bg-rose-50 text-rose-700' },
  idea: { label: 'Idea', icon: Lightbulb, cls: 'bg-amber-50 text-amber-700' },
  general: { label: 'General', icon: MessageSquareHeart, cls: 'bg-violet-50 text-violet-700' }
} as const;
const DEVICE: Record<string, React.ElementType> = { phone: Smartphone, tablet: Tablet, computer: Monitor };
const ctl = 'px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm';

// "3 hours", "5 days", "2 months" — how long something has waited.
const span = (min: number) => {
  if (min < 60) return 'under an hour';
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} day${d === 1 ? '' : 's'}`;
  const m = Math.floor(d / 30);
  return `${m} month${m === 1 ? '' : 's'}`;
};
// Waiting a few days is fine, a week is getting long, two weeks is late.
const waitCls = (min: number) => (min >= 14 * 1440 ? 'bg-rose-50 text-rose-700' : min >= 7 * 1440 ? 'bg-amber-50 text-amber-700' : 'bg-sky-50 text-sky-700');

const StarRow: React.FC<{ n: number }> = ({ n }) => (
  <span className="inline-flex" aria-label={`${n} of 5 stars`}>
    {[1, 2, 3, 4, 5].map((i) => (
      <Star key={i} className={`w-4 h-4 ${i <= n ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} strokeWidth={1.5} />
    ))}
  </span>
);

// The screenshot needs the sign-in token, so it is fetched and shown from memory.
const Shot: React.FC<{ id: number; token: string }> = ({ id, token }) => {
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let u = '';
    let off = false;
    fetch(apiUrl(`/api/feedback/${id}/screenshot`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !off) setUrl((u = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      off = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [id, token]);
  if (!url)
    return (
      <div className="w-20 h-20 rounded-xl bg-slate-100 flex items-center justify-center">
        <ImageIcon className="w-5 h-5 text-slate-400" />
      </div>
    );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="shrink-0" aria-label="Open screenshot">
        <img src={url} alt="Screenshot" className="w-20 h-20 object-cover rounded-xl border border-slate-200" />
      </button>
      {open &&
        // On document.body: a card with the Dark Glass blur would otherwise
        // hold this "fixed" layer inside itself (behind the next cards).
        createPortal(
        <div className="fixed inset-0 z-[300] liquid-glass-backdrop flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="liquid-glass liquid-glass-in rounded-[32px] p-3 max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end mb-2">
              <button type="button" onClick={() => setOpen(false)} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="liquid-glass-inset rounded-[24px] p-2">
              <img src={url} alt="Screenshot" className="max-h-[75vh] w-full object-contain rounded-2xl" />
            </div>
          </div>
        </div>,
          document.body
        )}
    </>
  );
};

export const FeedbackAdmin: React.FC<{ token: string; isSuperAdmin: boolean }> = ({ token, isSuperAdmin }) => {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('');
  const [rating, setRating] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [doneFor, setDoneFor] = useState<Row | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams();
      if (kind) p.set('kind', kind);
      if (rating) p.set('rating', rating);
      if (status) p.set('status', status);
      if (oldestFirst) p.set('sort', 'oldest');
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (q.trim()) p.set('q', q.trim());
      const res = await fetch(apiUrl(`/api/feedback?${p}`), { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load feedback');
      setData(d);
      setEnabled(!!Number(d.settings?.prompt_enabled));
      setDays(Number(d.settings?.prompt_after_days) || 7);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, kind, rating, from, to, q, status, oldestFirst]);
  // Filters apply on change; the search box on Enter / the button.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [token, kind, rating, from, to, status, oldestFirst]);

  // Mark Done (with a note) or take it back to Pending.
  const setState = async (r: Row, to: 'done' | 'pending', why = '') => {
    setActing(true);
    setActError('');
    try {
      const res = await fetch(apiUrl(`/api/feedback/${r.id}/status`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: to, note: why })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not change it');
      setDoneFor(null);
      setNote('');
      await load();
    } catch (e: any) {
      setActError(e.message);
      if (!doneFor) setError(e.message);
    } finally {
      setActing(false);
    }
  };
  const reopen = async (r: Row) => {
    if (!(await confirmDialog(`Put this feedback from ${r.user_name} back to Pending?`, { title: 'Reopen feedback', confirmLabel: 'Reopen', tone: 'default' }))) return;
    await setState(r, 'pending');
  };

  const saveSettings = async () => {
    setSaving(true);
    setSaved('');
    try {
      const res = await fetch(apiUrl('/api/feedback/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt_enabled: enabled, prompt_after_days: days })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save');
      setDays(d.prompt_after_days);
      setSaved('Saved');
    } catch (e: any) {
      setSaved(e.message);
    } finally {
      setSaving(false);
    }
  };

  const s = data?.summary;
  const maxStar = Math.max(1, ...(s?.byStars || [0]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <MessageSquareHeart className="w-5 h-5 text-violet-600" /> User Feedback
          </h2>
          <p className="text-xs text-slate-500">Ratings, problems and ideas sent from the app.</p>
        </div>
        <button type="button" onClick={() => void load()} className={`${ctl} flex items-center gap-1.5`} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
        </button>
      </div>

      {s && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Average rating</div>
            <div className="flex items-end gap-2 mt-1">
              <span className="text-3xl font-bold text-slate-800">{s.average ?? '—'}</span>
              <span className="text-xs text-slate-500 mb-1">of 5 · {s.total} sent</span>
            </div>
            {s.average != null && <StarRow n={Math.round(s.average)} />}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => (
              <button key={n} type="button" onClick={() => setRating(rating === String(n) ? '' : String(n))} className="w-full flex items-center gap-2 text-xs">
                <span className={`w-6 text-right ${rating === String(n) ? 'font-bold text-violet-700' : 'text-slate-600'}`}>{n}★</span>
                <span className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                  <span className="block h-full bg-amber-400 rounded-full" style={{ width: `${(s.byStars[n - 1] / maxStar) * 100}%` }} />
                </span>
                <span className="w-6 text-slate-500">{s.byStars[n - 1]}</span>
              </button>
            ))}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 grid grid-cols-3 gap-2">
            {(Object.keys(KIND) as (keyof typeof KIND)[]).map((k) => {
              const { label, icon: Icon, cls } = KIND[k];
              return (
                <button key={k} type="button" onClick={() => setKind(kind === k ? '' : k)} className={`rounded-xl p-2 text-center ${cls} ${kind === k ? 'ring-2 ring-violet-500' : ''}`}>
                  <Icon className="w-4 h-4 mx-auto" />
                  <div className="text-xl font-bold">{s.byKind[k] || 0}</div>
                  <div className="text-[11px]">{label}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {data && (
        <div className="flex flex-wrap items-center gap-2">
          {([['', 'All', null], ['pending', 'Pending', data.follow_up.pending], ['done', 'Done', data.follow_up.done]] as const).map(([k, label, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setStatus(k)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${status === k ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
            >
              {label}
              {n !== null && <span className={`ml-1.5 text-xs ${status === k ? 'text-violet-100' : 'text-slate-500'}`}>{n}</span>}
            </button>
          ))}
          {data.follow_up.oldest_pending_minutes != null && (
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${waitCls(data.follow_up.oldest_pending_minutes)}`}>
              <Clock className="w-3.5 h-3.5" /> Longest waiting: {span(data.follow_up.oldest_pending_minutes)}
            </span>
          )}
          <button type="button" onClick={() => setOldestFirst((v) => !v)} className={`${ctl} ml-auto flex items-center gap-1.5 ${oldestFirst ? 'border-violet-400 text-violet-700' : ''}`} aria-pressed={oldestFirst}>
            <ArrowUpDown className="w-4 h-4" /> {oldestFirst ? 'Oldest first' : 'Newest first'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <select className={ctl} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          <option value="bug">Problems</option>
          <option value="idea">Ideas</option>
          <option value="general">General</option>
        </select>
        <select className={ctl} value={rating} onChange={(e) => setRating(e.target.value)} aria-label="Rating">
          <option value="">All ratings</option>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>
          ))}
        </select>
        <input type="date" className={ctl} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" className={ctl} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <form
          className="flex gap-1 flex-1 min-w-[200px]"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <input className={`${ctl} flex-1 min-w-0`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text, part or name" />
          <button type="submit" className={ctl} aria-label="Search">
            <Search className="w-4 h-4" />
          </button>
        </form>
      </div>

      {error && <div className="text-sm px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      <div className="space-y-2">
        {data && !data.rows.length && <div className="text-sm text-slate-500 text-center py-10">No feedback yet.</div>}
        {data?.rows.map((r) => {
          const K = KIND[r.kind] || KIND.general;
          const Dev = DEVICE[r.device || ''] || Monitor;
          return (
            <div key={r.id} className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 flex gap-3">
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {r.rating ? <StarRow n={r.rating} /> : null}
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${K.cls}`}>
                    <K.icon className="w-3 h-3" /> {K.label}
                  </span>
                  {r.module && <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{r.module}</span>}
                  {r.source === 'prompt' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">From the question</span>}
                  {r.status === 'pending' && (
                    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${waitCls(r.age_minutes)}`} title={`Sent ${new Date(r.created_at).toLocaleString()}`}>
                      <Clock className="w-3 h-3" /> Pending · {span(r.age_minutes)}
                    </span>
                  )}
                  {r.status === 'done' && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                      <CheckCircle2 className="w-3 h-3" /> Done · took {span(r.age_minutes)}
                    </span>
                  )}
                </div>
                {r.message && <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">{r.message}</p>}
                <div className="text-xs text-slate-600">
                  <span className="font-semibold">{r.user_name}</span> <span className="text-slate-400">{r.user_email}</span>
                </div>
                <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] text-slate-500">
                  <span>{new Date(r.created_at).toLocaleString()}</span>
                  <span className="inline-flex items-center gap-1">
                    <Dev className="w-3 h-3" /> {r.device || '—'} · {r.client === 'app' ? 'App' : 'Website'}
                  </span>
                  {r.app_version && <span>v {r.app_version}</span>}
                  {r.page && <span className="truncate max-w-[220px]" title={r.page}>{r.page}</span>}
                </div>
                {r.status === 'done' && (
                  <div className="text-[11px] text-emerald-700 bg-emerald-50/70 rounded-lg px-2 py-1">
                    Done{r.resolved_by_name ? ` by ${r.resolved_by_name}` : ''}{r.resolved_at ? ` · ${new Date(r.resolved_at).toLocaleString()}` : ''}
                    {r.resolve_note && <span className="block text-slate-700 whitespace-pre-wrap break-words">{r.resolve_note}</span>}
                  </div>
                )}
                {data.can_resolve && r.status === 'pending' && (
                  <button type="button" onClick={() => { setDoneFor(r); setNote(''); setActError(''); }} className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-600 text-white text-xs font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Mark done
                  </button>
                )}
                {data.can_resolve && r.status === 'done' && (
                  <button type="button" onClick={() => void reopen(r)} disabled={acting} className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50">
                    <RotateCcw className="w-3.5 h-3.5" /> Reopen
                  </button>
                )}
              </div>
              {r.has_screenshot && <Shot id={r.id} token={token} />}
            </div>
          );
        })}
      </div>

      {doneFor && (
        <Popup
          title="Mark feedback as done"
          icon={<CheckCircle2 className="w-4 h-4" />}
          size="md"
          onClose={acting ? () => {} : () => setDoneFor(null)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setDoneFor(null)} disabled={acting}>Cancel</button>
              <button type="button" className={primaryBtn} onClick={() => void setState(doneFor, 'done', note)} disabled={acting}>
                {acting && <Loader2 className="w-4 h-4 animate-spin" />} Mark done
              </button>
            </>
          }
        >
          <div className="space-y-3 text-left">
            <p className="text-sm text-slate-600">
              From <b>{doneFor.user_name}</b>, waiting for {span(doneFor.age_minutes)}.
              {doneFor.message && <span className="block mt-1 text-slate-700 line-clamp-3">"{doneFor.message}"</span>}
            </p>
            <div>
              <label className={labelCls} htmlFor="fb-done-note">What was done? (optional)</label>
              <textarea id="fb-done-note" className={`${inputCls} min-h-[80px]`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Fixed in the next update" />
            </div>
            {actError && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{actError}</div>}
          </div>
        </Popup>
      )}

      {isSuperAdmin && data && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-800">"How do you like the app?" question</div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4" />
            Ask accounts that can give feedback
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Ask after
            <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${ctl} w-20`} disabled={!enabled} />
            days of use (and again that long after "Later")
          </label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void saveSettings()} disabled={saving} className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center gap-1.5">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
            </button>
            {saved && <span className="text-xs text-slate-500">{saved}</span>}
          </div>
        </div>
      )}
    </div>
  );
};
