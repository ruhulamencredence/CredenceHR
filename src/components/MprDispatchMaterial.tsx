/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Management -> Reports -> "Dispatch Material" (Reports
// layer "dispatch_material", MprDispatchRoutes.ts): Purchase sends material
// against the projects' MPR rows, soonest delivery date first. Only the rows
// Purchase sent here from the MPR Entries report (filter, tick, "Send to
// Dispatch") are listed; one with nothing sent yet can be taken out again.
// With the "dispatch_material" layer alone an account sees only its own rows
// (sent here or dispatched by it); "dispatch_all" shows everyone's.
//   - Dispatch on screen: tick rows, set the Qty (all that's left, or part of
//     it), supplier, rate, P.O., challan.
//   - Or by Excel: "Download sheet" gives the Daily Site Requirement and
//     Delivery Status sheet for the rows shown; fill Suppliers Name / Rate /
//     P.O.-Number (and Dispatch Qty when sending part), "Upload sheet", check,
//     dispatch.
// A row leaves the Open list when the project has received all of it.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Truck, Download, Upload, Search, RefreshCw, History, Loader2, AlertTriangle, CheckSquare, Square, ListMinus } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { confirmDialog } from '../lib/confirmDialog';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { ProgressOverlay, useLongTask } from './ProgressOverlay';
import { MD_STATUS, MdDispatch, MdRow, MdStatus, MdStatusChip, MdTimelinePopup, isOverdue, mdFetch, qtyText, todayDhaka } from './MprDispatchShared';

type View = 'open' | 'received' | 'all';
interface Line {
  entryId: number;
  qty: string;
  supplier: string;
  rate: string;
  poNo: string;
  challanNo: string;
  vehicleNo: string;
  dispatchDate: string;
  note: string;
}
const ddmmyy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(2, 4)}` : '');
const SHEET_HEAD = ['SL', 'M-Date', 'Project Name', 'Items', 'Specification', 'Qty', 'Unit', 'MRF', 'Suppliers Name', 'Rate', 'Delivery Date', 'P.O-Number', 'Dispatch Qty', 'Dispatch Date', 'Challan No', 'Vehicle No', 'Row ID'];
const norm = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// The dispatch form: one line per MPR row (Qty / supplier / rate / P.O.), and
// what the lines share (date, P.O., challan, vehicle, note) — a line's own
// value wins over the shared one. Used for both the
// on-screen dispatch and an uploaded sheet.
// ---------------------------------------------------------------------------
const DispatchPopup: React.FC<{
  token: string;
  rows: MdRow[];
  start: Line[];
  fromExcel?: boolean;
  skipped?: string[];
  onClose: () => void;
  onDone: (n: number) => void;
}> = ({ token, rows, start, fromExcel, skipped = [], onClose, onDone }) => {
  const [lines, setLines] = useState<Line[]>(start);
  const [shared, setShared] = useState({ dispatchDate: todayDhaka(), poNo: '', challanNo: '', vehicleNo: '', note: '', supplier: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const total = lines.length;
  const send = async () => {
    setBusy(true);
    setError('');
    setLineErrors({});
    try {
      const items = lines.map((l) => ({
        entryId: l.entryId,
        qty: l.qty,
        supplier: l.supplier || shared.supplier,
        rate: l.rate,
        poNo: l.poNo || shared.poNo,
        challanNo: l.challanNo || shared.challanNo,
        vehicleNo: l.vehicleNo || shared.vehicleNo,
        dispatchDate: l.dispatchDate || shared.dispatchDate,
        note: l.note || shared.note
      }));
      const r = await mdFetch<{ dispatched: number }>(token, '/api/mpr-dispatch/dispatch', 'POST', { items, source: fromExcel ? 'excel' : 'screen' });
      onDone(r.dispatched);
    } catch (e: any) {
      setError(e.message);
      const errs: { index: number; error: string }[] = e.data?.errors || [];
      setLineErrors(Object.fromEntries(errs.map((x) => [x.index, x.error])));
    } finally {
      setBusy(false);
    }
  };
  const cell = 'px-1.5 py-1 text-xs bg-white/80 border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-200 focus:outline-none w-full';
  return (
    <Popup
      title={fromExcel ? `Dispatch from the sheet — ${total} line${total === 1 ? '' : 's'}` : `Dispatch ${total} MPR row${total === 1 ? '' : 's'}`}
      icon={<Truck className="w-4 h-4" />}
      onClose={busy ? () => {} : onClose}
      size="xl"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void send()} disabled={busy || !total}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Dispatch {total} line{total === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <div>
            <label className={labelCls}>Dispatch date</label>
            <input type="date" className={inputCls} value={shared.dispatchDate} max={todayDhaka()} onChange={(e) => setShared({ ...shared, dispatchDate: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>P.O-Number (all lines)</label>
            <input className={inputCls} value={shared.poNo} onChange={(e) => setShared({ ...shared, poNo: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Challan No</label>
            <input className={inputCls} value={shared.challanNo} onChange={(e) => setShared({ ...shared, challanNo: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Vehicle No</label>
            <input className={inputCls} value={shared.vehicleNo} onChange={(e) => setShared({ ...shared, vehicleNo: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Supplier (for lines left blank)</label>
            <input className={inputCls} value={shared.supplier} onChange={(e) => setShared({ ...shared, supplier: e.target.value })} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Note (optional)</label>
          <input className={inputCls} value={shared.note} onChange={(e) => setShared({ ...shared, note: e.target.value })} />
        </div>
        {fromExcel && skipped.length > 0 && (
          <div className="text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800">
            Left out of the sheet ({skipped.length}): {skipped.slice(0, 6).join('; ')}
            {skipped.length > 6 ? '…' : ''}
          </div>
        )}
        <div className="liquid-glass-inset rounded-[20px] overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-2 py-2">Project · MRF · Item</th>
                <th className="px-2 py-2 text-right">Left</th>
                <th className="px-2 py-2 w-24">Qty sent</th>
                <th className="px-2 py-2 w-40">Supplier</th>
                <th className="px-2 py-2 w-20">Rate</th>
                <th className="px-2 py-2 w-36">P.O-Number</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60">
              {lines.map((l, i) => {
                const r = byId.get(l.entryId);
                const partial = r && r.remaining !== null && Number(l.qty) > 0 && Number(l.qty) < r.remaining;
                return (
                  <tr key={`${l.entryId}-${i}`} className="align-top">
                    <td className="px-2 py-1.5">
                      <div className="font-semibold text-slate-800">{r?.projectName || `Row ${l.entryId}`}</div>
                      <div className="text-slate-500">{r ? `${r.mprNo} · ${r.item}${r.specification ? ` (${r.specification})` : ''}` : ''}</div>
                      {lineErrors[i] && <div className="text-rose-600 font-medium">{lineErrors[i]}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap text-slate-600">{r ? qtyText(r.remaining, r.unit) : '—'}</td>
                    <td className="px-2 py-1.5">
                      <input className={cell} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Qty sent" />
                      {partial && <div className="text-[10px] text-amber-700 mt-0.5">Part — the rest stays to send</div>}
                    </td>
                    <td className="px-2 py-1.5"><input className={cell} value={l.supplier} placeholder={shared.supplier} onChange={(e) => set(i, { supplier: e.target.value })} aria-label="Supplier" /></td>
                    <td className="px-2 py-1.5"><input className={cell} inputMode="decimal" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} aria-label="Rate" /></td>
                    <td className="px-2 py-1.5"><input className={cell} value={l.poNo} placeholder={shared.poNo} onChange={(e) => set(i, { poNo: e.target.value })} aria-label="P.O-Number" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">
          The project's receivers get an alert. A line can send part of what's left — the rest stays open to send later. Nothing is dispatched unless every line is right.
        </p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
export const MprDispatchMaterial: React.FC<{ token: string }> = ({ token }) => {
  const [view, setView] = useState<View>('open');
  const [rows, setRows] = useState<MdRow[] | null>(null);
  // Everyone's rows (layer "dispatch_all") or just this account's own.
  const [seesAll, setSeesAll] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [statuses, setStatuses] = useState<Set<MdStatus>>(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [dispatching, setDispatching] = useState<{ lines: Line[]; rows?: MdRow[]; fromExcel?: boolean; skipped?: string[] } | null>(null);
  const [cancelling, setCancelling] = useState<{ d: MdDispatch; reload: () => void } | null>(null);
  const [timeline, setTimeline] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const longTask = useLongTask();
  const today = todayDhaka();

  const load = () => {
    setError('');
    return mdFetch<{ all: boolean; rows: MdRow[] }>(token, `/api/mpr-dispatch/rows?view=${view}`)
      .then((r) => {
        setRows(r.rows);
        setSeesAll(r.all);
        setPicked(new Set());
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    setRows(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view]);

  const projects = useMemo(() => [...new Set((rows || []).map((r) => r.projectName))].sort(), [rows]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter((r) => {
      if (project && r.projectName !== project) return false;
      if (statuses.size && !statuses.has(r.status)) return false;
      if (from && (!r.deliveryDate || r.deliveryDate < from)) return false;
      if (to && (!r.deliveryDate || r.deliveryDate > to)) return false;
      const hay = `${r.projectName} ${r.mprNo} ${r.item} ${r.specification} ${r.jobNo} ${r.budgetName} ${r.queuedBy} ${r.dispatches.map((d) => `${d.supplier} ${d.poNo} ${d.challanNo}`).join(' ')} ${(r.pos || []).map((p) => `${p.poNo} ${p.supplier}`).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, q, project, statuses, from, to]);
  // Rows that can still be sent.
  const sendable = (r: MdRow) => r.status !== 'received' && (r.remaining === null || r.remaining > 0);
  // Nothing sent on it yet (cancelled ones don't count): can go back out of the list.
  const removable = (r: MdRow) => !r.dispatches.some((d) => d.status !== 'cancelled');
  const takeOut = async (list: MdRow[]) => {
    if (!list.length) return;
    if (!(await confirmDialog(`Send ${list.length} MPR row${list.length === 1 ? '' : 's'} back to the MPR Entries report? ${list.length === 1 ? 'It leaves' : 'They leave'} Dispatch Material and can be sent here again later.`, { confirmLabel: 'Send back' }))) return;
    try {
      const r = await mdFetch<{ removed: number; kept: number; notYours: number }>(token, '/api/mpr-dispatch/unqueue', 'POST', { entryIds: list.map((x) => x.id) });
      setNotice(
        `${r.removed} row${r.removed === 1 ? '' : 's'} sent back to the MPR Entries report.${r.kept ? ` ${r.kept} kept — material was already sent on ${r.kept === 1 ? 'it' : 'them'}.` : ''}${
          r.notYours ? ` ${r.notYours} kept — someone else sent ${r.notYours === 1 ? 'it' : 'them'} here.` : ''
        }`
      );
      void load();
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  const pickedRows = shown.filter((r) => picked.has(r.id));
  const allPicked = shown.filter(sendable).length > 0 && shown.filter(sendable).every((r) => picked.has(r.id));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows || []) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  // The latest imported P.O (Reports -> P.O Import) fills supplier, rate and P.O.
  const lastPo = (r: MdRow) => (r.pos && r.pos.length ? r.pos[r.pos.length - 1] : null);
  const lineFor = (r: MdRow): Line => ({
    entryId: r.id,
    qty: r.remaining !== null ? String(r.remaining) : '',
    supplier: lastPo(r)?.supplier || '',
    rate: lastPo(r)?.rate != null ? String(lastPo(r)!.rate) : '',
    poNo: lastPo(r)?.poNo || '',
    challanNo: '',
    vehicleNo: '',
    dispatchDate: '',
    note: ''
  });

  // The Daily Site Requirement and Delivery Status sheet for the rows shown
  // (or the ticked ones), with what's left to send in Qty.
  const downloadSheet = () => {
    const list = (pickedRows.length ? pickedRows : shown).filter(sendable);
    if (!list.length) {
      setNotice('Nothing left to send in the rows shown.');
      return;
    }
    const aoa: any[][] = [
      ['Credence Housing Limited.'],
      [`(Daily Site Requirement and Delivery Status) Date: ${ddmmyy(today)}`],
      SHEET_HEAD,
      ...list.map((r, i) => [
        i + 1,
        ddmmyy(r.entryDate),
        r.projectName,
        r.item,
        r.specification || 'N/A',
        r.remaining ?? '',
        r.unit,
        r.mprNo,
        '',
        '',
        ddmmyy(r.deliveryDate),
        '',
        '',
        '',
        '',
        '',
        r.id
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: SHEET_HEAD.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: SHEET_HEAD.length - 1 } }
    ];
    ws['!cols'] = [5, 10, 18, 24, 22, 9, 7, 12, 26, 9, 12, 20, 12, 12, 12, 12, 8].map((wch) => ({ wch }));
    const info = XLSX.utils.aoa_to_sheet([
      ['How to fill this sheet'],
      ['Fill Suppliers Name, Rate and P.O-Number for every line you are sending. Leave a line blank to leave it out.'],
      ['Dispatch Qty: leave blank to send the whole Qty; write a smaller number to send part of it (the rest stays open).'],
      ['Dispatch Date: leave blank for today (DD-MM-YY). Challan No / Vehicle No are optional.'],
      ["Don't change Row ID — it is how each line finds its MPR row. Then Dispatch Material -> Upload sheet."]
    ]);
    info['!cols'] = [{ wch: 110 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Delivery Status');
    XLSX.utils.book_append_sheet(wb, info, 'How to fill');
    XLSX.writeFile(wb, `Daily_Site_Requirement_${today}.xlsx`);
  };

  // Reads a filled sheet back: lines with a supplier, P.O. or Dispatch Qty are sent.
  const readSheet = async (file: File) => {
    setNotice('');
    longTask.start('Reading the delivery sheet', `Reading ${file.name}…`);
    longTask.creep(90, undefined, 1500);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const headAt = grid.findIndex((row) => row.some((c) => norm(c) === 'rowid'));
      if (headAt < 0) throw new Error('No "Row ID" column — download the sheet from this page, fill it and upload that one.');
      const col = (name: string) => grid[headAt].findIndex((c) => norm(c) === norm(name));
      const c = { id: col('Row ID'), qty: col('Qty'), sup: col('Suppliers Name'), rate: col('Rate'), po: col('P.O-Number'), dq: col('Dispatch Qty'), dd: col('Dispatch Date'), ch: col('Challan No'), vh: col('Vehicle No') };
      const at = (row: any[], i: number) => (i < 0 ? '' : row[i]);
      const text = (v: any) => (v instanceof Date ? '' : String(v ?? '').trim());
      const dateText = (v: any) =>
        v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v ?? '').trim();
      const fresh = (await mdFetch<{ rows: MdRow[] }>(token, '/api/mpr-dispatch/rows?view=open')).rows;
      const byId = new Map(fresh.map((r) => [r.id, r]));
      const lines: Line[] = [];
      const skipped: string[] = [];
      for (const row of grid.slice(headAt + 1)) {
        const id = Number(at(row, c.id));
        if (!id) continue;
        const sup = text(at(row, c.sup)), po = text(at(row, c.po)), dq = text(at(row, c.dq));
        if (!sup && !po && !dq) continue; // not being sent this time
        const r = byId.get(id);
        if (!r) {
          skipped.push(`Row ID ${id}: already fully received, not found, or not in your list`);
          continue;
        }
        lines.push({
          entryId: id,
          qty: dq || (r.remaining !== null ? String(r.remaining) : text(at(row, c.qty))),
          supplier: sup,
          rate: text(at(row, c.rate)),
          poNo: po,
          challanNo: text(at(row, c.ch)),
          vehicleNo: text(at(row, c.vh)),
          dispatchDate: dateText(at(row, c.dd)),
          note: ''
        });
      }
      await longTask.finish();
      if (!lines.length) {
        setNotice(skipped.length ? `Nothing to send — ${skipped.join('; ')}` : 'No line in the sheet has a supplier, P.O-Number or Dispatch Qty yet.');
        return;
      }
      setDispatching({ lines, rows: fresh, fromExcel: true, skipped });
    } catch (e: any) {
      longTask.close();
      setNotice(e.message || "Couldn't read that sheet.");
    }
  };


  const toggleStatus = (s: MdStatus) =>
    setStatuses((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  return (
    <div className="space-y-4">
      <ProgressOverlay state={longTask.state} />
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readSheet(f); }} />
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2"><Truck className="w-5 h-5 text-blue-600" /> Dispatch Material</h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
              {seesAll ? "Everyone's MPR rows sent here from the MPR Entries report" : 'The MPR rows you sent here from the MPR Entries report, or dispatched yourself'} (filter there, tick, "Send to Dispatch"), soonest delivery date first. Send all that's left or part of it — on
              screen, or fill the Daily Site Requirement sheet and upload it. A row leaves the Open list once the project has received all of it.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={downloadSheet} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
              <Download className="w-4 h-4" /> Download sheet{pickedRows.length ? ` (${pickedRows.length})` : ''}
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
              <Upload className="w-4 h-4" /> Upload sheet
            </button>
            <button
              type="button"
              disabled={!pickedRows.length}
              onClick={() => setDispatching({ lines: pickedRows.filter(sendable).map(lineFor) })}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Truck className="w-4 h-4" /> Dispatch{pickedRows.length ? ` ${pickedRows.length}` : ''}
            </button>
            <button
              type="button"
              disabled={!pickedRows.some(removable)}
              onClick={() => void takeOut(pickedRows.filter(removable))}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title="Tick rows, then send them back to the MPR Entries report (only rows with nothing sent yet)"
            >
              <ListMinus className="w-4 h-4" /> Back to MPR Entries{pickedRows.some(removable) ? ` (${pickedRows.filter(removable).length})` : ''}
            </button>
            <button type="button" onClick={() => void load()} className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50" aria-label="Refresh" title="Refresh">
              <RefreshCw className="w-4 h-4 text-slate-600" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {([['open', 'Open'], ['received', 'Received (complete)'], ['all', 'All']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setView(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${view === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
          {(Object.keys(MD_STATUS) as MdStatus[])
            .filter((s) => (view === 'received' ? s === 'received' : view === 'open' ? s !== 'received' : true))
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${statuses.has(s) ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                title={statuses.has(s) ? 'Showing only the ticked statuses — click to hide this one again' : 'Show only this status (with any other ticked ones)'}
              >
                {s === 'pending' ? 'In dispatch list' : MD_STATUS[s].label} {counts[s] ? `(${counts[s]})` : ''}
              </button>
            ))}
          {statuses.size > 0 && (
            <button type="button" onClick={() => setStatuses(new Set())} className="text-[11px] text-slate-500 underline">Show every status</button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="MRF, item, supplier, P.O…" className="w-full text-sm pl-9 pr-3 py-2 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-200" />
          </div>
          <select value={project} onChange={(e) => setProject(e.target.value)} className="text-sm px-3 py-2 rounded-xl bg-white border border-slate-200">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-slate-600">Delivery from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="flex-1 text-sm px-2 py-1.5 rounded-xl bg-white border border-slate-200" /></label>
          <label className="flex items-center gap-2 text-xs text-slate-600">to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="flex-1 text-sm px-2 py-1.5 rounded-xl bg-white border border-slate-200" /></label>
        </div>
        {notice && <div className="text-xs px-3 py-2 rounded-xl bg-amber-50 text-amber-800 flex items-start justify-between gap-2"><span>{notice}</span><button type="button" className="underline shrink-0" onClick={() => setNotice('')}>Dismiss</button></div>}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>

      {!rows && !error ? (
        <LoadingBlock />
      ) : rows && !shown.length ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500 shadow-sm">
          {rows.length
            ? 'No MPR row matches these filters.'
            : view === 'open'
              ? 'Nothing to dispatch. In Reports -> MPR Entries Report, filter and tick the rows to send, then "Send to Dispatch".'
              : 'No MPR rows here.'}
        </div>
      ) : (
        rows && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100">
              {shown.length} row{shown.length === 1 ? '' : 's'}
              {pickedRows.length ? ` · ${pickedRows.length} ticked` : ''}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <button
                        type="button"
                        onClick={() => setPicked(allPicked ? new Set() : new Set(shown.filter(sendable).map((r) => r.id)))}
                        aria-label={allPicked ? 'Untick all' : 'Tick all'}
                        className="text-slate-500"
                      >
                        {allPicked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="px-2 py-2">SL</th>
                    <th className="px-2 py-2">M-Date</th>
                    <th className="px-2 py-2">Project</th>
                    <th className="px-2 py-2">Item · Specification</th>
                    <th className="px-2 py-2">MRF</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2">Delivery</th>
                    <th className="px-2 py-2 text-right">Sent</th>
                    <th className="px-2 py-2 text-right">Received</th>
                    <th className="px-2 py-2 text-right">Left</th>
                    <th className="px-2 py-2">Supplier · P.O.</th>
                    {seesAll && <th className="px-2 py-2">Sent here by</th>}
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((r, i) => {
                    const late = isOverdue(r, today);
                    const lastD = [...r.dispatches].reverse().find((d) => d.status !== 'cancelled');
                    return (
                      <tr key={r.id} className={`align-top ${picked.has(r.id) ? 'bg-sky-50/60' : ''}`}>
                        <td className="px-2 py-2">
                          {sendable(r) && (
                            <input
                              type="checkbox"
                              checked={picked.has(r.id)}
                              onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                              aria-label={`Tick ${r.mprNo} ${r.item}`}
                            />
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{r.entryDate ? formatDate(r.entryDate) : '—'}</td>
                        <td className="px-2 py-2 font-medium text-slate-800">{r.projectName}</td>
                        <td className="px-2 py-2">
                          <div className="text-slate-800">{r.item}</div>
                          {r.specification && <div className="text-slate-500">{r.specification}</div>}
                        </td>
                        <td className="px-2 py-2">{r.mprNo}</td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">{qtyText(r.qty, r.unit)}</td>
                        <td className={`px-2 py-2 whitespace-nowrap ${late ? 'text-rose-600 font-semibold' : ''}`}>
                          {r.deliveryDate ? formatDate(r.deliveryDate) : '—'}
                          {late && <div className="text-[10px] flex items-center gap-0.5"><AlertTriangle className="w-3 h-3" /> Overdue</div>}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">{qtyText(r.dispatchedQty)}</td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">{qtyText(r.receivedQty)}</td>
                        <td className="px-2 py-2 text-right whitespace-nowrap font-semibold">{qtyText(r.remaining)}</td>
                        <td className="px-2 py-2 text-slate-600">
                          {lastD ? [lastD.supplier, lastD.poNo].filter(Boolean).join(' · ') || '—' : !r.pos?.length ? '—' : null}
                          {(r.pos || []).map((p) => (
                            <div key={p.poNo} className="mt-0.5 whitespace-nowrap" title={`Imported P.O${p.poDate ? ` · ${formatDate(p.poDate)}` : ''}${p.orderQty != null ? ` · Qty ${p.orderQty}` : ''}${p.rate != null ? ` · Rate ${p.rate}` : ''}`}>
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">P.O {p.poNo}</span>
                              {p.supplier && <span className="ml-1 text-[11px] text-slate-500">{p.supplier}</span>}
                            </div>
                          ))}
                        </td>
                        {seesAll && <td className="px-2 py-2 text-slate-600">{r.queuedBy || '—'}</td>}
                        <td className="px-2 py-2">
                          <MdStatusChip status={r.status} queued={r.queuedAt} />
                          {r.confirmedAt && r.status === 'pending' && (
                            <div className="mt-0.5 text-[10px] font-semibold text-teal-700" title={`Confirmed by ${r.confirmedBy || 'the project'}`}>✓ Project confirmed</div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1.5">
                            {sendable(r) && (
                              <button type="button" onClick={() => setDispatching({ lines: [lineFor(r)] })} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-blue-600 text-white hover:bg-blue-700">
                                <Truck className="w-3.5 h-3.5" /> Dispatch
                              </button>
                            )}
                            {removable(r) && (
                              <button
                                type="button"
                                onClick={() => void takeOut([r])}
                                className="p-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                                aria-label="Back to MPR Entries"
                                title="Back to the MPR Entries report"
                              >
                                <ListMinus className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button type="button" onClick={() => setTimeline(r.id)} className="p-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="History" title="History">
                              <History className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {dispatching && (dispatching.rows || rows) && (
        <DispatchPopup
          token={token}
          rows={dispatching.rows || rows || []}
          start={dispatching.lines}
          fromExcel={dispatching.fromExcel}
          skipped={dispatching.skipped}
          onClose={() => setDispatching(null)}
          onDone={(n) => {
            setDispatching(null);
            setNotice(`Dispatched ${n} line${n === 1 ? '' : 's'} — the projects have been told.`);
            void load();
          }}
        />
      )}
      {timeline !== null && (
        <MdTimelinePopup
          token={token}
          entryId={timeline}
          onClose={() => setTimeline(null)}
          dispatchAction={(d, reload) =>
            d.status === 'sent' ? (
              <button type="button" onClick={() => setCancelling({ d, reload })} className="text-[11px] font-semibold text-rose-600 hover:underline shrink-0">
                Cancel
              </button>
            ) : null
          }
        />
      )}
      {cancelling && (
        <CancelPopup
          token={token}
          d={cancelling.d}
          onClose={() => setCancelling(null)}
          onDone={() => {
            cancelling.reload();
            setCancelling(null);
            void load();
          }}
        />
      )}
    </div>
  );
};

// A dispatch sent by mistake (not received yet): cancelled with a reason; its
// Qty goes back to "left to send".
const CancelPopup: React.FC<{ token: string; d: MdDispatch; onClose: () => void; onDone: () => void }> = ({ token, d, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!(await confirmDialog(`Cancel the dispatch of ${d.qty} sent on ${d.dispatchDate ? formatDate(d.dispatchDate) : '—'}? The Qty goes back to "left to send".`, { confirmLabel: 'Cancel dispatch' }))) return;
    setBusy(true);
    setError('');
    try {
      await mdFetch(token, `/api/mpr-dispatch/dispatches/${d.id}/cancel`, 'POST', { reason });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Cancel this dispatch"
      icon={<Truck className="w-4 h-4" />}
      onClose={busy ? () => {} : onClose}
      size="md"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Keep it</button>
          <button type="button" className={`${primaryBtn} !bg-rose-600`} onClick={() => void go()} disabled={busy || !reason.trim()}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Cancel dispatch
          </button>
        </>
      }
    >
      <div className="space-y-2 text-left">
        <p className="text-sm text-slate-700">
          {d.qty} sent on {d.dispatchDate ? formatDate(d.dispatchDate) : '—'}
          {d.supplier ? ` by ${d.supplier}` : ''}. Only a dispatch the project hasn't received yet can be cancelled.
        </p>
        <label className={labelCls}>Why?</label>
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong truck, entered twice" autoFocus />
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
