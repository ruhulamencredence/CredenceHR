/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users (Superadmin only): who is using the app or the
// website right now, from which IP address and on which device
// (ActiveUsersRoutes.ts). One row per sign-in, so an account open on a phone
// and a laptop shows twice. Refreshes itself every 30 seconds. Also where
// the Superadmin sets how long a sign-in lasts and ends one (SessionSecurity.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Globe, LogOut, Monitor, RefreshCw, Search, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Notice, inputCls } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

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
  current?: boolean;
}
interface Data {
  range: Range;
  online_minutes: number;
  proxy_hides_ip?: boolean;
  summary: { online_users: number; online_app: number; online_web: number; today_users: number; week_users: number; total_accounts: number };
  sessions: Session[];
}
type Range = 'online' | 'today' | '7d';
interface Policy {
  web_hours: number;
  web_idle_minutes: number;
  app_days: number;
  app_idle_days: number;
}
type PolicyKey = keyof Policy;
const POLICY_FIELDS: [PolicyKey, string, string][] = [
  ['web_hours', 'Website sign-in lasts', 'hours'],
  ['web_idle_minutes', 'Website signs out when unused for', 'minutes (0 = never)'],
  ['app_days', 'App sign-in lasts', 'days'],
  ['app_idle_days', 'App signs out when not opened for', 'days (0 = never)'],
];

// How long a sign-in lasts. Changes apply to sign-ins already open too.
const SessionSecurityCard: React.FC<{ api: ReturnType<typeof useHrApi>; onMsg: (m: Msg) => void }> = ({ api, onMsg }) => {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [form, setForm] = useState<Record<PolicyKey, string> | null>(null);
  const [limits, setLimits] = useState<Record<PolicyKey, [number, number]> | null>(null);
  const [saving, setSaving] = useState(false);
  const toForm = (p: Policy) => Object.fromEntries(POLICY_FIELDS.map(([k]) => [k, String(p[k])])) as Record<PolicyKey, string>;
  useEffect(() => {
    api
      .get('/api/session-policy')
      .then((d) => {
        if (!d.policy) return;
        setPolicy(d.policy);
        setForm(toForm(d.policy));
        setLimits(d.limits || null);
      })
      .catch((e) => onMsg({ type: 'error', text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!policy || !form) return null;
  const changed = POLICY_FIELDS.some(([k]) => form[k] !== String(policy[k]));
  const save = async () => {
    setSaving(true);
    try {
      const body = Object.fromEntries(POLICY_FIELDS.map(([k]) => [k, Number(form[k])]));
      const d = await api.put('/api/session-policy', body);
      setPolicy(d.policy);
      setForm(toForm(d.policy));
      onMsg({ type: 'success', text: 'Session security saved. It applies to sign-ins already open too.' });
    } catch (e: any) {
      onMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
      <div>
        <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-emerald-600" /> Session security
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">
          After this, the person has to sign in again. Logout, a changed password and Sign out below end a sign-in at once.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {POLICY_FIELDS.map(([k, label, unit]) => (
          <label key={k} className="block">
            <span className="text-[11px] font-semibold text-slate-600">{label}</span>
            <div className="flex items-center gap-1.5 mt-1">
              <input
                type="number"
                min={limits?.[k]?.[0]}
                max={limits?.[k]?.[1]}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className={`${inputCls} w-24`}
              />
              <span className="text-[11px] text-slate-500">{unit}</span>
            </div>
          </label>
        ))}
      </div>
      {changed && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="text-xs font-semibold px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setForm(toForm(policy))}
            className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
};
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

  const signOut = async (s: Session) => {
    if (!(await confirmDialog(`End this sign-in of ${s.name} (${deviceLabel(s)})? They will have to sign in again on it.`, { confirmLabel: 'Sign out', tone: 'danger' })))
      return;
    try {
      await api.post(`/api/active-users/${s.id}/sign-out`);
      setMsg({ type: 'success', text: `${s.name} was signed out on ${deviceLabel(s)}.` });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const SignOutButton: React.FC<{ s: Session }> = ({ s }) => (
    <button
      type="button"
      onClick={() => void signOut(s)}
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md border border-red-200 text-red-600 bg-white hover:bg-red-50"
    >
      <LogOut className="w-3 h-3" /> Sign out
    </button>
  );

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

      <SessionSecurityCard api={api} onMsg={setMsg} />

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
                {!s.current && (
                  <div className="flex justify-end">
                    <SignOutButton s={s} />
                  </div>
                )}
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
                  <th className="px-3 py-2" />
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
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {s.current ? <span className="text-[10px] text-slate-400">This sign-in</span> : <SignOutButton s={s} />}
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
