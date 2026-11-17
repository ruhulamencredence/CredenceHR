/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> MPR Edit Log (module "editlog", MprEditLogRoutes.ts).
//   Pending approvals  Job Edit requests (the existing section, passed in)
//   Edit history       one card per save: what one person changed on one MPR
//                      row, old value struck, new value bold, how many days a
//                      Delivery Date moved; refused edits as red "Tried — not
//                      saved" cards. Filters stick under the header.
//   Needs update       Delivery Date passed, material not fully in (layer
//                      mpr_followup)
//   People             per MPR owner (layer mpr_followup)
// "Full history" opens one row's whole story in a liquid-glass side sheet.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, FileDown, Search, X, Clock3, AlertTriangle, Users as UsersIcon, ChevronRight } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { useElementHeight } from '../lib/useElementHeight';

interface Change {
  field: string;
  from: string | null;
  to: string | null;
}
interface LogEvent {
  id: string;
  type: 'edit' | 'attempt';
  at: string;
  entry_id: number;
  job_no: string | null;
  mpr_no: string | null;
  item_name: string | null;
  project_name: string | null;
  owner_name: string | null;
  editor_id: number | null;
  editor_name: string | null;
  reason?: string;
  changes: Change[];
}
interface LogResponse {
  items: LogEvent[];
  total: number;
  stats: { saves: number; today: number; later: number; attempts: number; people: number };
  editors: { id: number; name: string }[];
}

const FIELD_LABELS: Record<string, string> = {
  item_name: 'Item Name',
  delivery_date: 'Delivery Date',
  mpr_no: 'MPR No',
  job_name: 'Job Name',
  job_duration: 'Job Duration',
  requisitioned_qty: 'Requisitioned Qty',
  job_edit_add: 'MPR added (Job Edit)',
  job_edit_new_job: 'New Job added (Job Edit)',
  close_short: 'Closed short',
  close_short_undo: 'Close short undone'
};
const KINDS: [string, string][] = [
  ['', 'All changes'],
  ['delivery_date', 'Delivery Date'],
  ['qty', 'Requisitioned Qty'],
  ['item', 'Item Name'],
  ['mpr', 'MPR No'],
  ['job', 'Job Name / Duration'],
  ['job_edit', 'Job Edit (added)'],
  ['close_short', 'Close short'],
  ['attempt', 'Tried — not saved']
];
const RANGES: [string, string][] = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['month', 'This month'],
  ['all', 'All time']
];

const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}/.test(String(v || ''));
const dayMs = (d: string) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
const shortDate = (v: any) => {
  if (!isDate(v)) return String(v ?? '') || '—';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};
// "1200.00" -> "1200" (Qty is stored with decimals).
const trimNum = (v: string) => (/^-?\d+\.\d+$/.test(v) ? String(Number(v)) : v);
const showValue = (field: string, v: any) =>
  field === 'delivery_date' ? shortDate(v) : v === null || v === undefined || v === '' ? '—' : field === 'requisitioned_qty' ? trimNum(String(v)) : String(v);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
const dayHeading = (day: string) => {
  const today = new Date().toLocaleDateString('en-CA');
  const yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
  const label = new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return day === today ? `Today · ${label}` : day === yest ? `Yesterday · ${label}` : new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' }) + ` · ${label}`;
};

// "+8 days later", "1 day earlier", "+50"
function deltaOf(c: Change): { text: string; tone: 'late' | 'up' } | null {
  if (c.field === 'delivery_date' && isDate(c.from) && isDate(c.to)) {
    const d = Math.round((dayMs(String(c.to)) - dayMs(String(c.from))) / 86400000);
    if (!d) return null;
    return d > 0 ? { text: `+${d} day${d === 1 ? '' : 's'} later`, tone: 'late' } : { text: `${-d} day${d === -1 ? '' : 's'} earlier`, tone: 'up' };
  }
  if (c.field === 'requisitioned_qty') {
    const a = Number(c.from);
    const b = Number(c.to);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return { text: `${b > a ? '+' : ''}${Math.round((b - a) * 1000) / 1000}`, tone: 'up' };
  }
  return null;
}

const fieldTone = (f: string) =>
  f === 'delivery_date'
    ? 'bg-sky-50 text-sky-700'
    : f === 'requisitioned_qty'
      ? 'bg-amber-50 text-amber-700'
      : f.startsWith('job_edit')
        ? 'bg-emerald-50 text-emerald-700'
        : f.startsWith('close_short')
          ? 'bg-pink-50 text-pink-700'
          : 'bg-slate-100 text-slate-700';

export const MprEditLog: React.FC<{
  token: string;
  projects: { id: number; project_name: string }[];
  pendingCount: number;
  pendingSection: React.ReactNode;
  canFollowup: boolean;
}> = ({ token, projects, pendingCount, pendingSection, canFollowup }) => {
  const [tab, setTab] = useState<'pending' | 'history' | 'needs' | 'people'>(pendingCount > 0 ? 'pending' : 'history');
  const [range, setRange] = useState('7d');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState('');
  const [editor, setEditor] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<LogResponse | null>(null);
  const [items, setItems] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [barRef, barH] = useElementHeight(60);

  const get = async (path: string) => {
    const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error(d?.error || 'Could not load.');
    return d;
  };
  const params = (offset: number, limit: number | 'all' = 50) =>
    new URLSearchParams({
      range,
      ...(projectId ? { project_id: projectId } : {}),
      ...(kind ? { kind } : {}),
      ...(editor ? { editor } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      limit: String(limit),
      offset: String(offset)
    }).toString();

  // Reload when a filter changes (the search waits for typing to pause).
  useEffect(() => {
    if (tab !== 'history') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const d: LogResponse = await get(`/api/mpr-edit-log?${params(0)}`);
        if (cancelled) return;
        setData(d);
        setItems(d.items);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, range, projectId, kind, editor, q, token]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const d: LogResponse = await get(`/api/mpr-edit-log?${params(items.length)}`);
      setItems((x) => [...x, ...d.items]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Everything the filters show, one sheet row per change.
  const exportExcel = async () => {
    const d: LogResponse = await get(`/api/mpr-edit-log?${params(0, 'all')}`);
    const XLSX = await import('xlsx');
    const rows = d.items.flatMap((ev) =>
      (ev.changes.length ? ev.changes : [{ field: '', from: '', to: '' }]).map((c) => ({
        Date: localDay(ev.at),
        Time: timeOf(ev.at),
        Result: ev.type === 'attempt' ? 'Tried — not saved' : 'Saved',
        'Job No': ev.job_no || '',
        'MPR No': ev.mpr_no || '',
        'Item Name': ev.item_name || '',
        Project: ev.project_name || '',
        'Job Owner': ev.owner_name || '',
        Change: FIELD_LABELS[c.field] || c.field,
        From: c.from ?? '',
        To: c.to ?? '',
        'Edited By': ev.editor_name || '',
        Reason: ev.reason || ''
      }))
    );
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = new Array(13).fill({ wch: 16 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MPR Edit Log');
    void saveWorkbookCrossPlatform(wb, `MPR_Edit_Log_${new Date().toLocaleDateString('en-CA')}.xlsx`);
  };

  const groups = useMemo(() => {
    const m = new Map<string, LogEvent[]>();
    for (const ev of items) {
      const d = localDay(ev.at);
      m.set(d, [...(m.get(d) || []), ev]);
    }
    return [...m.entries()];
  }, [items]);

  const tabBtn = (k: typeof tab, label: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      aria-pressed={tab === k}
      className={`px-3 py-2.5 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5 whitespace-nowrap ${
        tab === k ? 'text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
      }`}
      style={tab === k ? { borderColor: 'var(--g-accent, #7f00ff)' } : undefined}
    >
      {label}
    </button>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-clip">
      <div className="px-5 sm:px-6 pt-5 pb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <History className="w-5 h-5 text-blue-600" /> MPR Edit Log
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">Changes to submitted MPR rows, refused edits, and Job Edit requests waiting for you.</p>
        </div>
        {tab === 'history' && (
          <button
            type="button"
            onClick={() => void exportExcel()}
            disabled={!items.length}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50"
          >
            <FileDown className="w-3.5 h-3.5" /> Export Excel
          </button>
        )}
      </div>
      <div className="px-3 sm:px-5 flex gap-1 border-b border-slate-200 overflow-x-auto">
        {tabBtn(
          'pending',
          <>
            <Clock3 className="w-3.5 h-3.5" /> Pending approvals
            {pendingCount > 0 && <span className="text-[10px] font-bold px-1.5 rounded-full bg-amber-100 text-amber-700">{pendingCount}</span>}
          </>
        )}
        {tabBtn('history', 'Edit history')}
        {canFollowup && tabBtn('needs', <><AlertTriangle className="w-3.5 h-3.5" /> Needs update</>)}
        {canFollowup && tabBtn('people', <><UsersIcon className="w-3.5 h-3.5" /> People</>)}
      </div>

      {tab === 'pending' && <div>{pendingSection}</div>}

      {tab === 'history' && (
        <>
          {data && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-2.5 px-4 sm:px-6 pt-4">
              {(
                [
                  [data.stats.saves, 'Saves in this period'],
                  [data.stats.today, 'Saves today'],
                  [data.stats.later, 'Delivery dates moved later'],
                  [data.stats.attempts, 'Tried — not saved'],
                  [data.stats.people, 'People']
                ] as [number, string][]
              ).map(([n, label]) => (
                <div key={label} className={`rounded-xl border px-2.5 md:px-3 py-1.5 md:py-2 ${label === 'People' ? 'hidden md:block' : ''} ${label.startsWith('Tried') && n > 0 ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
                  <div className={`text-base md:text-lg font-bold tabular-nums ${label.startsWith('Tried') && n > 0 ? 'text-rose-700' : 'text-slate-900'}`}>{n}</div>
                  <div className="text-[10.5px] md:text-[11px] leading-tight text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          )}
          <div ref={barRef} className="md:sticky md:top-16 z-20 bg-white/95 backdrop-blur-sm mt-3 px-5 sm:px-6 py-3 border-y border-slate-200 flex flex-wrap items-center gap-2">
            <div className="w-full md:w-auto flex md:inline-flex p-0.5 rounded-lg bg-slate-100">
              {RANGES.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRange(k)}
                  className={`flex-1 md:flex-none whitespace-nowrap text-xs font-semibold px-2 md:px-2.5 py-1.5 rounded-md ${range === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="w-[calc(50%-0.25rem)] md:w-44">
              <SearchSelect aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg">
                <option value="">— All projects —</option>
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>{p.project_name}</option>
                ))}
              </SearchSelect>
            </div>
            <select aria-label="Change" value={kind} onChange={(e) => setKind(e.target.value)} className="w-[calc(50%-0.25rem)] md:w-auto px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg">
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <div className="w-[calc(50%-0.25rem)] md:w-44">
              <SearchSelect aria-label="Edited by" value={editor} onChange={(e) => setEditor(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg">
                <option value="">— Anyone —</option>
                {(data?.editors || []).map((u) => (
                  <option key={u.id} value={String(u.id)}>{u.name}</option>
                ))}
              </SearchSelect>
            </div>
            <div className="relative w-[calc(50%-0.25rem)] md:w-auto md:flex-1 md:min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Job No, MPR No, item, person…"
                className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
          </div>
          {error && <p className="mx-6 mt-3 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700">{error}</p>}
          {!data && loading ? (
            <p className="text-xs text-slate-400 text-center py-12">Loading edit log…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-12">No MPR edits in this period{kind || projectId || editor || q ? ' with these filters' : ''}.</p>
          ) : (
            <div className="pb-4">
              {groups.map(([day, evs]) => (
                <div key={day}>
                  <div className="px-5 sm:px-6 pt-4 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 md:sticky z-10 bg-white" style={{ top: 64 + barH }}>
                    {dayHeading(day)} <span className="normal-case tracking-normal font-medium">· {evs.length} {evs.length === 1 ? 'event' : 'events'}</span>
                  </div>
                  <div className="px-3 sm:px-4 space-y-2">
                    {evs.map((ev) => (
                      <EventCard key={ev.id} ev={ev} onOpen={() => setOpenEntry(ev.entry_id)} />
                    ))}
                  </div>
                </div>
              ))}
              {data && items.length < data.total && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loading}
                  className="mx-4 mt-4 w-[calc(100%-2rem)] py-2.5 text-xs font-semibold text-slate-700 border border-dashed border-slate-300 rounded-xl hover:bg-slate-50 disabled:opacity-50"
                >
                  {loading ? 'Loading…' : `Show ${Math.min(50, data.total - items.length)} more · ${data.total} in this period`}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'needs' && canFollowup && <NeedsUpdate token={token} projects={projects} onOpen={setOpenEntry} />}
      {tab === 'people' && canFollowup && <People token={token} />}

      {openEntry != null && <EntryHistory token={token} entryId={openEntry} onClose={() => setOpenEntry(null)} />}
    </div>
  );
};

const EventCard: React.FC<{ ev: LogEvent; onOpen: () => void }> = ({ ev, onOpen }) => {
  const tried = ev.type === 'attempt';
  return (
    <div className={`rounded-xl border px-3.5 py-3 grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[64px_minmax(0,1fr)_auto] gap-x-3 gap-y-1 ${tried ? 'border-rose-200 bg-rose-50/70' : 'border-slate-200 bg-white'}`}>
      <span className="text-xs text-slate-500 tabular-nums pt-0.5 hidden sm:block">{timeOf(ev.at)}</span>
      <div className="min-w-0 col-span-2 sm:col-span-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="font-bold text-blue-700">{ev.job_no || '—'}</span>
          <span className="font-mono px-1.5 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-slate-700">{ev.mpr_no || '—'}</span>
          <span className="text-slate-700">{ev.item_name || ''}</span>
          {ev.project_name && <span className="text-slate-400">· {ev.project_name}</span>}
        </div>
        {tried && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="px-1.5 py-0.5 rounded-md bg-rose-100 text-rose-700 font-bold border border-rose-200">Tried — not saved</span>
          </div>
        )}
        {ev.changes.map((c, i) => {
          const d = deltaOf(c);
          const added = c.field.startsWith('job_edit') || c.field === 'close_short';
          return (
            <div key={i} className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px]">
              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md ${fieldTone(c.field)}`}>{FIELD_LABELS[c.field] || c.field}</span>
              {!added && (
                <>
                  <span className="text-slate-400 line-through break-all">{showValue(c.field, c.from)}</span>
                  <span className="text-slate-400">→</span>
                </>
              )}
              <span className="font-bold text-slate-900 break-all">{showValue(c.field, c.to)}</span>
              {d && <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded-full ${d.tone === 'late' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{d.text}</span>}
            </div>
          );
        })}
        {tried && ev.reason && <div className="mt-1.5 text-xs font-semibold text-rose-700">Why: {ev.reason}</div>}
        <div className="mt-1.5 text-[11.5px] text-slate-500">
          <span className="sm:hidden">{timeOf(ev.at)} · </span>by <b className="text-slate-700">{ev.editor_name || '—'}</b>
          {ev.owner_name && ev.owner_name !== ev.editor_name && <> · Job owner: {ev.owner_name}</>}
        </div>
      </div>
      <button type="button" onClick={onOpen} className="col-span-2 sm:col-span-1 justify-self-start sm:justify-self-end text-xs font-semibold flex items-center gap-0.5 whitespace-nowrap" style={{ color: 'var(--g-accent, #7f00ff)' }}>
        Full history <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

// One MPR row from the start, in a liquid-glass side sheet.
const EntryHistory: React.FC<{ token: string; entryId: number; onClose: () => void }> = ({ token, entryId, onClose }) => {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useBackButtonClose(true, onClose);
  useEffect(() => {
    fetch(apiUrl(`/api/mpr-edit-log/entry/${entryId}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || 'Could not load the history.');
        setD(j);
      })
      .catch((e) => setErr(e.message));
  }, [entryId, token]);
  // Saved changes (same minute = one save) and refused tries, newest first.
  const timeline = useMemo(() => {
    if (!d) return [];
    const saves = new Map<string, { at: string; by: string; changes: Change[] }>();
    for (const c of d.changes) {
      const key = `${c.by}|${String(c.at).slice(0, 16)}`;
      if (!saves.has(key)) saves.set(key, { at: c.at, by: c.by, changes: [] });
      saves.get(key)!.changes.push({ field: c.field, from: c.from, to: c.to });
    }
    return [
      ...[...saves.values()].map((s) => ({ kind: 'save' as const, ...s })),
      ...d.attempts.map((a: any) => ({ kind: 'try' as const, at: a.at, by: a.by, reason: a.reason, fields: a.fields }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [d]);
  return createPortal(
    <div className="fixed inset-0 z-[120] liquid-glass-backdrop flex items-end sm:items-stretch sm:justify-end p-2 sm:p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full sm:w-[440px] max-h-[88dvh] sm:max-h-none flex">
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h4 className="text-base font-bold text-slate-900">Full history{d?.entry?.mpr_no ? ` — ${d.entry.mpr_no}` : ''}</h4>
              {d?.entry && (
                <p className="text-xs text-slate-600 mt-0.5">
                  {[d.entry.job_no, d.entry.item_name, d.entry.project_name].filter(Boolean).join(' · ')}
                  {d.entry.owner_name && ` · owner ${d.entry.owner_name}`}
                </p>
              )}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip p-1.5 rounded-full text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-5 pb-5 overflow-y-auto">
            {err && <p className="text-xs text-rose-700">{err}</p>}
            {!d && !err && <p className="text-xs text-slate-500">Loading…</p>}
            {d && (
              <ol className="relative border-l-2 border-slate-200 ml-1.5 pl-5 space-y-4">
                {timeline.map((t, i) => (
                  <li key={i} className="relative text-[13px]">
                    <span className={`absolute -left-[27px] top-1 w-3 h-3 rounded-full border-2 bg-white ${t.kind === 'try' ? 'border-rose-500' : ''}`} style={t.kind === 'save' ? { borderColor: 'var(--g-accent, #7f00ff)' } : undefined} />
                    {t.kind === 'save' ? (
                      t.changes.map((c, j) => (
                        <div key={j}>
                          <b>{FIELD_LABELS[c.field] || c.field}</b>{' '}
                          {!(c.field.startsWith('job_edit') || c.field === 'close_short') && <span className="text-slate-400 line-through">{showValue(c.field, c.from)}</span>}{' '}
                          → <b>{showValue(c.field, c.to)}</b>
                        </div>
                      ))
                    ) : (
                      <div>
                        <span className="text-rose-700 font-bold">Tried — not saved</span>
                        {t.fields?.delivery_date && <> · Delivery Date → {shortDate(t.fields.delivery_date)}</>}
                        {t.fields?.requisitioned_qty && <> · Qty → {t.fields.requisitioned_qty}</>}
                        {t.reason && <div className="text-xs text-rose-700">Why: {t.reason}</div>}
                      </div>
                    )}
                    <div className="text-[11px] text-slate-500">
                      {new Date(t.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {t.by || '—'}
                    </div>
                  </li>
                ))}
                <li className="relative text-[13px]">
                  <span className="absolute -left-[27px] top-1 w-3 h-3 rounded-full border-2 border-slate-400 bg-white" />
                  <b>Entered</b> · Qty {d.entry.requisitioned_qty ?? '—'} · Delivery {shortDate(d.entry.delivery_date)} (now)
                  <div className="text-[11px] text-slate-500">{d.entry.entry_date ? shortDate(d.entry.entry_date) : ''}{d.entry.owner_name ? ` · ${d.entry.owner_name}` : ''}</div>
                </li>
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

const NeedsUpdate: React.FC<{ token: string; projects: { id: number; project_name: string }[]; onOpen: (id: number) => void }> = ({ token, projects, onOpen }) => {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [projectId, setProjectId] = useState('');
  const [owner, setOwner] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    setRows(null);
    const p = new URLSearchParams({ ...(projectId ? { project_id: projectId } : {}), ...(owner ? { owner } : {}) });
    fetch(apiUrl(`/api/mpr-edit-log/needs-update?${p}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || 'Could not load.');
        setRows(j);
      })
      .catch((e) => setErr(e.message));
  }, [token, projectId, owner]);
  const owners = useMemo(() => [...new Map((rows || []).map((r) => [r.owner_id, r.owner_name])).entries()].filter(([id]) => id), [rows]);
  const shown = all ? rows || [] : (rows || []).slice(0, 100);
  const lastEdit = (r: any) =>
    r.last_try_at && (!r.last_edit_at || r.last_try_at > r.last_edit_at) ? (
      <span className="text-rose-700 font-semibold">{shortDate(r.last_try_at.slice(0, 10))} — tried, not saved</span>
    ) : r.last_edit_at ? (
      shortDate(r.last_edit_at.slice(0, 10))
    ) : (
      <span className="text-rose-700 font-semibold">Never edited</span>
    );
  return (
    <div>
      <div className="px-5 sm:px-6 py-3 border-b border-slate-200 flex flex-wrap items-center gap-2">
        <p className="text-xs text-slate-500 flex-1 min-w-[220px]">Delivery Date has passed and the material hasn't fully arrived (Material Dispatch's received Qty). Oldest first.</p>
        <div className="w-44">
          <SearchSelect aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg">
            <option value="">— All projects —</option>
            {projects.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.project_name}</option>
            ))}
          </SearchSelect>
        </div>
        <div className="w-44">
          <SearchSelect aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg">
            <option value="">— Every owner —</option>
            {owners.map(([id, name]) => (
              <option key={id} value={String(id)}>{name}</option>
            ))}
          </SearchSelect>
        </div>
      </div>
      {err && <p className="m-4 text-xs text-rose-700">{err}</p>}
      {!rows && !err ? (
        <p className="text-xs text-slate-400 text-center py-12">Loading…</p>
      ) : rows && rows.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-12">Nothing overdue — every passed Delivery Date has its material in.</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5 text-left">MPR</th>
                  <th className="px-4 py-2.5 text-left">Item · Project</th>
                  <th className="px-4 py-2.5 text-left">Owner</th>
                  <th className="px-4 py-2.5 text-left">Delivery Date</th>
                  <th className="px-4 py-2.5 text-left">Overdue</th>
                  <th className="px-4 py-2.5 text-left">Received</th>
                  <th className="px-4 py-2.5 text-left">Last edit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer hover:bg-slate-50">
                    <td className="px-4 py-2.5"><b className="text-blue-700">{r.job_no}</b><div className="font-mono text-xs text-slate-600">{r.mpr_no}</div></td>
                    <td className="px-4 py-2.5">{r.item_name}<div className="text-[11px] text-slate-500">{r.project_name}</div></td>
                    <td className="px-4 py-2.5">{r.owner_name || '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums">{shortDate(r.delivery_date)}</td>
                    <td className="px-4 py-2.5 tabular-nums font-bold text-rose-700">{r.overdue_days} day{r.overdue_days === 1 ? '' : 's'}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.received} / {r.qty}{r.closed_short > 0 && <div className="text-[11px] text-pink-700">{r.closed_short} set aside</div>}</td>
                    <td className="px-4 py-2.5 text-xs">{lastEdit(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="md:hidden divide-y divide-slate-100">
            {shown.map((r) => (
              <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="w-full text-left px-4 py-3 text-[13px]">
                <div className="flex justify-between gap-2"><b className="text-blue-700">{r.job_no} · <span className="font-mono">{r.mpr_no}</span></b><span className="font-bold text-rose-700 whitespace-nowrap">{r.overdue_days}d overdue</span></div>
                <div>{r.item_name} <span className="text-slate-500">· {r.project_name}</span></div>
                <div className="text-xs text-slate-500">{r.owner_name} · due {shortDate(r.delivery_date)} · {r.received}/{r.qty} in · last edit: {lastEdit(r)}</div>
              </button>
            ))}
          </div>
          {!all && rows && rows.length > 100 && (
            <button type="button" onClick={() => setAll(true)} className="m-4 w-[calc(100%-2rem)] py-2.5 text-xs font-semibold border border-dashed border-slate-300 rounded-xl">
              Show all {rows.length}
            </button>
          )}
        </>
      )}
    </div>
  );
};

const People: React.FC<{ token: string }> = ({ token }) => {
  const [days, setDays] = useState<'7' | '30' | 'month'>('30');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setD(null);
    fetch(apiUrl(`/api/mpr-edit-log/people?days=${days}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || 'Could not load.');
        setD(j);
      })
      .catch((e) => setErr(e.message));
  }, [token, days]);
  const lastEdit = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : <span className="text-rose-700 font-semibold">No edit yet</span>);
  return (
    <div>
      <div className="px-5 sm:px-6 py-3 border-b border-slate-200 flex flex-wrap items-center gap-2">
        <p className="text-xs text-slate-500 flex-1 min-w-[220px]">
          Per person who owns MPR rows. "Updated in time" = the material came by its date, or the Delivery Date was changed on or before the old date.
        </p>
        <div className="inline-flex p-0.5 rounded-lg bg-slate-100">
          {(
            [
              ['7', '7 days'],
              ['30', '30 days'],
              ['month', 'This month']
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setDays(k)} className={`text-xs font-semibold px-2.5 py-1.5 rounded-md ${days === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {err && <p className="m-4 text-xs text-rose-700">{err}</p>}
      {!d && !err ? (
        <p className="text-xs text-slate-400 text-center py-12">Loading…</p>
      ) : d && d.people.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-12">No MPR owners with due dates or edits in this period.</p>
      ) : (
        d && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[760px]">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5 text-left">Person</th>
                  <th className="px-4 py-2.5 text-left">Overdue now</th>
                  <th className="px-4 py-2.5 text-left">Due dates passed</th>
                  <th className="px-4 py-2.5 text-left">Updated in time</th>
                  <th className="px-4 py-2.5 text-left">Edits saved</th>
                  <th className="px-4 py-2.5 text-left">Tried, not saved</th>
                  <th className="px-4 py-2.5 text-left">Last edit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.people.map((p: any) => {
                  const pct = p.due ? Math.round((p.in_time / p.due) * 100) : null;
                  return (
                    <tr key={p.user_id}>
                      <td className="px-4 py-2.5"><b>{p.name}</b>{p.projects && <div className="text-[11px] text-slate-500 truncate max-w-[220px]">{p.projects}</div>}</td>
                      <td className={`px-4 py-2.5 tabular-nums font-bold ${p.overdue ? 'text-rose-700' : 'text-emerald-700'}`}>{p.overdue}</td>
                      <td className="px-4 py-2.5 tabular-nums">{p.due}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {p.in_time}
                        {pct !== null && (
                          <div className="mt-1 h-1.5 w-24 rounded-full bg-slate-100 overflow-hidden">
                            <div className={`h-full ${pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-rose-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{p.saves}</td>
                      <td className={`px-4 py-2.5 tabular-nums ${p.tries ? 'font-bold text-rose-700' : ''}`}>{p.tries}</td>
                      <td className="px-4 py-2.5 text-xs">{lastEdit(p.last_edit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
};
