/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Management -> Reports -> Undelivered MPR (PEPM Reports
// layer "close_short", explicit-only; server: MprDispatchRoutes.ts).
//   Undelivered  MPR rows of a Budget whose material hasn't fully arrived —
//                Delivery Date passed or after the Budget's last date (or all).
//                Tick rows -> "Close short…" sets the rest aside, with a reason.
//   Set aside    what was closed short: kept, not owed, not dispatched, its
//                Budget allocation still held — for a later decision. Undo
//                while the Budget's last delivery date hasn't passed.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileDown, PackageX, Undo2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';
import { confirmDialog } from '../lib/confirmDialog';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface Row {
  id: number;
  jobNo: string;
  mprNo: string;
  item: string;
  unit: string;
  projectName: string;
  owner: string;
  budgetName: string;
  budgetLastDate: string | null;
  deliveryDate: string | null;
  passed: boolean;
  asked: number;
  received: number;
  onWay: number;
  setAside: number;
  owed: number;
  canSetAside: number;
  owedValue: number;
  setAsideValue: number;
  setAsideAt: string | null;
  setAsideBy: string;
  setAsideReason: string;
}
interface Budget {
  id: number;
  name: string;
  from: string | null;
  to: string | null;
  rows: number;
}

const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const fmtQty = (n: number, unit = '') => `${Math.round(n * 100) / 100}${unit ? ` ${unit}` : ''}`;
const money = (n: number) => (n ? `৳ ${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—');

export const MprUndelivered: React.FC<{ token: string; projects: { id: number; project_name: string }[] }> = ({ token, projects }) => {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(apiUrl(path), { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error(d?.error || 'Something went wrong.');
    return d;
  };
  const [tab, setTab] = useState<'undelivered' | 'aside'>('undelivered');
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetId, setBudgetId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [show, setShow] = useState<'passed' | 'all'>('passed');
  const [data, setData] = useState<{ rows: Row[]; setAside: Row[]; totals: any } | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    call('/api/mpr/undelivered/budgets')
      .then((b: Budget[]) => {
        setBudgets(b);
        if (b[0]) setBudgetId((v) => v || String(b[0].id));
      })
      .catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const load = async () => {
    if (!budgetId) return;
    setErr('');
    try {
      const p = new URLSearchParams({ budget_id: budgetId, show, ...(projectId ? { project_id: projectId } : {}) });
      setData(await call(`/api/mpr/undelivered?${p}`));
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    setData(null);
    setTicked(new Set());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetId, projectId, show]);

  const budget = budgets.find((b) => String(b.id) === budgetId) || null;
  const rows = data?.rows || [];
  const picked = rows.filter((r) => ticked.has(r.id));
  const tickable = rows.filter((r) => r.canSetAside > 0);
  const allTicked = tickable.length > 0 && tickable.every((r) => ticked.has(r.id));
  const toggle = (id: number) => setTicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const exportExcel = async () => {
    const XLSX = await import('xlsx');
    const list = tab === 'undelivered' ? rows : data?.setAside || [];
    const ws = XLSX.utils.json_to_sheet(
      list.map((r) => ({
        'Job No': r.jobNo,
        'MPR No': r.mprNo,
        Item: r.item,
        Unit: r.unit,
        Project: r.projectName,
        Owner: r.owner,
        'Delivery Date': r.deliveryDate || '',
        Asked: r.asked,
        Received: r.received,
        'On the way': r.onWay,
        'Set aside': r.setAside,
        'Still owed': r.owed,
        ...(tab === 'aside' ? { 'Set aside by': r.setAsideBy, 'Set aside on': r.setAsideAt ? r.setAsideAt.slice(0, 10) : '', Reason: r.setAsideReason } : {})
      }))
    );
    ws['!cols'] = new Array(15).fill({ wch: 15 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tab === 'undelivered' ? 'Undelivered' : 'Set aside');
    void saveWorkbookCrossPlatform(wb, `${tab === 'undelivered' ? 'Undelivered_MPR' : 'Set_aside_MPR'}_${(budget?.name || 'budget').replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
  };

  const undo = async (r: Row) => {
    if (!(await confirmDialog(`Put ${fmtQty(r.setAside, r.unit)} of ${r.mprNo} (${r.item}) back in the Budget? It is owed again and Purchase can dispatch it.`, { confirmLabel: 'Undo' }))) return;
    try {
      await call('/api/mpr/close-short/undo', { method: 'POST', body: JSON.stringify({ entryId: r.id }) });
      setMsg(`${r.mprNo}: set-aside Qty is owed again.`);
      void load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const tabBtn = (k: typeof tab, label: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={`px-3 py-2.5 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap flex items-center gap-1.5 ${tab === k ? 'text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
      style={tab === k ? { borderColor: 'var(--g-accent, #7f00ff)' } : undefined}
    >
      {label}
    </button>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-clip">
      <div className="px-5 sm:px-6 pt-5 pb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2"><PackageX className="w-5 h-5 text-pink-600" /> Undelivered MPR</h3>
          <p className="text-xs text-slate-500 mt-0.5">MPR rows whose material hasn't fully arrived. Close short sets the rest aside — kept, not deleted, for a later decision.</p>
        </div>
        <button type="button" onClick={() => void exportExcel()} disabled={!data} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50">
          <FileDown className="w-3.5 h-3.5" /> Export Excel
        </button>
      </div>
      <div className="px-3 sm:px-5 flex gap-1 border-b border-slate-200">
        {tabBtn('undelivered', <>Undelivered{data && <span className="text-[10px] font-bold px-1.5 rounded-full bg-rose-100 text-rose-700">{rows.length}</span>}</>)}
        {tabBtn('aside', <>Set aside{data && <span className="text-[10px] font-bold px-1.5 rounded-full bg-pink-100 text-pink-700">{data.setAside.length}</span>}</>)}
      </div>
      <div className="px-5 sm:px-6 py-3 border-b border-slate-200 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-80">
          <SearchSelect aria-label="Budget" value={budgetId} onChange={(e) => setBudgetId(e.target.value)} className="w-full px-3 py-2 text-xs font-semibold bg-white border border-slate-200 rounded-lg">
            <option value="">— Select Budget —</option>
            {budgets.map((b) => (
              <option key={b.id} value={String(b.id)}>{`${b.name}${b.to ? ` · delivery till ${fmtDate(b.to)}` : ''} · ${b.rows} rows`}</option>
            ))}
          </SearchSelect>
        </div>
        <div className="w-[calc(50%-0.25rem)] sm:w-48">
          <SearchSelect aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg">
            <option value="">— All projects —</option>
            {projects.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.project_name}</option>
            ))}
          </SearchSelect>
        </div>
        {tab === 'undelivered' && (
          <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as 'passed' | 'all')} className="w-[calc(50%-0.25rem)] sm:w-auto px-2.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg">
            <option value="passed">Date passed / after the Budget</option>
            <option value="all">Everything not fully in</option>
          </select>
        )}
      </div>
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 px-5 sm:px-6 pt-3">
          {(
            [
              [String(data.totals.rows), 'MPR rows in this Budget', ''],
              [String(data.totals.owedRows), 'Not fully received', ''],
              [money(data.totals.owedValue), 'Value still to come', ''],
              [`${data.totals.setAsideRows}${data.totals.setAsideValue ? ` · ${money(data.totals.setAsideValue)}` : ''}`, 'Set aside (closed short)', 'pink']
            ] as [string, string, string][]
          ).map(([v, label, tone]) => (
            <div key={label} className={`rounded-xl border px-3 py-2 ${tone ? 'border-pink-200 bg-pink-50' : 'border-slate-200 bg-slate-50'}`}>
              <div className={`text-base font-bold tabular-nums ${tone ? 'text-pink-700' : 'text-slate-900'}`}>{v}</div>
              <div className="text-[11px] text-slate-500">{label}</div>
            </div>
          ))}
        </div>
      )}
      {err && <p className="mx-6 mt-3 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700">{err}</p>}
      {msg && <p className="mx-6 mt-3 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700">{msg}</p>}
      {!budgetId ? (
        <p className="text-xs text-slate-400 text-center py-12">Pick a Budget.</p>
      ) : !data && !err ? (
        <p className="text-xs text-slate-400 text-center py-12">Loading…</p>
      ) : tab === 'undelivered' ? (
        rows.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-12">Nothing undelivered here{show === 'passed' ? ' with its date passed' : ''}.</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[13px] min-w-[860px]">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="pl-5 pr-1 py-2.5 w-8">
                      <input type="checkbox" aria-label="Tick every row" checked={allTicked} disabled={!tickable.length} onChange={() => setTicked(allTicked ? new Set() : new Set(tickable.map((r) => r.id)))} />
                    </th>
                    <th className="px-3 py-2.5 text-left">MPR</th>
                    <th className="px-3 py-2.5 text-left">Item · Project</th>
                    <th className="px-3 py-2.5 text-left">Delivery Date</th>
                    <th className="px-3 py-2.5 text-left">Asked</th>
                    <th className="px-3 py-2.5 text-left">Received</th>
                    <th className="px-3 py-2.5 text-left">On the way</th>
                    <th className="px-3 py-2.5 text-left">Still owed</th>
                    <th className="px-3 py-2.5 text-left">Owner</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className={ticked.has(r.id) ? 'bg-orange-50/60' : ''}>
                      <td className="pl-5 pr-1 py-2.5">
                        <input type="checkbox" aria-label={`Tick ${r.mprNo}`} checked={ticked.has(r.id)} disabled={r.canSetAside <= 0} onChange={() => toggle(r.id)} title={r.canSetAside <= 0 ? 'Everything left is on the way' : undefined} />
                      </td>
                      <td className="px-3 py-2.5"><b className="text-blue-700">{r.jobNo}</b><div className="font-mono text-xs text-slate-600">{r.mprNo}</div></td>
                      <td className="px-3 py-2.5">{r.item}<div className="text-[11px] text-slate-500">{r.projectName}</div></td>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{fmtDate(r.deliveryDate)}{r.passed && <span className="ml-1 text-[11px] font-bold text-rose-700">· passed</span>}</td>
                      <td className="px-3 py-2.5 tabular-nums">{fmtQty(r.asked, r.unit)}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {fmtQty(r.received)}
                        <div className="mt-1 h-1.5 w-20 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${r.asked ? Math.min(100, (r.received / r.asked) * 100) : 0}%` }} /></div>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{r.onWay ? fmtQty(r.onWay) : '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums font-bold text-rose-700">{fmtQty(r.owed, r.unit)}{r.setAside > 0 && <div className="text-[11px] font-medium text-pink-700">{fmtQty(r.setAside)} set aside</div>}</td>
                      <td className="px-3 py-2.5">{r.owner || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {picked.length > 0 && (
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 px-5 sm:px-6 py-3 bg-orange-50 border-t border-orange-200">
                <b className="text-sm text-slate-800">{picked.length} ticked · {fmtQty(picked.reduce((n, r) => n + r.canSetAside, 0))} can be set aside</b>
                <span className="flex gap-2">
                  <button type="button" onClick={() => setTicked(new Set())} className="px-4 py-2 rounded-full text-xs font-semibold border border-slate-200 bg-white">Clear</button>
                  <button type="button" onClick={() => setClosing(true)} className="px-4 py-2 rounded-full text-xs font-bold text-white" style={{ background: 'var(--g-accent, #7f00ff)' }}>Close short…</button>
                </span>
              </div>
            )}
          </>
        )
      ) : (data?.setAside.length || 0) === 0 ? (
        <p className="text-xs text-slate-400 text-center py-12">Nothing set aside in this Budget.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[13px] min-w-[760px]">
            <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2.5 text-left">MPR · Item</th>
                <th className="px-4 py-2.5 text-left">Project</th>
                <th className="px-4 py-2.5 text-left">Set aside</th>
                <th className="px-4 py-2.5 text-left">Why · who · when</th>
                <th className="px-4 py-2.5 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data!.setAside.map((r) => {
                const canUndo = !r.budgetLastDate || r.budgetLastDate >= new Date().toLocaleDateString('en-CA');
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5"><span className="font-mono text-xs">{r.mprNo}</span> <span className="text-blue-700 font-semibold text-xs">{r.jobNo}</span><div>{r.item}</div></td>
                    <td className="px-4 py-2.5">{r.projectName}</td>
                    <td className="px-4 py-2.5 tabular-nums"><b className="text-pink-700">{fmtQty(r.setAside, r.unit)}</b><div className="text-[11px] text-slate-500">{r.setAsideValue ? `${money(r.setAsideValue)} · ` : ''}of {fmtQty(r.asked)} asked, {fmtQty(r.received)} in</div></td>
                    <td className="px-4 py-2.5 text-xs">{r.setAsideReason}<div className="text-[11px] text-slate-500">{r.setAsideBy}{r.setAsideAt ? ` · ${fmtDate(r.setAsideAt.slice(0, 10))}` : ''}</div></td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <span className="inline-block text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-pink-50 text-pink-700 mr-2">Waiting</span>
                      {canUndo ? (
                        <button type="button" onClick={() => void undo(r)} className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: 'var(--g-accent, #7f00ff)' }}><Undo2 className="w-3.5 h-3.5" /> Undo</button>
                      ) : (
                        <span className="text-[11px] text-slate-400" title="The Budget's last delivery date has passed">Budget closed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {closing && (
        <CloseShortPopup
          rows={picked}
          onClose={() => setClosing(false)}
          onSave={async (items, reason) => {
            const d = await call('/api/mpr/close-short', { method: 'POST', body: JSON.stringify({ items, reason }) });
            setClosing(false);
            setTicked(new Set());
            setMsg(`${d.done} row${d.done === 1 ? '' : 's'} closed short — the rest is in Set aside.${d.problems?.length ? ` Not done: ${d.problems.join(' ')}` : ''}`);
            void load();
          }}
        />
      )}
    </div>
  );
};

const CloseShortPopup: React.FC<{ rows: Row[]; onClose: () => void; onSave: (items: { entryId: number; qty: number }[], reason: string) => Promise<void> }> = ({ rows, onClose, onSave }) => {
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(rows.map((r) => [r.id, String(Math.round(r.canSetAside * 100) / 100)])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useBackButtonClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const onWay = useMemo(() => rows.filter((r) => r.onWay > 0), [rows]);
  const bad = rows.find((r) => !(Number(qty[r.id]) > 0) || Number(qty[r.id]) > r.canSetAside + 0.005);
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await onSave(rows.map((r) => ({ entryId: r.id, qty: Number(qty[r.id]) })), reason.trim());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-[120] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="w-full max-w-lg max-h-full flex">
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="px-5 pt-5 pb-2 flex items-start gap-3">
            <div className="flex-1">
              <h4 className="text-base font-bold text-slate-900">Close short — {rows.length} MPR row{rows.length === 1 ? '' : 's'}</h4>
              <p className="text-xs text-slate-600 mt-1">The rest is set aside: it leaves this Budget's open list and Purchase can't dispatch it any more. Nothing is deleted.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip p-1.5 rounded-full text-slate-600"><X className="w-4 h-4" /></button>
          </div>
          <div className="px-5 pb-5 overflow-y-auto space-y-3">
            <div className="liquid-glass-inset rounded-[20px] px-3 divide-y divide-slate-200/70">
              {rows.map((r) => (
                <div key={r.id} className="py-2.5 grid grid-cols-[minmax(0,1fr)_110px] gap-3 items-center text-[13px]">
                  <div className="min-w-0">
                    <b className="font-mono">{r.mprNo}</b> {r.item}
                    <div className="text-[11px] text-slate-500">asked {fmtQty(r.asked)} · received {fmtQty(r.received)}{r.onWay ? ` · on the way ${fmtQty(r.onWay)}` : ''} · max {fmtQty(r.canSetAside, r.unit)}</div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={r.canSetAside}
                    step="any"
                    aria-label={`Set aside for ${r.mprNo}`}
                    value={qty[r.id] ?? ''}
                    onChange={(e) => setQty((q) => ({ ...q, [r.id]: e.target.value }))}
                    className="w-full text-right px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              ))}
            </div>
            {onWay.length > 0 && (
              <p className="text-[11.5px] leading-snug text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
                Something is on the way on {onWay.map((r) => r.mprNo).join(', ')} — only what isn't dispatched can be set aside. Cancel that dispatch first to set it aside too.
              </p>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason (required)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. Supplier can't deliver before the Budget closes — decide on the next Budget later"
                className="w-full text-sm px-3 py-2 rounded-2xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
              />
            </div>
            {err && <p className="text-xs text-rose-700">{err}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
              <button type="button" onClick={() => void save()} disabled={busy || !!bad || reason.trim().length < 3} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold disabled:opacity-50">
                {busy ? 'Saving…' : `Close short ${rows.length} row${rows.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
