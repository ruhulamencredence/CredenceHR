/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// OT Approval (OvertimeRoutes.ts) — overtime worked out from attendance that
// waits for a decision. One screen, two doors:
//   Admin Panel -> Duty Roster -> OT Approval   (layer "ot_approve")
//   Self Service -> Team OT                     (users.can_approve_team_ot)
// Payroll -> OT Rules says who approves (Team Supervisor / Roster manager /
// either / both in turn); the server only lists what this account may see and
// only lets it decide what is its own to decide.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, Search, TimerReset, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { ModulePath } from './ModulePath';
import { usePhoneHeaderTitle } from '../lib/headerPageTitle';
import { useIsPhone } from '../lib/useScrolling';
import { LoadingBlock } from './LoadingBlock';
import { APPROVER_MODE_LABEL, hm, hoursText, otStatusLabel, otStatusTone, parseHm, timeOnly } from '../lib/overtime';

interface OtEntry {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  date: string;
  day_kind: 'normal' | 'off';
  relief: boolean;
  shift: { code: string; name: string; start: string; end: string } | null;
  in_at: string | null;
  out_at: string | null;
  worked_minutes: number;
  built_in_minutes: number;
  calc_minutes: number;
  auto_minutes: number;
  over_limit_minutes: number;
  approved_minutes: number;
  status: string;
  step: number;
  step1_by: string | null;
  decided_by: string | null;
  can_act: 'final' | 'step1' | null;
  waiting_for: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const STATUS_TABS = [
  ['pending', 'Waiting'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['all', 'All']
] as const;

export const OtApprovalPanel: React.FC<{ token: string; selfService?: boolean; onBack?: () => void }> = ({ token, selfService, onBack }) => {
  usePhoneHeaderTitle('Team OT', !!selfService);
  const isPhone = useIsPhone();
  const isNativeApp = Capacitor.isNativePlatform();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number][0]>('pending');
  const [entries, setEntries] = useState<OtEntry[] | null>(null);
  const [mode, setMode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hours, setHours] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = `${month}-${pad(new Date(y, m, 0).getDate())}`;
    try {
      const r = await fetch(apiUrl(`/api/ot/approvals?from=${from}&to=${to}&status=${status}`), { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
      setEntries(j.entries || []);
      setMode(j.approver_mode || '');
      setSelected(new Set());
      setHours({});
    } catch (e: any) {
      setError(e.message);
      setEntries([]);
    }
  }, [token, month, status]);
  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (entries || []).filter((e) => !t || [e.employee_name, e.employee_code, e.designation, e.department].some((x) => (x || '').toLowerCase().includes(t)));
  }, [entries, q]);
  const actionable = shown.filter((e) => e.can_act);
  const allChecked = actionable.length > 0 && actionable.every((e) => selected.has(e.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const minutesFor = (e: OtEntry) => {
    const v = hours[e.id];
    if (v === undefined) return e.calc_minutes;
    return parseHm(v);
  };

  const decide = async (action: 'approve' | 'reject') => {
    const picked = (entries || []).filter((e) => selected.has(e.id) && e.can_act);
    if (!picked.length) return;
    const items = picked.map((e) => ({ id: e.id, minutes: action === 'approve' ? minutesFor(e) : undefined }));
    if (action === 'approve' && items.some((i) => i.minutes == null)) {
      setError('Write the hours as h:mm, e.g. 2:30.');
      return;
    }
    const total = action === 'approve' ? items.reduce((a, i) => a + (i.minutes || 0), 0) : 0;
    const ok = await confirmDialog(
      action === 'approve'
        ? `Approve ${picked.length} overtime entr${picked.length === 1 ? 'y' : 'ies'} — ${hoursText(total)} in all?`
        : `Reject ${picked.length} overtime entr${picked.length === 1 ? 'y' : 'ies'}? Only OT set in advance (roster / shift) stays paid.`,
      { confirmLabel: action === 'approve' ? 'Approve' : 'Reject', tone: action === 'reject' ? 'danger' : undefined }
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/ot/approvals/decide'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, items })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
      const parts = [
        j.finalized ? `${j.finalized} ${action === 'approve' ? 'approved' : 'rejected'}` : '',
        j.passed_on ? `${j.passed_on} passed on to the Roster manager` : '',
        j.skipped?.length ? `${j.skipped.length} skipped (${[...new Set(j.skipped.map((s: any) => s.reason))].join(', ')})` : ''
      ].filter(Boolean);
      setNotice(parts.join(' · ') || 'Nothing changed.');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const hoursBox = (e: OtEntry) =>
    e.can_act ? (
      <input
        aria-label={`Approved hours for ${e.employee_name} on ${e.date}`}
        value={hours[e.id] ?? hm(e.calc_minutes)}
        onChange={(ev) => setHours((h) => ({ ...h, [e.id]: ev.target.value }))}
        className="w-16 h-8 rounded-lg border border-slate-200 text-center text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-orange-300"
      />
    ) : (
      <span className="text-sm font-semibold text-slate-700">{hoursText(e.approved_minutes)}</span>
    );
  const kindChip = (e: OtEntry) => (
    <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${e.day_kind === 'off' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
      {e.day_kind === 'off' ? 'Off day' : 'Working day'}
      {e.relief ? ' · relief' : ''}
    </span>
  );
  const stateCell = (e: OtEntry) =>
    e.status === 'pending' && !e.can_act ? (
      <span className="text-[11px] text-slate-500">Waiting for {e.waiting_for}{e.step1_by ? ` (${e.step1_by} said yes)` : ''}</span>
    ) : (
      <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${otStatusTone(e.status)}`}>
        {e.status === 'pending' && e.step1_by ? `${e.step1_by} said yes · your turn` : otStatusLabel(e.status)}
        {e.decided_by ? ` · ${e.decided_by}` : ''}
      </span>
    );
  const workedText = (e: OtEntry) =>
    `${hoursText(e.calc_minutes)}${e.built_in_minutes ? ` (${hoursText(e.built_in_minutes)} in the shift)` : ''}${e.auto_minutes && e.status === 'pending' ? ` · ${hoursText(e.auto_minutes)} set in advance` : ''}`;

  const body = (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center rounded-xl bg-white border border-slate-200">
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))} className="p-2 hover:bg-slate-50 rounded-l-xl" aria-label="Previous month">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 text-sm font-semibold text-slate-800 min-w-[8.5rem] text-center">{monthLabel(month)}</span>
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-2 hover:bg-slate-50 rounded-r-xl" aria-label="Next month">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1">
          {STATUS_TABS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setStatus(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${status === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[12rem] max-w-xs">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Employee ID, designation…" aria-label="Search" className="w-full text-sm pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-200" />
        </div>
      </div>
      {mode && (
        <p className="text-xs text-slate-600">
          Who approves OT: <b>{APPROVER_MODE_LABEL[mode] || mode}</b> (Payroll → OT Rules). You see only the people you may approve for.
        </p>
      )}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{notice}</div>}

      {actionable.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
            <input
              type="checkbox"
              className="accent-orange-600"
              checked={allChecked}
              onChange={() => setSelected(allChecked ? new Set() : new Set(actionable.map((e) => e.id)))}
              aria-label="Select all you can approve"
            />
            Select all you can approve ({actionable.length})
          </label>
          <span className="flex-1" />
          <button type="button" disabled={busy || !selected.size} onClick={() => void decide('reject')} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-xs font-semibold bg-white border border-slate-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
            <X className="w-4 h-4" /> Reject selected
          </button>
          <button type="button" disabled={busy || !selected.size} onClick={() => void decide('approve')} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Approve selected ({selected.size})
          </button>
        </div>
      )}

      {entries === null ? (
        <LoadingBlock />
      ) : !shown.length ? (
        <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">
          {status === 'pending' ? 'No overtime waiting for you this month.' : 'Nothing here.'}
        </div>
      ) : isPhone ? (
        <div className="space-y-2.5">
          {shown.map((e) => (
            <div key={e.id} className="rounded-[22px] bg-white border border-slate-200 p-3.5 space-y-2">
              <div className="flex items-start gap-3">
                {e.can_act && <input type="checkbox" className="accent-orange-600 mt-1" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${e.employee_name} ${e.date}`} />}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900 truncate">{e.employee_name}</div>
                  <div className="text-[11px] text-slate-500 truncate">{[e.employee_code, e.designation].filter(Boolean).join(' · ')}</div>
                </div>
                {hoursBox(e)}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-slate-600">
                <span className="font-semibold text-slate-800">{dayLabel(e.date)}</span>
                {kindChip(e)}
                {e.shift && <span>{e.shift.code} {e.shift.start}–{e.shift.end}</span>}
              </div>
              <div className="text-xs text-slate-600">
                {timeOnly(e.in_at)} → {timeOnly(e.out_at)} · {workedText(e)}
              </div>
              {e.over_limit_minutes > 0 && <div className="text-[11px] text-amber-700">{hoursText(e.over_limit_minutes)} over the daily limit</div>}
              <div>{stateCell(e)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 w-8" />
                  <th className="px-3 py-2.5 font-semibold">Employee</th>
                  <th className="px-3 py-2.5 font-semibold">Date</th>
                  <th className="px-3 py-2.5 font-semibold">Shift · In → Out</th>
                  <th className="px-3 py-2.5 font-semibold">Worked out</th>
                  <th className="px-3 py-2.5 font-semibold">Approve (h:mm)</th>
                  <th className="px-3 py-2.5 font-semibold">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((e) => (
                  <tr key={e.id} className={e.can_act ? '' : 'bg-slate-50/50'}>
                    <td className="px-3 py-2.5">
                      {e.can_act && <input type="checkbox" className="accent-orange-600" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${e.employee_name} ${e.date}`} />}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-900">{e.employee_name}</div>
                      <div className="text-[11px] text-slate-500">{[e.employee_code, e.designation, e.department].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="text-slate-800">{dayLabel(e.date)}</div>
                      {kindChip(e)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">
                      <div>{e.shift ? `${e.shift.code} ${e.shift.start}–${e.shift.end}` : e.day_kind === 'off' ? 'Off' : 'Office hours'}</div>
                      <div className="font-semibold">{timeOnly(e.in_at)} → {timeOnly(e.out_at)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700">
                      {workedText(e)}
                      {e.over_limit_minutes > 0 && <div className="text-amber-700">{hoursText(e.over_limit_minutes)} over the daily limit</div>}
                    </td>
                    <td className="px-3 py-2.5">{hoursBox(e)}</td>
                    <td className="px-3 py-2.5">{stateCell(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  if (!selfService) return body;
  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-6xl">
        {!isNativeApp && <div className="hidden md:block"><ModulePath path={['Self Service', 'Team OT']} /></div>}
        <div className="hidden md:flex items-center gap-2 mb-3">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <TimerReset className="w-5 h-5 text-orange-600 shrink-0" /> Team OT
          </h1>
        </div>
        {body}
      </div>
    </div>
  );
};
