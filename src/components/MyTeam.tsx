/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Team: a Head of Department's / team Supervisor's /
// Direct Supervisor's own people (MyTeamRoutes.ts), read-only.
//   MyTeamCard  — the Dashboard card: today's Present / Late / On leave /
//                 Not in yet. Renders nothing for an account with nobody
//                 under it (no module, no switch — the server decides who is
//                 under whom on every request).
//   MyTeamPage  — "See all": everyone, grouped by how they're under me,
//                 searchable by name / ID / designation / department and
//                 filtered by today's status.
//   PersonCard  — one person: today, this month so far, Call / Mail.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Mail, Phone, Search, Users, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { UserAvatar } from './UserAvatar';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { formatPhone, telHref } from '../lib/phoneNumbers';
import { Spinner } from './Spinner';

type Status = 'present' | 'late' | 'leave' | 'off' | 'not_in';
type Via = { kind: 'head' | 'team' | 'direct'; label: string };
interface Today {
  status: Status;
  in: string | null;
  out: string | null;
  place: string | null;
  late: 'late' | 'extreme' | null;
  leave_type: string | null;
  holiday: string | null;
}
interface Member {
  id: number;
  user_id: number | null;
  employee_id: string | null;
  name: string;
  designation: string | null;
  department: string | null;
  branch: string | null;
  via: Via[];
  today: Today;
}
interface TeamData {
  has_team: boolean;
  date: string;
  summary: Record<'total' | Status, number>;
  people: Member[];
}

const STATUS: Record<Status, { label: string; badge: string; tile: string }> = {
  present: { label: 'Present', badge: 'bg-emerald-50 text-emerald-700', tile: 'bg-emerald-50 text-emerald-700' },
  late: { label: 'Late', badge: 'bg-amber-50 text-amber-700', tile: 'bg-amber-50 text-amber-700' },
  leave: { label: 'On leave', badge: 'bg-pink-50 text-pink-700', tile: 'bg-pink-50 text-pink-700' },
  not_in: { label: 'Not in yet', badge: 'bg-slate-100 text-slate-600', tile: 'bg-slate-100 text-slate-600' },
  off: { label: 'Off today', badge: 'bg-sky-50 text-sky-700', tile: 'bg-sky-50 text-sky-700' }
};

const viaText = (v: Via) => (v.kind === 'head' ? `Head of ${v.label}` : v.kind === 'team' ? `${v.label} — you supervise` : v.label);
const badgeText = (t: Today) => (t.status === 'late' && t.late === 'extreme' ? 'Very late' : STATUS[t.status].label);

const todayLine = (t: Today): string => {
  if (t.status === 'leave') return t.leave_type || 'On leave';
  if (t.status === 'off' && !t.in) return t.holiday || 'Off day';
  if (!t.in) return 'No In yet';
  return [`In ${t.in}`, t.out ? `Out ${t.out}` : null, t.place].filter(Boolean).join(' · ');
};

const fmtDay = (d: string) => {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

function useMyTeam(token: string) {
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/my-team'), { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "Couldn't load your team.");
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Couldn't load your team.");
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

// ---------------------------------------------------------------------------
// Dashboard card
// ---------------------------------------------------------------------------

export const MyTeamCard: React.FC<{ token: string; className?: string }> = ({ token, className = '' }) => {
  const { data, reload } = useMyTeam(token);
  const [open, setOpen] = useState<Status | 'all' | null>(null);
  if (!data?.has_team) return null;
  const s = data.summary;
  const late = data.people.filter((p) => p.today.status === 'late');
  const tiles: Status[] = ['present', 'late', 'leave', 'not_in'];
  return (
    <div className={className} data-testid="my-team-card">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5 h-full">
        <button type="button" onClick={() => setOpen('all')} className="w-full flex items-start justify-between gap-3 text-left">
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-base font-bold text-slate-900">
              <Users className="w-4 h-4 text-[var(--g-accent,#f47920)]" /> My Team
              <span className="text-xs font-medium text-slate-500">· {s.total} {s.total === 1 ? 'person' : 'people'}</span>
            </span>
            <span className="block text-xs text-slate-500 mt-0.5">
              Today, {fmtDay(data.date)}
              {s.off > 0 && ` · ${s.off} off today`}
            </span>
          </span>
          <span className="text-xs font-bold text-[var(--g-accent,#f47920)] flex items-center shrink-0">
            See all <ChevronRight className="w-3.5 h-3.5" />
          </span>
        </button>
        <div className="grid grid-cols-4 gap-2 mt-3">
          {tiles.map((k) => (
            <button key={k} type="button" onClick={() => setOpen(k)} className={`rounded-xl py-2 px-1 text-center active:scale-95 transition-transform ${STATUS[k].tile}`}>
              <span className="block text-lg font-extrabold leading-tight">{s[k]}</span>
              <span className="block text-[10.5px] font-semibold leading-tight">{STATUS[k].label}</span>
            </button>
          ))}
        </div>
        {data.people.length > 0 && (
          <div className="flex items-center mt-3 min-w-0">
            <span className="flex shrink-0">
              {data.people.slice(0, 5).map((p, i) => (
                <span key={p.id} className={`rounded-full ring-2 ring-white ${i ? '-ml-2' : ''}`}>
                  <UserAvatar userId={p.user_id ?? undefined} name={p.name} token={token} className="w-8 h-8 text-[10px]" />
                </span>
              ))}
              {data.people.length > 5 && (
                <span className="-ml-2 w-8 h-8 rounded-full ring-2 ring-white bg-slate-100 text-slate-600 text-[10px] font-bold flex items-center justify-center">+{data.people.length - 5}</span>
              )}
            </span>
            {late.length > 0 && (
              <span className="ml-3 text-xs text-slate-500 truncate">
                Late: {late.slice(0, 3).map((p) => p.name.split(' ')[0]).join(', ')}
                {late.length > 3 && ` +${late.length - 3}`}
              </span>
            )}
          </div>
        )}
      </div>
      {open && (
        <MyTeamPage
          token={token}
          data={data}
          initialFilter={open}
          onReload={reload}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// See all
// ---------------------------------------------------------------------------

const MyTeamPage: React.FC<{
  token: string;
  data: TeamData;
  initialFilter: Status | 'all';
  onReload: () => void;
  onClose: () => void;
}> = ({ token, data, initialFilter, onReload, onClose }) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Status | 'all'>(initialFilter);
  const [picked, setPicked] = useState<Member | null>(null);
  useBackButtonClose(!picked, onClose);
  useEffect(() => {
    onReload(); // fresh times each time it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.people.filter(
      (p) =>
        (filter === 'all' || p.today.status === filter) &&
        (!t || [p.name, p.employee_id, p.designation, p.department, p.branch].some((v) => String(v || '').toLowerCase().includes(t)))
    );
  }, [data.people, q, filter]);

  // Grouped by the first way each person is under me: Head, then teams, then direct.
  const groups = useMemo(() => {
    const order = { head: 0, team: 1, direct: 2 } as const;
    const map = new Map<string, { via: Via; rows: Member[] }>();
    for (const p of shown) {
      const v = [...p.via].sort((a, b) => order[a.kind] - order[b.kind])[0];
      const key = `${v.kind}|${v.label}`;
      if (!map.has(key)) map.set(key, { via: v, rows: [] });
      map.get(key)!.rows.push(p);
    }
    return [...map.values()].sort((a, b) => order[a.via.kind] - order[b.via.kind] || a.via.label.localeCompare(b.via.label));
  }, [shown]);

  const chips: (Status | 'all')[] = ['all', 'present', 'late', 'leave', 'not_in', ...(data.summary.off > 0 ? (['off'] as Status[]) : [])];
  const count = (k: Status | 'all') => (k === 'all' ? data.summary.total : data.summary[k]);

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="My Team">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-x-[12%] lg:inset-y-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-bold text-slate-900">
                  My Team <span className="text-sm font-medium text-slate-500">{data.summary.total}</span>
                </h3>
                <p className="text-xs text-slate-500">Today, {fmtDay(data.date)}</p>
              </div>
              <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600 active:scale-95 transition-transform" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <label className="mt-3 flex items-center gap-2 liquid-glass-inset rounded-full px-3 py-2">
              <Search className="w-4 h-4 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, designation, department…" className="bg-transparent text-sm outline-none flex-1 min-w-0" />
            </label>
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
              {chips.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${filter === k ? 'bg-[var(--g-accent,#f47920)] text-white' : 'bg-white/70 text-slate-600'}`}
                >
                  {k === 'all' ? 'All' : STATUS[k].label} {count(k)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 sm:px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {groups.length === 0 && <p className="text-sm text-slate-500 text-center py-10">{q ? `Nobody matches "${q}".` : 'Nobody in this list today.'}</p>}
            {groups.map((g) => (
              <section key={`${g.via.kind}|${g.via.label}`} className="mb-3">
                <h4 className="px-2 pt-2 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
                  {viaText(g.via)} ({g.rows.length})
                </h4>
                <div className="space-y-1.5">
                  {g.rows.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPicked(p)}
                      className="w-full flex items-center gap-3 bg-white/85 rounded-2xl px-3 py-2.5 text-left shadow-sm active:scale-[0.99] transition-transform"
                    >
                      <UserAvatar userId={p.user_id ?? undefined} name={p.name} token={token} className="w-10 h-10 text-xs" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-slate-900 truncate">{p.name}</span>
                        <span className="block text-[11px] text-slate-500 truncate">{[p.employee_id, p.designation, p.department].filter(Boolean).join(' · ')}</span>
                        <span className="block text-[11px] font-medium text-slate-600 truncate mt-0.5">{todayLine(p.today)}</span>
                      </span>
                      <span className={`shrink-0 px-2 py-1 rounded-full text-[10.5px] font-bold ${STATUS[p.today.status].badge}`}>{badgeText(p.today)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
      {picked && <PersonCard token={token} member={picked} onClose={() => setPicked(null)} />}
    </div>,
    document.body
  );
};

// ---------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------

interface Detail extends Member {
  email: string | null;
  phone: string | null;
  joining_date: string | null;
  month: { from: string; to: string; present: number; late: number; leave: number; absent: number | null };
}

const PersonCard: React.FC<{ token: string; member: Member; onClose: () => void }> = ({ token, member, onClose }) => {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useBackButtonClose(true, onClose);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl(`/api/my-team/${member.id}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || "Couldn't load this person.");
        if (alive) setD(j);
      })
      .catch((e) => alive && setError(e?.message || "Couldn't load this person."));
    return () => {
      alive = false;
    };
  }, [member.id, token]);

  const t = d?.today || member.today;
  const monthName = d ? new Date(`${d.month.from}T00:00:00`).toLocaleDateString('en-GB', { month: 'long' }) : '';
  return (
    <div className="fixed inset-0 z-[95]" role="dialog" aria-modal="true" aria-label={member.name}>
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-2.5 bottom-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:w-[420px] pb-[env(safe-area-inset-bottom)]">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[85dvh] overflow-y-auto">
          <button type="button" onClick={onClose} className="liquid-glass-chip absolute right-4 top-4 w-9 h-9 rounded-full flex items-center justify-center text-slate-600" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-3 pr-10">
            <UserAvatar userId={member.user_id ?? undefined} name={member.name} token={token} className="w-16 h-16 text-lg" />
            <div className="min-w-0">
              <p className="text-lg font-bold text-slate-900 leading-tight">{member.name}</p>
              <p className="text-xs text-slate-500">{[member.employee_id, member.designation].filter(Boolean).join(' · ')}</p>
              <p className="text-xs text-slate-500">{[member.department, member.branch].filter(Boolean).join(' · ')}</p>
            </div>
          </div>

          <div className="liquid-glass-inset rounded-2xl p-3 mt-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Today</span>
              <span className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${STATUS[t.status].badge}`}>{badgeText(t)}</span>
            </div>
            {t.status === 'leave' ? (
              <p className="mt-2 text-sm font-semibold text-slate-800">{t.leave_type || 'On leave'}</p>
            ) : (
              <>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-slate-500">In</span>
                  <span className="font-semibold text-slate-900 text-right">{t.in ? [t.in, t.place].filter(Boolean).join(' · ') : t.status === 'off' ? t.holiday || 'Off day' : '—'}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-slate-500">Out</span>
                  <span className="font-semibold text-slate-900">{t.out || '—'}</span>
                </div>
              </>
            )}
          </div>

          <div className="liquid-glass-inset rounded-2xl p-3 mt-3">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">{d ? `${monthName} so far` : 'This month'}</span>
            {d ? (
              <div className="grid grid-cols-4 gap-1.5 mt-2" data-testid="my-team-month">
                {(
                  [
                    ['Present', d.month.present],
                    ['Late', d.month.late],
                    ['Leave', d.month.leave],
                    ['Absent', d.month.absent]
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="bg-white/80 rounded-xl py-1.5 text-center">
                    <span className="block text-base font-extrabold text-slate-900">{v ?? '—'}</span>
                    <span className="block text-[10px] font-semibold text-slate-500">{k}</span>
                  </div>
                ))}
              </div>
            ) : error ? (
              <p className="mt-2 text-xs text-rose-600">{error}</p>
            ) : (
              <div className="py-3 flex justify-center">
                <Spinner />
              </div>
            )}
          </div>

          <div className="liquid-glass-inset rounded-2xl p-3 mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500 shrink-0">Under you as</span>
              <span className="font-semibold text-slate-900 text-right">{member.via.map(viaText).join(', ')}</span>
            </div>
            {d?.phone && (
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Phone</span>
                <span className="font-semibold text-slate-900">{formatPhone(d.phone)}</span>
              </div>
            )}
            {d?.email && (
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Email</span>
                <span className="font-semibold text-slate-900 truncate">{d.email}</span>
              </div>
            )}
          </div>

          {(d?.phone || d?.email) && (
            <div className="flex gap-2 mt-4">
              {d?.email && (
                <a href={`mailto:${d.email}`} className="flex-1 h-11 rounded-full bg-white/80 text-slate-700 font-bold text-sm flex items-center justify-center gap-2">
                  <Mail className="w-4 h-4" /> Mail
                </a>
              )}
              {d?.phone && (
                <a href={telHref(d.phone)} className="liquid-glass-button rounded-full flex-1 h-11 font-bold text-sm flex items-center justify-center gap-2">
                  <Phone className="w-4 h-4" /> Call
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
