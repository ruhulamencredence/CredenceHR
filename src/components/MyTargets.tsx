/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Targets (TargetRoutes.ts): my monthly / yearly targets
// and their tasks — update each task's progress and status until the
// deadline. A supervisor also gets "Team": give targets to their people (one
// or the whole team), approve the targets they share, follow everyone's
// progress. Shown only with users.can_view_targets (Module Access).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Plus, Target as TargetIcon } from 'lucide-react';
import { User } from '../types';
import { useLiveRefresh } from '../lib/liveRefresh';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { periodLabel, ProgressBar, takePendingTargetId, Target, TargetCard, TargetDrawer, TargetForm, targetApi, TeamMember } from './TargetParts';

interface Access {
  enabled: boolean;
  supervisor: boolean;
  team_size: number;
  reports: boolean;
  today: string;
}
type Tab = 'mine' | 'team';
const FINISHED = new Set(['rejected', 'cancelled', 'closed']);

export const MyTargets: React.FC<{ token: string; user: User; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [access, setAccess] = useState<Access | null>(null);
  const [mine, setMine] = useState<Target[] | null>(null);
  const [team, setTeam] = useState<{ members: TeamMember[]; targets: Target[]; pending: Target[] } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('mine');
  const [type, setType] = useState<'' | 'monthly' | 'yearly'>('');
  const [period, setPeriod] = useState('');
  const [showFinished, setShowFinished] = useState(false);
  const [openId, setOpenId] = useState<number | null>(() => takePendingTargetId());
  const [form, setForm] = useState<{ team: boolean; preselect?: number[]; editing?: Target } | null>(null);

  const load = useCallback(() => {
    targetApi<Target[]>(token, '/api/targets/mine')
      .then(setMine)
      .catch((e) => setError(e.message));
    targetApi<Access>(token, '/api/targets/access')
      .then((a) => {
        setAccess(a);
        if (a.supervisor) targetApi(token, '/api/targets/team').then(setTeam).catch((e) => setError(e.message));
      })
      .catch((e) => setError(e.message));
  }, [token]);
  useLiveRefresh(() => load());
  useEffect(() => {
    load();
    const onOpen = () => {
      const id = takePendingTargetId();
      if (id) setOpenId(id);
      load();
    };
    window.addEventListener('credence:open-target', onOpen);
    return () => window.removeEventListener('credence:open-target', onOpen);
  }, [load]);

  const list = tab === 'mine' ? mine : team?.targets || null;
  const periods = useMemo(() => {
    const set = new Map<string, string>();
    for (const t of list || []) if (!type || t.period_type === type) set.set(`${t.period_type}:${t.period}`, periodLabel(t.period_type, t.period));
    return [...set.entries()].sort((a, b) => b[0].split(':')[1].localeCompare(a[0].split(':')[1]));
  }, [list, type]);
  const shown = (list || []).filter((t) => (!type || t.period_type === type) && (!period || `${t.period_type}:${t.period}` === period));
  const live = shown.filter((t) => !FINISHED.has(t.status));
  const finished = shown.filter((t) => FINISHED.has(t.status));

  // Team: one row per person with their targets in the chosen period.
  const teamRows = useMemo(() => {
    if (!team) return [];
    return team.members.map((m) => {
      const ts = shown.filter((t) => t.user_id === m.user_id && !FINISHED.has(t.status) && t.status !== 'draft');
      const avg = ts.length ? Math.round(ts.reduce((s, t) => s + t.progress, 0) / ts.length) : null;
      return { m, ts, avg, done: ts.reduce((s, t) => s + t.completed_count, 0), tasks: ts.reduce((s, t) => s + t.task_count, 0), overdue: ts.some((t) => t.overdue) };
    });
  }, [team, shown]);
  const teamAvg = (() => {
    const vals = teamRows.filter((r) => r.avg !== null).map((r) => r.avg as number);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  })();

  if (access && !access.enabled) {
    return <p className="p-6 text-sm text-slate-500">My Targets isn’t turned on for your account. Ask HR to turn it on in Module Access.</p>;
  }

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Targets']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2 flex-wrap">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <TargetIcon className="w-5 h-5 text-fuchsia-600 shrink-0" /> My Targets
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setForm({ team: tab === 'team' })}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-fuchsia-600 text-white hover:bg-fuchsia-700"
          >
            <Plus className="w-3.5 h-3.5" /> {tab === 'team' ? 'Give a target' : 'New target'}
          </button>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3 items-center">
          {(
            [
              { key: 'mine', label: 'My Targets', count: mine?.filter((t) => t.status === 'active').length },
              ...(access?.supervisor ? [{ key: 'team', label: 'Team', count: team?.pending.length }] : [])
            ] as { key: Tab; label: string; count?: number }[]
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setPeriod('');
              }}
              className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold ${tab === t.key ? 'bg-fuchsia-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
            >
              {t.label}
              {!!t.count && <span className={`ml-1.5 px-1.5 rounded-full ${tab === t.key ? 'bg-white/25' : 'bg-fuchsia-100 text-fuchsia-700'}`}>{t.count}</span>}
            </button>
          ))}
          <span className="flex-1" />
          <select value={type} onChange={(e) => { setType(e.target.value as any); setPeriod(''); }} className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs" aria-label="Type">
            <option value="">Monthly & yearly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs" aria-label="Period">
            <option value="">All periods</option>
            {periods.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm text-rose-600 mb-2">{error}</p>}
        {!list ? (
          <div className="py-10 flex justify-center">
            <Spinner size={24} />
          </div>
        ) : (
          <>
            {tab === 'team' && team && (
              <>
                {team.pending.length > 0 && (
                  <div className="mb-4">
                    <h2 className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-2">Waiting for your approval ({team.pending.length})</h2>
                    <div className="space-y-2">
                      {team.pending.map((t) => (
                        <TargetCard key={t.id} t={t} showOwner onOpen={() => setOpenId(t.id)} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto mb-4">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Employee</th>
                        <th className="px-3 py-2 text-center">Targets</th>
                        <th className="px-3 py-2 text-center">Tasks done</th>
                        <th className="px-3 py-2 text-left w-[40%]">Progress</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {teamRows.map(({ m, ts, avg, done, tasks, overdue }) => (
                        <tr key={m.user_id} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-800">{m.name}</div>
                            <div className="text-[11px] text-slate-500">{[m.employee_code, m.department].filter(Boolean).join(' · ')}</div>
                          </td>
                          <td className="px-3 py-2 text-center">{ts.length || '—'}</td>
                          <td className="px-3 py-2 text-center">{tasks ? `${done}/${tasks}` : '—'}</td>
                          <td className="px-3 py-2">
                            {avg === null ? (
                              <span className="text-slate-400">No target</span>
                            ) : (
                              <div className="flex items-center gap-2">
                                <ProgressBar value={avg} thin />
                                <span className="font-bold w-9 text-right">{avg}%</span>
                                {overdue && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-600 text-white">Overdue</span>}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => setForm({ team: true, preselect: [m.user_id] })} className="text-[11px] font-semibold text-fuchsia-700 hover:underline whitespace-nowrap">
                              + Give
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {teamAvg !== null && (
                      <tfoot>
                        <tr className="border-t border-slate-200 bg-slate-50">
                          <td className="px-3 py-2 font-semibold" colSpan={3}>
                            Team average
                          </td>
                          <td className="px-3 py-2 font-bold" colSpan={2}>
                            {teamAvg}%
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </>
            )}
            <div className="space-y-2">
              {live.filter((t) => tab === 'mine' || t.status !== 'pending').length === 0 && (
                <p className="text-sm text-slate-500 py-8 text-center">
                  {tab === 'mine' ? 'No targets yet. Your supervisor’s targets appear here, or tap “New target” to share your own.' : 'No targets for your team in this period.'}
                </p>
              )}
              {live
                .filter((t) => tab === 'mine' || t.status !== 'pending')
                .map((t) => (
                  <TargetCard key={t.id} t={t} showOwner={tab === 'team'} onOpen={() => setOpenId(t.id)} />
                ))}
            </div>
            {finished.length > 0 && (
              <div className="mt-5">
                <button type="button" onClick={() => setShowFinished((v) => !v)} className="text-xs font-semibold text-slate-500 hover:text-slate-700">
                  {showFinished ? 'Hide' : 'Show'} closed, cancelled & rejected ({finished.length})
                </button>
                {showFinished && (
                  <div className="space-y-2 mt-2 opacity-90">
                    {finished.map((t) => (
                      <TargetCard key={t.id} t={t} showOwner={tab === 'team'} onOpen={() => setOpenId(t.id)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {openId && (
        <TargetDrawer
          token={token}
          targetId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onOpenOther={(id) => setOpenId(id)}
          onEdit={(t) => {
            setOpenId(null);
            setForm({ team: t.user_id !== t.created_by, editing: t });
          }}
        />
      )}
      {form && (
        <TargetForm
          token={token}
          members={form.team && !form.editing ? team?.members || [] : undefined}
          preselect={form.preselect}
          editing={form.editing || null}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}
    </div>
  );
};
