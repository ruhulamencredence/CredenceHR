/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Duty Roster -> Guard Posts (GuardRoutes.ts, layer
// "guard_posts"): the posts at each site and how many guards each shift
// needs, a week of coverage (empty posts in red), a relief guard in two taps,
// and a month filled from a pattern (6 on · 1 off, day ↔ night every week,
// 4 day · 4 night · 2 off). Guards check in like everyone else — this only
// says who should stand where. Relief time is overtime waiting for approval
// (OvertimeRoutes.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Save, Search, ShieldCheck, Trash2, UserPlus, Wand2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { SearchSelect } from './Combobox';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';

interface ShiftLite {
  id: number;
  name: string;
  code: string;
  start_time: string;
  end_time: string;
  color: string;
  is_active: boolean;
}
interface Post {
  id: number;
  name: string;
  site: string | null;
  is_active: boolean;
  needs: { shift_id: number; headcount: number }[];
}
interface PersonLite {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
}
interface CoveragePerson {
  employee_id: number;
  name: string;
  relief: boolean;
  relief_id: number | null;
}
interface Coverage {
  dates: string[];
  posts: { id: number; name: string; site: string | null; rows: { shift_id: number; headcount: number; days: { date: string; people: CoveragePerson[]; empty: number }[] }[] }[];
}
interface FreePerson extends PersonLite {
  guard: boolean;
  kind: 'off' | 'free' | 'double';
  own_shift: string | null;
}

async function api<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + n);
  return ymdOf(t);
};
const dayHead = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
const dayLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const personText = (p: PersonLite) => [p.name, p.employee_code, p.designation, p.department].filter(Boolean).join(' · ');
const PATTERNS = [
  ['six_one', '6 on · 1 off'],
  ['day_night_week', 'Day ↔ Night every week (6 on · 1 off)'],
  ['four_four_two', '4 day · 4 night · 2 off']
] as const;
const violetBtn = primaryBtn.replace('bg-sky-600', 'bg-violet-600');

// ---------------------------------------------------------------------------
const PostForm: React.FC<{ token: string; post: Post | null; shifts: ShiftLite[]; onClose: () => void; onSaved: () => void }> = ({ token, post, shifts, onClose, onSaved }) => {
  const [name, setName] = useState(post?.name || '');
  const [site, setSite] = useState(post?.site || '');
  const [needs, setNeeds] = useState<Record<number, string>>(() => Object.fromEntries((post?.needs || []).map((n) => [n.shift_id, String(n.headcount)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name, site, needs: Object.entries(needs).map(([shift_id, headcount]) => ({ shift_id: Number(shift_id), headcount: Number(headcount) || 0 })) };
      if (post) await api(token, `/api/guard/posts/${post.id}`, { method: 'PUT', body });
      else await api(token, '/api/guard/posts', { method: 'POST', body });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title={post ? 'Edit post' : 'New post'}
      icon={<ShieldCheck className="w-4 h-4 text-violet-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={violetBtn} disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="gp-name">Post</label>
          <input id="gp-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Main Gate" autoFocus />
        </div>
        <div>
          <label className={labelCls} htmlFor="gp-site">Site</label>
          <input id="gp-site" className={inputCls} value={site} onChange={(e) => setSite(e.target.value)} placeholder="Credence Skyline Site" />
        </div>
        <div>
          <div className={labelCls}>Guards needed on each shift (0 = none)</div>
          <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
            {shifts.filter((s) => s.is_active).map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-[2.5rem] h-7 px-1.5 rounded-lg text-white text-xs font-bold flex items-center justify-center" style={{ background: s.color }}>{s.code}</span>
                <span className="flex-1 text-sm text-slate-700">{s.name} · {s.start_time}–{s.end_time}</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  aria-label={`Guards on ${s.name}`}
                  className="w-16 h-8 rounded-lg border border-slate-200 text-center text-sm"
                  value={needs[s.id] ?? ''}
                  onChange={(e) => setNeeds((n) => ({ ...n, [s.id]: e.target.value }))}
                  placeholder="0"
                />
              </li>
            ))}
          </ul>
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

const PatternForm: React.FC<{ token: string; posts: Post[]; shifts: ShiftLite[]; people: PersonLite[]; onClose: () => void; onSaved: (n: number) => void }> = ({ token, posts, shifts, people, onClose, onSaved }) => {
  const today = ymdOf(new Date());
  const [postId, setPostId] = useState(posts[0] ? String(posts[0].id) : '');
  const [pattern, setPattern] = useState<string>('six_one');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 29));
  const active = shifts.filter((s) => s.is_active);
  const [dayShift, setDayShift] = useState(active[0] ? String(active[0].id) : '');
  const [nightShift, setNightShift] = useState(active.find((s) => s.end_time <= s.start_time) ? String(active.find((s) => s.end_time <= s.start_time)!.id) : '');
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return people.filter((p) => !t || personText(p).toLowerCase().includes(t)).slice(0, 200);
  }, [people, q]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ saved: number }>(token, '/api/guard/pattern', {
        method: 'POST',
        body: { post_id: Number(postId), employee_ids: picked, from, to, pattern, day_shift_id: Number(dayShift), night_shift_id: nightShift ? Number(nightShift) : null }
      });
      onSaved(r.saved);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Fill the month with a pattern"
      icon={<Wand2 className="w-4 h-4 text-violet-600" />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={violetBtn} disabled={busy || !postId || !picked.length || !dayShift} onClick={() => void save()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Fill the roster
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Post</label>
            <SearchSelect className={inputCls} value={postId} onChange={(e) => setPostId(e.target.value)} aria-label="Post">
              <option value="">— Select post —</option>
              {posts.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name}{p.site ? ` · ${p.site}` : ''}</option>
              ))}
            </SearchSelect>
          </div>
          <div>
            <label className={labelCls} htmlFor="gp-pattern">Pattern</label>
            <select id="gp-pattern" className={inputCls} value={pattern} onChange={(e) => setPattern(e.target.value)}>
              {PATTERNS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Day shift</label>
            <SearchSelect className={inputCls} value={dayShift} onChange={(e) => setDayShift(e.target.value)} aria-label="Day shift">
              <option value="">— Select shift —</option>
              {active.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.code} · {s.name} ({s.start_time}–{s.end_time})</option>
              ))}
            </SearchSelect>
          </div>
          <div>
            <label className={labelCls}>Night shift {pattern === 'six_one' ? '(not used)' : ''}</label>
            <SearchSelect className={inputCls} value={nightShift} onChange={(e) => setNightShift(e.target.value)} aria-label="Night shift">
              <option value="">— Select shift —</option>
              {active.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.code} · {s.name} ({s.start_time}–{s.end_time})</option>
              ))}
            </SearchSelect>
          </div>
          <div>
            <label className={labelCls} htmlFor="gp-from">From</label>
            <input id="gp-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="gp-to">To (at most 62 days)</label>
            <input id="gp-to" type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div>
          <div className={labelCls}>Guards ({picked.length} picked) — their Off days are spread so the post stays covered</div>
          <div className="relative mb-2">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Employee ID, designation, department…" aria-label="Search guards" className={`${inputCls} pl-9`} />
          </div>
          <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70 max-h-60 overflow-y-auto">
            {list.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                  <input type="checkbox" className="accent-violet-600" checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                  <span className="text-sm text-slate-700 truncate">{personText(p)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[11px] text-slate-500">This writes the Duty Roster for these days (shift + post, or Off). Change any day by hand afterwards.</p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

const ReliefForm: React.FC<{ token: string; post: { id: number; name: string }; shift: ShiftLite; date: string; empty: number; onClose: () => void; onSaved: (name: string) => void }> = ({ token, post, shift, date, empty, onClose, onSaved }) => {
  const [people, setPeople] = useState<FreePerson[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ people: FreePerson[] }>(token, `/api/guard/free?date=${date}&shift_id=${shift.id}`)
      .then((r) => setPeople(r.people))
      .catch((e) => setError(e.message));
  }, [token, date, shift.id]);
  const chosen = people?.find((p) => String(p.id) === pick);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(token, '/api/guard/relief', { method: 'POST', body: { employee_id: Number(pick), date, post_id: post.id, shift_id: shift.id } });
      onSaved(chosen?.name || '');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const kindText = (p: FreePerson) => (p.kind === 'off' ? 'Off that day' : p.kind === 'double' ? `on ${p.own_shift} — double duty` : 'not rostered');
  return (
    <Popup
      title={`${post.name} · ${dayLong(date)}`}
      icon={<UserPlus className="w-4 h-4 text-violet-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={violetBtn} disabled={busy || !pick} onClick={() => void save()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Put as relief
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          {shift.code} · {shift.name} ({shift.start_time}–{shift.end_time}) — <b className="text-rose-700">{empty} empty</b>
        </p>
        {!people && !error ? (
          <LoadingBlock />
        ) : (
          <div>
            <label className={labelCls}>Who covers it (guards first)</label>
            <SearchSelect className={inputCls} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Relief guard">
              <option value="">— Select employee —</option>
              {(people || []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {personText(p)} · {kindText(p)}
                </option>
              ))}
            </SearchSelect>
          </div>
        )}
        {chosen && (
          <p className="liquid-glass-inset rounded-xl px-3 py-2 text-xs text-slate-700">
            {chosen.kind === 'double'
              ? `${chosen.name} already works ${chosen.own_shift} that day — this shift is extra: overtime, waiting for approval.`
              : `${chosen.name} is ${chosen.kind === 'off' ? 'off that day' : 'not rostered'} — the whole shift is overtime${chosen.kind === 'off' ? ' at the Off day rate' : ''}, waiting for approval.`}
          </p>
        )}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
export const GuardPostsPanel: React.FC<{ token: string }> = ({ token }) => {
  const [from, setFrom] = useState(() => ymdOf(new Date()));
  const to = addDays(from, 6);
  const [posts, setPosts] = useState<Post[]>([]);
  const [shifts, setShifts] = useState<ShiftLite[]>([]);
  const [people, setPeople] = useState<PersonLite[]>([]);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Post | 'new' | null>(null);
  const [patternOpen, setPatternOpen] = useState(false);
  const [relief, setRelief] = useState<{ post: { id: number; name: string }; shift: ShiftLite; date: string; empty: number } | null>(null);

  const loadPosts = useCallback(async () => {
    const r = await api<{ posts: Post[]; shifts: ShiftLite[]; people: PersonLite[] }>(token, '/api/guard/posts');
    setPosts(r.posts);
    setShifts(r.shifts);
    setPeople(r.people);
  }, [token]);
  const loadCoverage = useCallback(async () => {
    setCov(null);
    setCov(await api<Coverage>(token, `/api/guard/coverage?from=${from}&to=${to}`));
  }, [token, from, to]);
  const loadAll = useCallback(async () => {
    try {
      setError('');
      await Promise.all([loadPosts(), loadCoverage()]);
    } catch (e: any) {
      setError(e.message);
    }
  }, [loadPosts, loadCoverage]);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const shiftById = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);
  const removePost = async (p: Post) => {
    if (!(await confirmDialog(`Remove the post "${p.name}"? If it is already on the roster it is switched off instead.`, { confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      const r = await api<{ archived: boolean }>(token, `/api/guard/posts/${p.id}`, { method: 'DELETE' });
      setNotice(r.archived ? `"${p.name}" is on the roster, so it was switched off.` : `"${p.name}" removed.`);
      await loadAll();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const removeRelief = async (person: CoveragePerson, date: string) => {
    if (!person.relief_id || !(await confirmDialog(`Remove ${person.name} as relief on ${dayLong(date)}?`, { confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(token, `/api/guard/relief/${person.relief_id}`, { method: 'DELETE' });
      await loadCoverage();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const emptyTotal = (cov?.posts || []).reduce((a, p) => a + p.rows.reduce((b, r) => b + r.days.reduce((c, d) => c + d.empty, 0), 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center rounded-xl bg-white border border-slate-200">
          <button type="button" onClick={() => setFrom((f) => addDays(f, -7))} className="p-2 hover:bg-slate-50 rounded-l-xl" aria-label="Previous week">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 text-sm font-semibold text-slate-800 min-w-[10rem] text-center">
            {dayHead(from)} – {dayHead(to)}
          </span>
          <button type="button" onClick={() => setFrom((f) => addDays(f, 7))} className="p-2 hover:bg-slate-50 rounded-r-xl" aria-label="Next week">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        {cov && (
          <span className={`text-xs font-semibold rounded-full px-3 py-1 ${emptyTotal ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {emptyTotal ? `${emptyTotal} empty this week` : 'Every post covered'}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => setPatternOpen(true)} disabled={!posts.length} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <Wand2 className="w-4 h-4 text-violet-600" /> Fill the month with a pattern
        </button>
        <button type="button" onClick={() => setEditing('new')} disabled={!shifts.length} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
          <Plus className="w-4 h-4" /> New post
        </button>
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}
      {!shifts.length && cov && <div className="text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">Add the guard shifts first (Shifts tab), e.g. Guard Day 08:00–20:00 and Guard Night 20:00–08:00.</div>}

      {!cov ? (
        <LoadingBlock />
      ) : !cov.posts.length ? (
        <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">No posts yet — add Main Gate, Store…</div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2.5 text-left font-semibold min-w-[11rem]">Post · needs</th>
                  <th className="px-2 py-2.5 text-left font-semibold">Shift</th>
                  {cov.dates.map((d) => (
                    <th key={d} className="px-2 py-2.5 text-left font-semibold min-w-[7.5rem]">{dayHead(d)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cov.posts.map((p) =>
                  p.rows.map((r, i) => {
                    const s = shiftById.get(r.shift_id);
                    const post = posts.find((x) => x.id === p.id);
                    return (
                      <tr key={`${p.id}-${r.shift_id}`}>
                        <td className="sticky left-0 z-10 bg-white border-t border-slate-100 px-3 py-2 align-top">
                          {i === 0 && (
                            <div className="flex items-start gap-1">
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-slate-900">{p.name}</span>
                                <span className="block text-[11px] text-slate-500">
                                  {[p.site, p.rows.map((x) => `${x.headcount} ${shiftById.get(x.shift_id)?.code || ''}`).join(' · ')].filter(Boolean).join(' — ')}
                                </span>
                              </span>
                              {post && (
                                <>
                                  <button type="button" onClick={() => setEditing(post)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-500" aria-label={`Edit ${p.name}`}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button" onClick={() => void removePost(post)} className="p-1 rounded-lg hover:bg-rose-50 text-rose-600" aria-label={`Remove ${p.name}`}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="border-t border-slate-100 px-2 py-2 align-top">
                          {s && (
                            <span className="inline-flex min-w-[2.5rem] h-6 px-1.5 rounded-md text-white text-[11px] font-bold items-center justify-center" style={{ background: s.color }} title={`${s.name} ${s.start_time}–${s.end_time}`}>
                              {s.code}
                            </span>
                          )}
                        </td>
                        {r.days.map((d) => (
                          <td key={d.date} className="border-t border-slate-100 px-1.5 py-1.5 align-top">
                            <div className={`rounded-lg px-2 py-1.5 space-y-0.5 ${d.empty ? 'bg-rose-50' : 'bg-emerald-50'}`}>
                              {d.people.map((x) => (
                                <div key={`${x.employee_id}-${x.relief}`} className={`flex items-center gap-1 ${x.relief ? 'text-amber-800 font-semibold' : 'text-emerald-800'}`}>
                                  <span className="truncate">{x.name}{x.relief ? ' (relief)' : ''}</span>
                                  {x.relief && (
                                    <button type="button" onClick={() => void removeRelief(x, d.date)} className="shrink-0 text-amber-700 hover:text-rose-700" aria-label={`Remove ${x.name} as relief`}>
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              ))}
                              {d.empty > 0 && s && (
                                <button
                                  type="button"
                                  onClick={() => setRelief({ post: { id: p.id, name: p.name }, shift: s, date: d.date, empty: d.empty })}
                                  className="text-rose-700 font-bold hover:underline text-left"
                                >
                                  {d.empty} empty — put relief
                                </button>
                              )}
                            </div>
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Guards check in like everyone else — app Check In / Out, office device, or the site supervisor's Site Attendance. A relief duty is overtime waiting for approval (OT Approval).
      </p>

      {editing && (
        <PostForm
          token={token}
          post={editing === 'new' ? null : editing}
          shifts={shifts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice('Post saved.');
            void loadAll();
          }}
        />
      )}
      {patternOpen && (
        <PatternForm
          token={token}
          posts={posts.filter((p) => p.is_active)}
          shifts={shifts}
          people={people}
          onClose={() => setPatternOpen(false)}
          onSaved={(n) => {
            setPatternOpen(false);
            setNotice(`Roster filled — ${n} days.`);
            void loadCoverage();
          }}
        />
      )}
      {relief && (
        <ReliefForm
          token={token}
          {...relief}
          onClose={() => setRelief(null)}
          onSaved={(name) => {
            setRelief(null);
            setNotice(`${name} put as relief.`);
            void loadCoverage();
          }}
        />
      )}
    </div>
  );
};
