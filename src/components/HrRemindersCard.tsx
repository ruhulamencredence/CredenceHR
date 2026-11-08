/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Dashboard -> "Coming up" (HrRemindersRoutes.ts): the
// dates HR must act on — probation and contract ends, expiring documents,
// retirements and increments — from 30 days overdue to 60 days ahead, each
// with its next step one click away (the personnel action form with the
// Employee and action type already picked). Shown only to accounts with the
// HR Operations layer "reminders_receive" (the server checks it too); the
// same accounts get these as alerts / push before each date.

import React, { useEffect, useState } from 'react';
import { CalendarClock, BadgeCheck, Clock, FileWarning, Hourglass, TrendingUp, Eye } from 'lucide-react';
import { useHrApi, fmtDate, Notice, type HrOpsMeta, type HrOpsEmployee } from './HrOpsShared';
import { NewActionModal } from './HrOpsActions';

interface HrEvent {
  key: string;
  kind: 'probation' | 'contract' | 'document' | 'retirement' | 'increment';
  label: string;
  detail: string | null;
  employee_id: number;
  employee_code: string | null;
  name: string;
  designation: string | null;
  date: string;
  days: number;
  next_actions: string[];
  pending_action: { id: number; type: string } | null;
}

const KIND: Record<HrEvent['kind'], { icon: React.ComponentType<{ className?: string }>; cls: string; label: string }> = {
  probation: { icon: BadgeCheck, cls: 'bg-teal-50 text-teal-700 border-teal-200', label: 'Probation' },
  contract: { icon: Clock, cls: 'bg-sky-50 text-sky-700 border-sky-200', label: 'Contract' },
  document: { icon: FileWarning, cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Document' },
  retirement: { icon: Hourglass, cls: 'bg-violet-50 text-violet-700 border-violet-200', label: 'Retirement' },
  increment: { icon: TrendingUp, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Increment' }
};
// Short button text for each next-step personnel action.
const ACTION_BUTTON: Record<string, string> = {
  confirmation: 'Confirm',
  probation_extension: 'Extend',
  contract_renewal: 'Renew',
  termination: 'End',
  retirement: 'Retire',
  increment: 'Increment'
};

const when = (days: number) => (days < 0 ? `${-days}d overdue` : days === 0 ? 'Today' : `in ${days}d`);

export const HrRemindersCard: React.FC<{
  token: string;
  meta: HrOpsMeta;
  employees: HrOpsEmployee[];
  onOpenEmployee?: (id: number) => void;
  onChanged?: () => void;
}> = ({ token, meta, employees, onOpenEmployee, onChanged }) => {
  const api = useHrApi(token);
  const [events, setEvents] = useState<HrEvent[] | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<HrEvent['kind'] | 'all'>('all');
  const [acting, setActing] = useState<{ employeeId: number; type: string; date: string } | null>(null);

  const load = () =>
    api
      .get<{ events: HrEvent[] }>('/api/hr-ops/reminders/upcoming')
      .then((r) => setEvents(r.events))
      .catch((e) => {
        setError(e.message);
        setEvents([]);
      });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const kinds = [...new Set((events || []).map((e) => e.kind))];
  const shown = (events || []).filter((e) => filter === 'all' || e.kind === filter);
  const label = (t: string) => meta.action_types.find((a) => a.key === t)?.label || t;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5 text-blue-600" /> Coming up — next 60 days
          {events && <span className="text-slate-400 font-medium">({events.length})</span>}
        </div>
        {kinds.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {(['all', ...kinds] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${filter === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
              >
                {k === 'all' ? 'All' : KIND[k].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {(error || msg) && (
        <div className="px-4 pt-3">
          {error && <Notice msg={{ type: 'error', text: error }} />}
          <Notice msg={msg} onClose={() => setMsg(null)} />
        </div>
      )}
      {!events ? (
        <div className="p-4 space-y-2 animate-pulse" aria-busy="true" aria-label="Loading reminders">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="px-4 py-6 text-xs text-slate-400 text-center">Nothing due in the next 60 days.</p>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
          {shown.map((e) => {
            const k = KIND[e.kind];
            const Icon = k.icon;
            return (
              <li key={e.key} className="px-4 py-2.5 text-xs flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex items-center gap-2 min-w-0 sm:flex-1">
                  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap shrink-0 ${k.cls}`}>
                    <Icon className="w-3 h-3" /> {e.label}
                  </span>
                  <button type="button" className="min-w-0 text-left truncate" onClick={() => onOpenEmployee?.(e.employee_id)} title="Open Service Book">
                    <span className="font-semibold text-slate-800">{e.name}</span>{' '}
                    <span className="text-slate-400">{[e.employee_code, e.designation, e.detail].filter(Boolean).join(' · ')}</span>
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
                  <span className={`whitespace-nowrap ${e.days < 0 ? 'text-rose-600 font-semibold' : e.days <= 7 ? 'text-amber-700 font-semibold' : 'text-slate-600'}`}>
                    {fmtDate(e.date)} · {when(e.days)}
                  </span>
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    {e.pending_action ? (
                      <span className="text-[10px] font-semibold text-slate-500">{label(e.pending_action.type)} pending</span>
                    ) : e.next_actions.length ? (
                      e.next_actions.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setActing({ employeeId: e.employee_id, type: t, date: e.date })}
                          className="text-[10px] font-semibold px-2 py-1 rounded-lg border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100"
                        >
                          {ACTION_BUTTON[t] || label(t)}
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenEmployee?.(e.employee_id)}
                        className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                      >
                        <Eye className="w-3 h-3" /> Open
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {acting && (
        <NewActionModal
          token={token}
          meta={meta}
          employees={employees}
          initialEmployeeId={acting.employeeId}
          initialType={acting.type}
          initialEffectiveDate={acting.date}
          onClose={() => setActing(null)}
          onSaved={(status) => {
            setActing(null);
            setMsg({ type: 'success', text: status === 'approved' ? 'Saved — no approval chain is set, so it was approved right away.' : 'Submitted — the first approver has been notified.' });
            load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
};
