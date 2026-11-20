/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Service Book (HR's view only — never My Service Book):
//   - ActivityTimeline: the official service history plus what else happened
//     (onboarding, PEPM projects, login, Check-in places, final settlement),
//     with a filter by kind. The Service Book PDF stays the official history.
//   - MoreActivityTab: a summary from other modules, one box per module the
//     viewer holds (EmployeeActivityRoutes.ts decides which).
//   - AccessLogTab: who changed what on the login, and when (explicit-only
//     layer hr_operations -> p360_access).

import React, { useEffect, useMemo, useState } from 'react';
import { UserPlus, FolderKanban, KeyRound, MapPin, LogOut, ExternalLink } from 'lucide-react';
import { fmtDate, Badge, useHrApi } from './HrOpsShared';
import { ServiceTimeline, type ServiceEvent } from './HrOpsServiceBook';

type Api = ReturnType<typeof useHrApi>;

export interface ActivityEvent {
  date: string | null;
  at: string | null;
  kind: 'onboarding' | 'pepm' | 'login' | 'checkin' | 'exit';
  title: string;
  detail: string | null;
  by: string | null;
}

const KIND: Record<ActivityEvent['kind'], { label: string; icon: React.ComponentType<{ className?: string }>; tint: string }> = {
  onboarding: { label: 'Onboarding', icon: UserPlus, tint: 'bg-violet-100 text-violet-700' },
  pepm: { label: 'PEPM', icon: FolderKanban, tint: 'bg-violet-100 text-violet-700' },
  checkin: { label: 'Check-in', icon: MapPin, tint: 'bg-violet-100 text-violet-700' },
  login: { label: 'Login', icon: KeyRound, tint: 'bg-violet-100 text-violet-700' },
  exit: { label: 'Settlement', icon: LogOut, tint: 'bg-violet-100 text-violet-700' }
};
const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'service', label: 'Service' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'pepm', label: 'PEPM & Check-in' },
  { key: 'login', label: 'Login' }
];

// employeeId null (My Service Book, or nothing loaded yet): nothing is fetched.
export function useActivity(api: Api, employeeId: number | null, reloadKey: number) {
  const [data, setData] = useState<{ events: ActivityEvent[]; can_access_log: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    if (!employeeId) return;
    api
      .get<{ events: ActivityEvent[]; can_access_log: boolean }>(`/api/hr-ops/p360/${employeeId}/activity`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ events: [], can_access_log: false }));
    return () => {
      alive = false;
    };
  }, [api, employeeId, reloadKey]);
  return data;
}

const timeOf = (at: string | null) => {
  if (!at) return '';
  const d = new Date(new Date(at).getTime() + 6 * 3600e3);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// The service history as before, with the other activity merged in (violet).
export const ActivityTimeline: React.FC<{ service: ServiceEvent[]; extra: ActivityEvent[] | null }> = ({ service, extra }) => {
  const [filter, setFilter] = useState('all');
  const merged = useMemo(() => {
    const a = service.map((ev, i) => ({ type: 'service' as const, date: ev.date || '', order: i, ev }));
    const b = (extra || []).map((ev, i) => ({ type: 'extra' as const, date: ev.date || '', order: i, ev }));
    // Service events come oldest first, extra newest first: show newest first.
    return [...a, ...b].sort((x, y) => (x.date === y.date ? (x.type === y.type ? (x.type === 'service' ? y.order - x.order : x.order - y.order) : x.type === 'extra' ? -1 : 1) : y.date.localeCompare(x.date)));
  }, [service, extra]);
  const shown = merged.filter((m) =>
    filter === 'all' ? true : filter === 'service' ? m.type === 'service' : m.type === 'extra' && (filter === 'pepm' ? m.ev.kind === 'pepm' || m.ev.kind === 'checkin' : filter === 'login' ? m.ev.kind === 'login' || m.ev.kind === 'exit' : m.ev.kind === filter)
  );
  if (!extra) return <ServiceTimeline events={service} />;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${filter === f.key ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:text-slate-800'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-8">Nothing of this kind yet.</p>
      ) : (
        <ol className="relative border-l-2 border-slate-100 ml-3.5 space-y-4">
          {shown.map((m, i) =>
            m.type === 'service' ? (
              <ServiceTimeline.Item key={`s${i}`} ev={m.ev} />
            ) : (
              <li key={`x${i}`} className="ml-6">
                <span className={`absolute -left-[15px] w-7 h-7 rounded-full flex items-center justify-center ring-4 ring-white ${KIND[m.ev.kind].tint}`}>
                  {React.createElement(KIND[m.ev.kind].icon, { className: 'w-3.5 h-3.5' })}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-slate-800">{m.ev.title}</span>
                  <span className="text-[11px] text-slate-400">{fmtDate(m.ev.date)}</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">{KIND[m.ev.kind].label}</span>
                </div>
                {m.ev.detail && <p className="text-xs text-slate-600 mt-0.5">{m.ev.detail}</p>}
                {m.ev.by && <p className="text-[11px] text-slate-400 mt-0.5">By {m.ev.by}</p>}
              </li>
            )
          )}
        </ol>
      )}
    </div>
  );
};

// ---- More activity ----
interface Box {
  key: string;
  title: string;
  sub: string;
  rows: { label: string; value: string; status?: string | null; tone?: string | null; note?: string | null }[];
  link: string;
}

const statusTone = (s: string | null | undefined) => {
  const v = String(s || '').toLowerCase();
  if (/reject|cancel|declin|expired/.test(v)) return 'rejected';
  if (/pending|open|new|progress|submitted|assigned|requested|draft|started/.test(v)) return 'pending';
  if (/approv|done|complete|paid|given|closed|resolved|returned|finished|issued/.test(v)) return 'approved';
  return 'neutral';
};

export const MoreActivityTab: React.FC<{ api: Api; employeeId: number; reloadKey: number }> = ({ api, employeeId, reloadKey }) => {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setBoxes(null);
    setError('');
    api
      .get<{ boxes: Box[] }>(`/api/hr-ops/p360/${employeeId}/more`)
      .then((d) => alive && setBoxes(d.boxes))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, employeeId, reloadKey]);
  if (error) return <p className="text-xs text-rose-600 py-6 text-center">{error}</p>;
  if (!boxes) return <p className="text-xs text-slate-400 py-8 text-center">Loading…</p>;
  if (!boxes.length) return <p className="text-xs text-slate-400 py-8 text-center">You don't hold any of the modules this page summarises (SIM & Mobile Bill, Vehicle, Assets, Grievance, Tasks, Exit).</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">A short summary from other modules. You see a module here only if you have access to it.</p>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {boxes.map((b) => (
          <div key={b.key} className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-col min-w-0">
            <div className="text-sm font-bold text-slate-900">{b.title}</div>
            {b.sub && <div className="text-[11px] text-slate-500 mb-2">{b.sub}</div>}
            <div className="flex-1">
              {b.rows.length === 0 ? (
                <p className="text-xs text-slate-400 py-2">Nothing yet.</p>
              ) : (
                b.rows.map((r, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 py-1.5 border-t border-slate-100 first:border-t-0 text-xs">
                    <span className="min-w-0 break-words text-slate-700">
                      {r.label}
                      {r.note && <span className="block text-[10px] text-amber-700">{r.note}</span>}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0 text-slate-500 tabular-nums">
                      {r.value}
                      {r.status && <Badge tone={statusTone(r.status)}>{r.status}</Badge>}
                      {!r.status && r.tone === 'warn' && <Badge tone="pending">over limit</Badge>}
                    </span>
                  </div>
                ))
              )}
            </div>
            <a href={b.link} className="mt-2 text-[11px] font-semibold text-blue-600 hover:underline inline-flex items-center gap-1">
              Open {b.title} <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        ))}
      </div>
    </div>
  );
};

// ---- Login & Access ----
interface AccessRow {
  id: number;
  at: string | null;
  by: string | null;
  source: string;
  action: string;
  changes: { what: string; text: string; added: string[]; removed: string[]; from: string | null; to: string | null }[];
}

export const AccessLogTab: React.FC<{ api: Api; employeeId: number; reloadKey: number }> = ({ api, employeeId, reloadKey }) => {
  const [data, setData] = useState<{ has_login: boolean; login_created_at: string | null; login_id: string | null; recording_since: string | null; rows: AccessRow[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    api
      .get<any>(`/api/hr-ops/p360/${employeeId}/access-log`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, employeeId, reloadKey]);
  if (error) return <p className="text-xs text-rose-600 py-6 text-center">{error}</p>;
  if (!data) return <p className="text-xs text-slate-400 py-8 text-center">Loading…</p>;
  if (!data.has_login && !data.rows.length) return <p className="text-xs text-slate-400 py-8 text-center">This employee has no login.</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">
        Every change to this login: who made it and when.
        {data.recording_since ? ` Full before → after since ${fmtDate(data.recording_since.slice(0, 10))}.` : ''}
        {data.rows.some((r) => r.source === 'older') && ' Older rows (marked "older record") come from Users → Activity: what was set, not what it was before.'}
        {data.login_id && <> · Login ID <b className="text-slate-700">{data.login_id}</b></>}
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 text-left">
              <th className="px-3 py-2 font-semibold">When</th>
              <th className="px-3 py-2 font-semibold">By</th>
              <th className="px-3 py-2 font-semibold">What</th>
              <th className="px-3 py-2 font-semibold">Change</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap text-slate-500 tabular-nums">
                  {fmtDate(r.at ? new Date(new Date(r.at).getTime() + 6 * 3600e3).toISOString().slice(0, 10) : null)} {timeOf(r.at)}
                </td>
                <td className="px-3 py-2 text-slate-700">{r.by || '—'}</td>
                <td className="px-3 py-2 font-semibold text-slate-800">
                  {r.action}
                  {r.source === 'older' && <span className="block text-[10px] font-semibold text-slate-400">older record</span>}
                </td>
                <td className="px-3 py-2">
                  {r.changes.map((c, i) => (
                    <div key={i} className="py-0.5">
                      <span className="text-slate-500">{c.what}: </span>
                      {c.added.length || c.removed.length ? (
                        <>
                          {c.added.map((x) => (
                            <span key={`a${x}`} className="inline-block mr-1.5 text-emerald-700">+ {x}</span>
                          ))}
                          {c.removed.map((x) => (
                            <span key={`r${x}`} className="inline-block mr-1.5 text-rose-700 line-through decoration-rose-300">− {x}</span>
                          ))}
                        </>
                      ) : c.from != null && c.to != null ? (
                        <>
                          <span className="text-rose-700">{c.from}</span> → <span className="text-emerald-700">{c.to}</span>
                        </>
                      ) : (
                        <span className="text-slate-800">{c.text}</span>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
            {data.login_created_at && !data.rows.some((r) => r.action === 'Login created') && (
              <tr className="border-t border-slate-100 align-top text-slate-400">
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(data.login_created_at.slice(0, 10))}</td>
                <td className="px-3 py-2">—</td>
                <td className="px-3 py-2 font-semibold">Login created</td>
                <td className="px-3 py-2">From the login's own date (before recording began)</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
