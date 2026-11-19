/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, BookOpen, FileSpreadsheet, History, Search } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';
import { LoadingBlock } from './LoadingBlock';

// Bill Claim Policy → Who has read the rules: everyone who can file a Bill
// Claim, whether they confirmed the current rules (Bill Claim → (i) Rules,
// BillClaimRulesSheet.tsx), an older version, only opened them, or never;
// and the read log. GET /api/bill-claim-rules/readers (Bill Claim module /
// Superadmin, the same as this page).

type Status = 'read' | 'old' | 'opened' | 'never';
interface Person {
  user_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  status: Status;
  confirmed_at: string | null;
  confirmed_version: number | null;
  device: string | null;
  opens: number;
}
interface Data {
  version: { no: number; at: string | null; changed_by: string | null; summary: string | null };
  people: Person[];
  log: { at: string | null; name: string; action: 'open' | 'confirm'; version: number | null; device: string | null }[];
}

const ST: Record<Status, { label: string; hint: string; chip: string; color: string }> = {
  read: { label: 'Read the current rules', hint: 'confirmed', chip: 'bg-emerald-50 text-emerald-700', color: '#0e8a5c' },
  old: { label: 'Read an older version', hint: 'must read again', chip: 'bg-amber-50 text-amber-700', color: '#d97706' },
  opened: { label: "Opened, didn't confirm", hint: 'closed without the tick', chip: 'bg-violet-50 text-violet-700', color: '#7c3aed' },
  never: { label: 'Never opened', hint: 'not once', chip: 'bg-rose-50 text-rose-700', color: '#e11d48' }
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export const BillClaimRulesReaders: React.FC<{ token: string; refreshKey?: number }> = ({ token, refreshKey }) => {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Status | ''>('');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${token}` };

  const load = () =>
    fetch(apiUrl('/api/bill-claim-rules/readers'), { headers })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? (setData(d), setError('')) : setError(d?.error || 'Could not load.')))
      .catch(() => setError('Could not load — check the connection.'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshKey]);

  const count = (s: Status) => (data?.people || []).filter((p) => p.status === s).length;
  const departments = useMemo(() => [...new Set((data?.people || []).map((p) => p.department).filter(Boolean) as string[])].sort(), [data]);
  const needle = q.trim().toLowerCase();
  const shown = (data?.people || [])
    .filter((p) => !filter || p.status === filter)
    .filter((p) => !dept || p.department === dept)
    .filter((p) => !needle || [p.name, p.employee_code, p.designation, p.department].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => (['never', 'opened', 'old', 'read'] as Status[]).indexOf(a.status) - (['never', 'opened', 'old', 'read'] as Status[]).indexOf(b.status) || a.name.localeCompare(b.name));
  const unread = (data?.people || []).filter((p) => p.status !== 'read').length;

  const remind = async () => {
    if (!(await confirmDialog(`Send a reminder to the ${unread} who haven't confirmed the current Bill Claim rules?`, { confirmLabel: 'Send reminder' }))) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await fetch(apiUrl('/api/bill-claim-rules/remind'), { method: 'POST', headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not send.');
      setMsg(`Reminder sent to ${d.sent}.`);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const excel = async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Employee', 'Employee ID', 'Designation', 'Department', 'Status', 'Confirmed', 'Rules version', 'Device', 'Opened'],
        ...shown.map((p) => [p.name, p.employee_code || '', p.designation || '', p.department || '', ST[p.status].label, when(p.confirmed_at), p.confirmed_version ? `v${p.confirmed_version}` : '', p.device || '', p.opens])
      ]),
      'Who has read'
    );
    await saveWorkbookCrossPlatform(wb, 'Bill-Claim-rules-readers.xlsx');
  };

  if (error) return <div className="bg-white border border-slate-200 rounded-2xl p-5 text-sm text-rose-600">{error}</div>;
  if (!data) return <LoadingBlock />;

  const total = data.people.length || 1;
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const readPct = Math.round((count('read') / total) * 100);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="px-5 pt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-orange-600" /> Who has read the rules
          </h3>
          <p className="text-[11px] text-slate-500 max-w-xl">
            Everyone who can file a Bill Claim reads and confirms these rules once before their first claim (Bill Claim → (i) Rules), and again after any change. Their own claims are refused until then.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {unread > 0 && (
            <button type="button" disabled={busy} onClick={() => void remind()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
              <BellRing className="w-3.5 h-3.5" /> Remind the {unread} who haven't
            </button>
          )}
          <button type="button" onClick={() => void excel()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>
      {msg && <p className="mx-5 mt-2 text-xs text-emerald-700">{msg}</p>}

      <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] gap-5 items-center px-5 py-4">
        <div className="relative w-[170px] h-[170px] mx-auto">
          <svg width="170" height="170" viewBox="0 0 170 170">
            <circle cx="85" cy="85" r={R} fill="none" stroke="#e2e8f0" strokeWidth="20" />
            {(['read', 'old', 'opened', 'never'] as Status[]).map((s) => {
              const n = count(s);
              if (!n) return null;
              const len = (C * n) / total;
              const el = (
                <circle key={s} cx="85" cy="85" r={R} fill="none" stroke={ST[s].color} strokeWidth="20" strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 85 85)" />
              );
              offset += len;
              return el;
            })}
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="text-3xl font-extrabold tracking-tight text-slate-900">{readPct}%</div>
              <div className="text-[10.5px] text-slate-500">read the current rules</div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {(['read', 'old', 'opened', 'never'] as Status[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={filter === s}
              onClick={() => setFilter(filter === s ? '' : s)}
              className={`flex items-center gap-3 text-left rounded-2xl border px-3 py-2.5 ${filter === s ? 'border-orange-500 ring-2 ring-orange-100' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              <span className="w-2.5 h-9 rounded-full shrink-0" style={{ background: ST[s].color }} />
              <span>
                <span className="text-xl font-extrabold tabular-nums text-slate-900">{count(s)}</span>{' '}
                <span className="text-xs font-semibold text-slate-700">{ST[s].label}</span>
                <span className="block text-[10.5px] text-slate-400">{ST[s].hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-orange-50/70 border border-orange-100 px-3 py-2 text-[11.5px] text-slate-600">
        <span className="font-extrabold text-orange-700 bg-white rounded-md px-1.5">v{data.version.no}</span>
        {data.version.no > 1 ? (
          <span>
            Rules changed <b className="text-slate-800">{when(data.version.at)}</b>
            {data.version.changed_by ? (
              <>
                {' '}
                by <b className="text-slate-800">{data.version.changed_by}</b>
              </>
            ) : null}
            {data.version.summary ? ` — ${data.version.summary}` : ''}. Everyone confirms again.
          </span>
        ) : (
          <span>The first version of the rules — since {when(data.version.at)}.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 px-5 pb-3">
        <label className="flex items-center gap-2 flex-1 min-w-[220px] bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
          <Search className="w-3.5 h-3.5 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, Employee ID, designation or department" aria-label="Search" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
        </label>
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto border-t border-slate-100">
        <table className="w-full min-w-[780px] text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Employee</th>
              <th className="px-4 py-2.5 font-semibold">Department</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Confirmed</th>
              <th className="px-4 py-2.5 font-semibold">Rules</th>
              <th className="px-4 py-2.5 font-semibold">Device</th>
              <th className="px-4 py-2.5 font-semibold">Opened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                  Nobody matches.
                </td>
              </tr>
            )}
            {shown.map((p) => (
              <tr key={p.user_id}>
                <td className="px-4 py-2.5">
                  <div className="font-semibold text-slate-900">{p.name}</div>
                  <div className="text-[11px] text-slate-500">{[p.employee_code, p.designation].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="px-4 py-2.5 text-slate-600">{p.department || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${ST[p.status].chip}`}>{ST[p.status].label}</span>
                </td>
                <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{when(p.confirmed_at)}</td>
                <td className="px-4 py-2.5">
                  {p.confirmed_version ? (
                    <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-md ${p.confirmed_version === data.version.no ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>v{p.confirmed_version}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{p.device || '—'}</td>
                <td className="px-4 py-2.5 tabular-nums text-slate-600">{p.opens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-200 px-5 py-4">
        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-2">
          <History className="w-3.5 h-3.5 text-slate-500" /> Read log
        </h4>
        {data.log.length === 0 ? (
          <p className="text-xs text-slate-400">Nobody has opened the rules yet.</p>
        ) : (
          <ol className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {data.log.map((l, i) => (
              <li key={i} className="grid grid-cols-[96px_12px_1fr] gap-2.5 items-start text-xs">
                <span className="text-[11px] text-slate-400 text-right pt-px">{when(l.at)}</span>
                <span className={`mt-1 w-2.5 h-2.5 rounded-full ${l.action === 'confirm' ? 'bg-emerald-500' : 'bg-sky-500'}`} />
                <span>
                  <b className="text-slate-800">{l.name}</b> {l.action === 'confirm' ? 'confirmed the rules' : 'opened the rules'}
                  <span className="block text-[11px] text-slate-500">{[l.version ? `v${l.version}` : null, l.device].filter(Boolean).join(' · ')}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
};
