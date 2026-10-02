/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users (Superadmin only): who is using the app or the
// website right now, from which IP address and on which device
// (ActiveUsersRoutes.ts). One row per sign-in, so an account open on a phone
// and a laptop shows twice. Refreshes itself every 30 seconds.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Globe, Monitor, RefreshCw, Search, Smartphone, Users } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Notice } from './HrOpsShared';

interface Session {
  id: number;
  user_id: number;
  name: string;
  login: string | null;
  role: string | null;
  client: 'app' | 'web';
  device_name: string | null;
  browser: string;
  os: string;
  ip: string | null;
  signed_in_at: string | null;
  last_seen_at: string;
  online: boolean;
}
interface Data {
  range: Range;
  online_minutes: number;
  proxy_hides_ip?: boolean;
  summary: { online_users: number; online_app: number; online_web: number; today_users: number; week_users: number; total_accounts: number };
  sessions: Session[];
}
type Range = 'online' | 'today' | '7d';
type Msg = { type: 'success' | 'error'; text: string } | null;

const RANGES: [Range, string][] = [
  ['online', 'Online now'],
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
];

const ago = (v: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? '' : 's'} ago`;
};
const when = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
};
const deviceLabel = (s: Session) => (s.client === 'app' ? s.device_name || `${s.os} phone` : `${s.browser} on ${s.os}`);

const StatusDot: React.FC<{ s: Session }> = ({ s }) => (
  <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${s.online ? 'text-emerald-700' : 'text-slate-500'}`}>
    <span className={`w-2 h-2 rounded-full ${s.online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
    {s.online ? 'Online' : ago(s.last_seen_at)}
  </span>
);

const ClientBadge: React.FC<{ s: Session }> = ({ s }) => (
  <span
    className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
      s.client === 'app' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'
    }`}
  >
    {s.client === 'app' ? <Smartphone className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
    {s.client === 'app' ? 'App' : 'Web'}
  </span>
);

export const ActiveUsers: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [range, setRange] = useState<Range>('online');
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get(`/api/active-users?range=${range}`)
      .then((d) => setData(d))
      .catch((e) => setMsg({ type: 'error', text: e.message }))
      .finally(() => setLoading(false));
  }, [api, range]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data?.sessions || [];
    if (!needle) return list;
    return list.filter((s) => [s.name, s.login, s.ip, deviceLabel(s)].some((v) => String(v || '').toLowerCase().includes(needle)));
  }, [data, q]);

  if (!data) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const sum = data.summary;
  const cards: [string, number, React.ReactNode, string][] = [
    ['Online now', sum.online_users, <Activity className="w-4 h-4" />, 'text-emerald-600 bg-emerald-50'],
    ['On app', sum.online_app, <Smartphone className="w-4 h-4" />, 'text-violet-600 bg-violet-50'],
    ['On website', sum.online_web, <Globe className="w-4 h-4" />, 'text-sky-600 bg-sky-50'],
    ['Used today', sum.today_users, <Users className="w-4 h-4" />, 'text-blue-600 bg-blue-50'],
    ['Last 7 days', sum.week_users, <Users className="w-4 h-4" />, 'text-slate-600 bg-slate-100'],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-600" /> Active Users
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Who is signed in and using the app or website, with the IP address and device of each sign-in. "Online" means used in the last{' '}
            {data.online_minutes} minutes. Refreshes every 30 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      {data.proxy_hides_ip && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
          The IP shows as <span className="font-mono">127.0.0.1</span> because the web server in front of this app isn't passing on the visitor's
          address. Ask whoever manages the hosting to forward it — on Nginx:{' '}
          <span className="font-mono">proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;</span> and{' '}
          <span className="font-mono">proxy_set_header X-Real-IP $remote_addr;</span> — then sign in again.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {cards.map(([label, n, icon, tone]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 flex items-center gap-3">
            <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>{icon}</span>
            <div className="min-w-0">
              <div className="text-xl font-bold text-slate-900 leading-none">{n}</div>
              <div className="text-[11px] text-slate-500 mt-1 truncate">{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex p-0.5 rounded-lg bg-slate-100">
          {RANGES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                range === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, IP or device"
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
        <span className="text-[11px] text-slate-500">
          {shown.length} sign-in{shown.length === 1 ? '' : 's'} · {new Set(shown.map((s) => s.user_id)).size} account
          {new Set(shown.map((s) => s.user_id)).size === 1 ? '' : 's'}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
          {range === 'online' ? 'Nobody is using the app right now.' : 'No sign-ins in this period.'}
        </div>
      ) : (
        <>
          {/* Phone: one card per sign-in. */}
          <div className="md:hidden space-y-2">
            {shown.map((s) => (
              <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-3 text-xs space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{s.name}</div>
                    <div className="text-slate-500 truncate">{s.login}</div>
                  </div>
                  <StatusDot s={s} />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ClientBadge s={s} />
                  <span className="text-slate-700">{deviceLabel(s)}</span>
                </div>
                <div className="flex justify-between gap-2 text-slate-500">
                  <span>
                    IP <span className="font-mono text-slate-800">{s.ip || '—'}</span>
                  </span>
                  <span>Signed in {when(s.signed_in_at)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Wider screens: table. */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">IP address</th>
                  <th className="px-3 py-2 font-semibold">Device</th>
                  <th className="px-3 py-2 font-semibold whitespace-nowrap">Signed in</th>
                  <th className="px-3 py-2 font-semibold whitespace-nowrap">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100 align-top hover:bg-slate-50/60">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-800">{s.name}</div>
                      <div className="text-slate-500">
                        {s.login}
                        {s.role && s.role !== 'user' && <span className="ml-1.5 text-[10px] uppercase text-slate-400">{s.role}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <StatusDot s={s} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-800 whitespace-nowrap">{s.ip || '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <ClientBadge s={s} />
                        <span className="text-slate-700">{deviceLabel(s)}</span>
                      </div>
                      {s.client === 'app' && s.device_name && <div className="text-[10px] text-slate-400 mt-0.5">{s.os}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{when(s.signed_in_at)}</td>
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">
                      {when(s.last_seen_at)}
                      <div className="text-[10px] text-slate-400">{ago(s.last_seen_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
