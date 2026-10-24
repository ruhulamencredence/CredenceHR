/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> PEPM Operation -> Material Receive (users.can_receive_material,
// MprDispatchRoutes.ts).
//   My MPR in Dispatch  the rows this account entered itself (its Job
//                       entries) that Purchase took into Dispatch Material —
//                       where each stands. With users.can_return_dispatch,
//                       while nothing has been sent on a row, it can be
//                       taken back out of Dispatch Material (with a new
//                       Delivery Date) or confirmed as needed. Purchase is
//                       told either way.
//   On the way          material Purchase sent to this account's projects
//                       (user_project_permissions): confirm each dispatch when
//                       it arrives — all of it, or less with a reason.
//                       Items under one P.O. / challan can be received
//                       together (one truck: its details once, a Qty each).
// When an MPR row's whole Qty has arrived, its cycle is complete.

import React, { useEffect, useState } from 'react';
import { PackageCheck, Truck, History, Loader2, RefreshCw, AlertTriangle, Undo2, BadgeCheck } from 'lucide-react';
import { confirmDialog } from '../lib/confirmDialog';
import { formatDate } from '../lib/formatDate';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { MdDispatch, MdRow, MdStatusChip, MdTimelinePopup, PO_STATUSES, isOverdue, mdFetch, qtyText, receiptText, todayDhaka } from './MprDispatchShared';

// 16px text on phones so iOS doesn't zoom in when a field is tapped.
const fieldCls = inputCls.replace('text-sm', 'text-base sm:text-sm');
// Truck No: numbers, with single dashes between them (11-2345).
const truckDigits = (v: string) => v.replace(/[^0-9-]/g, '').replace(/-+/g, '-').replace(/^-/, '');
const nowTimeDhaka = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false });

// What the site fills in once per delivery (one truck / challan).
interface Delivery {
  date: string;
  time: string;
  supplier: string;
  truckNo: string;
  poStatus: string;
  receivedBy: string;
}
const newDelivery = (supplier: string, vehicleNo: string): Delivery => ({
  date: todayDhaka(),
  time: nowTimeDhaka(),
  supplier,
  truckNo: truckDigits(vehicleNo).replace(/-$/, ''),
  poStatus: '',
  receivedBy: ''
});
const deliveryReady = (v: Delivery) => !!v.date && !!v.time && !!v.supplier.trim() && !!v.truckNo && !!v.poStatus && !!v.receivedBy.trim();
const deliveryBody = (v: Delivery) => ({
  receivedDate: v.date,
  receivedTime: v.time,
  supplier: v.supplier,
  truckNo: v.truckNo.replace(/-$/, ''),
  poStatus: v.poStatus,
  receivedBy: v.receivedBy
});

// Receiving Date / Time, Supplier (only when Purchase gave none), Truck No,
// PO Status and Received By. `extra` goes beside Truck No (the single form's Qty).
const DeliveryFields: React.FC<{ v: Delivery; set: (v: Delivery) => void; askSupplier: boolean; minDate?: string | null; extra?: React.ReactNode }> = ({ v, set, askSupplier, minDate, extra }) => {
  const put = (k: keyof Delivery) => (val: string) => set({ ...v, [k]: val });
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className={labelCls}>Receiving Date</label>
        <input type="date" className={fieldCls} value={v.date} max={todayDhaka()} min={minDate || undefined} onChange={(e) => put('date')(e.target.value)} />
      </div>
      <div>
        <label className={labelCls}>Receiving Time</label>
        <input type="time" className={fieldCls} value={v.time} onChange={(e) => put('time')(e.target.value)} />
      </div>
      {askSupplier && (
        <div className="col-span-2">
          <label className={labelCls}>Supplier Name</label>
          <input className={fieldCls} value={v.supplier} onChange={(e) => put('supplier')(e.target.value)} placeholder="Purchase didn't give one — type it" />
        </div>
      )}
      {extra}
      <div className={extra ? '' : 'col-span-2'}>
        <label className={labelCls}>Truck No</label>
        <input className={fieldCls} inputMode="numeric" value={v.truckNo} onChange={(e) => put('truckNo')(truckDigits(e.target.value))} placeholder="e.g. 11-2345" />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>PO Status</label>
        <div className="grid grid-cols-3 gap-1.5">
          {PO_STATUSES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => put('poStatus')(p)}
              className={`px-2 py-2.5 rounded-xl text-xs font-semibold border ${v.poStatus === p ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white/80 border-slate-200 text-slate-700'}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Received By</label>
        <input className={fieldCls} value={v.receivedBy} onChange={(e) => put('receivedBy')(e.target.value)} placeholder="Name of the person who took the material" />
      </div>
    </div>
  );
};

// The receiving form for one dispatch. Project, MPR No, material and Qty
// come from the dispatch; Supplier too when Purchase gave one.
const ReceivePopup: React.FC<{ token: string; row: MdRow; d: MdDispatch; onClose: () => void; onDone: (complete: boolean) => void }> = ({ token, row, d, onClose, onDone }) => {
  const [qty, setQty] = useState(String(d.qty));
  const [dl, setDl] = useState(() => newDelivery(d.supplier, d.vehicleNo));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = Number(qty);
  const short = Number.isFinite(n) && qty !== '' && n < d.qty;
  const ready = qty !== '' && deliveryReady(dl) && !(short && !note.trim());
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await mdFetch<{ status: string }>(token, `/api/material-receive/${d.id}`, 'POST', { ...deliveryBody(dl), receivedQty: qty, note });
      onDone(r.status === 'received');
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Material received"
      icon={<PackageCheck className="w-4 h-4" />}
      onClose={busy ? () => {} : onClose}
      size="lg"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void go()} disabled={busy || !ready}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Confirm received
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-3 text-xs space-y-0.5">
          <div className="font-semibold text-slate-800">{row.projectName} · MPR {row.mprNo}</div>
          <div className="text-sm font-semibold text-slate-900">{row.item}{row.specification ? <span className="font-normal text-slate-600"> ({row.specification})</span> : null}</div>
          <div className="text-slate-600">
            Sent <b>{qtyText(d.qty, row.unit)}</b> on {d.dispatchDate ? formatDate(d.dispatchDate) : '—'}
            {d.poNo ? ` · P.O. ${d.poNo}` : ''}
          </div>
          {d.supplier && <div className="text-slate-600">Supplier: <b>{d.supplier}</b></div>}
        </div>
        <DeliveryFields
          v={dl}
          set={setDl}
          askSupplier={!d.supplier}
          minDate={d.dispatchDate}
          extra={
            <div>
              <label className={labelCls}>Qty received{row.unit ? ` (${row.unit})` : ''}</label>
              <input className={fieldCls} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
          }
        />
        <div>
          <label className={labelCls}>{short ? 'Why less? (needed)' : 'Note (optional)'}</label>
          <input className={fieldCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder={short ? 'e.g. 20 cft short on the truck, 5 bags damaged' : ''} />
          {short && <p className="mt-1 text-[11px] text-amber-700">Purchase is told; what didn't arrive can be sent again.</p>}
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// One delivery = the dispatches on the way to one project under the same
// P.O. / challan. Received together: the delivery fields once, then each
// item's Qty (all of what was sent unless changed).
interface DeliveryGroup {
  key: string;
  projectName: string;
  poNo: string;
  challanNo: string;
  supplier: string;
  items: { row: MdRow; d: MdDispatch }[];
}
function deliveryGroups(rows: MdRow[]): DeliveryGroup[] {
  const map = new Map<string, DeliveryGroup>();
  for (const row of rows)
    for (const d of row.dispatches) {
      if (d.status !== 'sent' || (!d.poNo && !d.challanNo)) continue;
      const key = `${row.projectId}|${d.poNo.trim().toLowerCase()}|${d.challanNo.trim().toLowerCase()}`;
      const g = map.get(key) || { key, projectName: row.projectName, poNo: d.poNo, challanNo: d.challanNo, supplier: '', items: [] };
      if (!g.supplier && d.supplier) g.supplier = d.supplier;
      g.items.push({ row, d });
      map.set(key, g);
    }
  return [...map.values()].filter((g) => g.items.length > 1);
}

const BulkReceivePopup: React.FC<{ token: string; group: DeliveryGroup; onClose: () => void; onDone: (text: string) => void }> = ({ token, group, onClose, onDone }) => {
  const first = group.items[0].d;
  const [dl, setDl] = useState(() => newDelivery(group.supplier, first.vehicleNo));
  const [lines, setLines] = useState(() => group.items.map((it) => ({ on: true, qty: String(it.d.qty), note: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
  const put = (i: number, patch: Partial<(typeof lines)[number]>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const isShort = (i: number) => {
    const n = Number(lines[i].qty);
    return lines[i].qty !== '' && Number.isFinite(n) && n < group.items[i].d.qty;
  };
  const picked = lines.filter((l) => l.on).length;
  const linesOk = lines.every((l, i) => !l.on || (l.qty !== '' && !(isShort(i) && !l.note.trim())));
  const askSupplier = group.items.some((it) => !it.d.supplier);
  const minDate = group.items.reduce<string | null>((m, it) => (it.d.dispatchDate && (!m || it.d.dispatchDate > m) ? it.d.dispatchDate : m), null);
  const go = async () => {
    setBusy(true);
    setError('');
    setItemErrors({});
    try {
      const items = group.items.flatMap((it, i) => (lines[i].on ? [{ dispatchId: it.d.id, receivedQty: lines[i].qty, note: lines[i].note }] : []));
      const r = await mdFetch<{ received: number; complete: number }>(token, '/api/material-receive/bulk', 'POST', { ...deliveryBody(dl), items });
      onDone(`${r.received} item${r.received === 1 ? '' : 's'} received${r.complete ? ` — ${r.complete} MPR row${r.complete === 1 ? '' : 's'} complete` : ''}.`);
    } catch (e: any) {
      const errs: { dispatchId: number; error: string }[] = e.data?.errors || [];
      setItemErrors(Object.fromEntries(errs.map((x) => [x.dispatchId, x.error])));
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Receive the whole delivery"
      icon={<PackageCheck className="w-4 h-4" />}
      onClose={busy ? () => {} : onClose}
      size="lg"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void go()} disabled={busy || !picked || !linesOk || !deliveryReady(dl)}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Receive {picked} item{picked === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-3 text-xs space-y-0.5">
          <div className="font-semibold text-slate-800">{group.projectName}</div>
          <div className="text-sm font-semibold text-slate-900">{[group.poNo && `P.O. ${group.poNo}`, group.challanNo && `Challan ${group.challanNo}`].filter(Boolean).join(' · ')}</div>
          <div className="text-slate-600">{group.items.length} items{group.supplier ? <> · Supplier: <b>{group.supplier}</b></> : null}</div>
        </div>
        <DeliveryFields v={dl} set={setDl} askSupplier={askSupplier} minDate={minDate} />
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className={labelCls}>Items — Qty received</span>
            <button type="button" className="text-[11px] underline text-slate-500" onClick={() => setLines((ls) => ls.map((l) => ({ ...l, on: picked < ls.length })))}>
              {picked < lines.length ? 'Tick all' : 'Untick all'}
            </button>
          </div>
          <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
            {group.items.map((it, i) => {
              const l = lines[i];
              const short = l.on && isShort(i);
              return (
                <div key={it.d.id} className={`p-3 space-y-2 ${l.on ? '' : 'opacity-50'}`}>
                  <div className="flex items-start gap-2.5">
                    <input type="checkbox" className="mt-1 w-4 h-4 accent-violet-600" checked={l.on} onChange={(e) => put(i, { on: e.target.checked })} aria-label="Receive this item" />
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="text-sm font-semibold text-slate-900">{it.row.item}{it.row.specification ? <span className="font-normal text-slate-600"> ({it.row.specification})</span> : null}</div>
                      <div className="text-slate-500">MPR {it.row.mprNo} · sent {qtyText(it.d.qty, it.row.unit)}</div>
                    </div>
                    <div className="w-28 shrink-0">
                      <input
                        className={`${fieldCls} text-right`}
                        inputMode="decimal"
                        value={l.qty}
                        disabled={!l.on}
                        onChange={(e) => put(i, { qty: e.target.value })}
                        aria-label={`Qty received${it.row.unit ? ` (${it.row.unit})` : ''}`}
                      />
                      {it.row.unit && <div className="text-[10px] text-slate-500 text-right mt-0.5">{it.row.unit}</div>}
                    </div>
                  </div>
                  {short && <input className={fieldCls} value={l.note} onChange={(e) => put(i, { note: e.target.value })} placeholder="Why less? (needed) — e.g. 5 bags damaged" />}
                  {itemErrors[it.d.id] && <div className="text-[11px] text-rose-700">{itemErrors[it.d.id]}</div>}
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Untick an item that didn't come on this truck — it stays on the way.</p>
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// Takes one MPR row back out of Dispatch Material: a new Delivery Date
// (needed) and an optional reason.
const TakeBackPopup: React.FC<{ token: string; row: MdRow; onClose: () => void; onDone: (text: string) => void }> = ({ token, row, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = todayDhaka();
  const minDate = row.entryDate && row.entryDate > today ? row.entryDate : today;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await mdFetch<{ removed: number; kept: number }>(token, '/api/material-receive/take-back', 'POST', { entryIds: [row.id], reason, deliveryDate });
      if (!r.removed) throw new Error(r.kept ? 'Purchase has already sent material on this row — it can no longer be taken back.' : 'This row is no longer in Dispatch Material.');
      onDone(`${row.mprNo} ${row.item}: taken back from Dispatch — it is back in the MPR list with Delivery Date ${formatDate(deliveryDate)}.`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Take back from Dispatch"
      icon={<Undo2 className="w-4 h-4" />}
      onClose={busy ? () => {} : onClose}
      size="md"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void go()} disabled={busy || !deliveryDate}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Take back
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-3 text-xs space-y-0.5">
          <div className="font-semibold text-slate-800">{row.projectName} · {row.mprNo}</div>
          <div className="text-slate-700">{row.item}{row.specification ? ` (${row.specification})` : ''}</div>
          <div className="text-slate-500">Asked {qtyText(row.qty, row.unit)}{row.queuedBy ? ` · taken up by ${row.queuedBy}` : ''}</div>
        </div>
        <p className="text-xs text-slate-600">The row leaves Purchase's dispatch list and goes back to the MPR list. Purchase is told.</p>
        <div>
          <label className={labelCls}>New Delivery Date (needed)</label>
          <input type="date" className={fieldCls} value={deliveryDate} min={minDate} onChange={(e) => setDeliveryDate(e.target.value)} />
          <p className="mt-1 text-[11px] text-slate-500">Now {row.deliveryDate ? formatDate(row.deliveryDate) : '—'}. The row goes back with the new date.</p>
        </div>
        <div>
          <label className={labelCls}>Reason (optional)</label>
          <input className={fieldCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. not needed now, will ask again later" />
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

export const MaterialReceive: React.FC<{ token: string; canTakeBack?: boolean }> = ({ token, canTakeBack = false }) => {
  const [view, setView] = useState<'mine' | 'open' | 'received'>('mine');
  const [rows, setRows] = useState<MdRow[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receiving, setReceiving] = useState<{ row: MdRow; d: MdDispatch } | null>(null);
  const [timeline, setTimeline] = useState<number | null>(null);
  const [takingBack, setTakingBack] = useState<MdRow | null>(null);
  const [bulk, setBulk] = useState<DeliveryGroup | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  // Tells Purchase the row is needed as it is (no take back).
  const confirmRow = async (r: MdRow) => {
    if (!(await confirmDialog(`Confirm you need ${r.item} (MPR ${r.mprNo}) as asked? Purchase is told.`))) return;
    setConfirming(r.id);
    setError('');
    try {
      await mdFetch(token, '/api/material-receive/confirm', 'POST', { entryIds: [r.id] });
      setNotice(`${r.mprNo} ${r.item}: confirmed — Purchase is told.`);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConfirming(null);
    }
  };
  const today = todayDhaka();
  const load = () => {
    setError('');
    return mdFetch<{ rows: MdRow[] }>(token, view === 'mine' ? '/api/material-receive/my-mpr' : `/api/material-receive${view === 'received' ? '?view=received' : ''}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    setRows(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view]);

  const groups = view === 'open' ? deliveryGroups(rows || []) : [];
  const onTheWay = (rows || []).reduce((n, r) => n + r.dispatches.filter((d) => d.status === 'sent').length, 0);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><PackageCheck className="w-5 h-5 text-emerald-600" /> Material Receive</h2>
            <p className="hidden sm:block text-xs text-slate-500 mt-0.5 max-w-2xl">
              My MPR in Dispatch: where the MPR rows you entered stand with Purchase. On the way: material sent to your projects — when it arrives, confirm how much came.
              When all of an MPR row has arrived, it is complete.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="flex-1 sm:flex-none flex rounded-xl bg-slate-100 p-1">
              {([['mine', 'My MPR', ' in Dispatch'], ['open', `On the way${view === 'open' && rows ? ` (${onTheWay})` : ''}`, ''], ['received', 'Received', ' (60 days)']] as const).map(([k, label, more]) => (
                <button key={k} type="button" onClick={() => setView(k)} className={`flex-1 sm:flex-none px-1.5 sm:px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${view === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                  {label}<span className="hidden sm:inline">{more}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void load()} className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50" aria-label="Refresh" title="Refresh">
              <RefreshCw className="w-4 h-4 text-slate-600" />
            </button>
          </div>
        </div>
        {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 flex justify-between gap-2"><span>{notice}</span><button type="button" className="underline" onClick={() => setNotice('')}>Dismiss</button></div>}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>

      {groups.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 space-y-2">
          <div className="text-sm font-semibold text-slate-900">Receive a whole P.O. / Challan</div>
          <p className="text-xs text-slate-500">Several items came on one truck? Receive them together — fill the truck details once, check each Qty.</p>
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setBulk(g)}
              className="w-full text-left flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50 px-3 py-2.5"
            >
              <div className="min-w-0 text-xs">
                <div className="font-semibold text-slate-900 break-words">{[g.poNo && `P.O. ${g.poNo}`, g.challanNo && `Challan ${g.challanNo}`].filter(Boolean).join(' · ')}</div>
                <div className="text-slate-600 break-words">{g.projectName}{g.supplier ? ` · ${g.supplier}` : ''}</div>
              </div>
              <span className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 sm:py-2 rounded-xl text-sm sm:text-xs font-semibold bg-emerald-600 text-white">
                <PackageCheck className="w-4 h-4" /> Receive {g.items.length} items
              </span>
            </button>
          ))}
        </div>
      )}

      {!rows && !error ? (
        <LoadingBlock />
      ) : rows && !rows.length ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500 shadow-sm">
          {view === 'mine'
            ? "None of your MPR rows is in Dispatch Material yet — Purchase hasn't taken them up."
            : view === 'open'
              ? 'Nothing on the way to your projects right now.'
              : 'Nothing received in the last 60 days.'}
        </div>
      ) : (
        <div className="space-y-3">
          {(rows || []).map((r) => {
            const late = isOverdue(r, today);
            const list = r.dispatches.filter((d) => (view === 'mine' ? d.status !== 'cancelled' : view === 'open' ? d.status === 'sent' : d.status === 'received'));
            return (
              <div key={r.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500">{r.projectName} · MRF {r.mprNo}{r.jobNo ? ` · ${r.jobNo}` : ''}</div>
                    <div className="text-sm font-semibold text-slate-900">{r.item}{r.specification ? <span className="font-normal text-slate-500"> — {r.specification}</span> : null}</div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Asked {qtyText(r.qty, r.unit)} · got {qtyText(r.receivedQty, r.unit)} so far ·{' '}
                      <span className={late ? 'text-rose-600 font-semibold' : ''}>
                        delivery {r.deliveryDate ? formatDate(r.deliveryDate) : '—'}
                        {late && <AlertTriangle className="w-3 h-3 inline ml-0.5 -mt-0.5" />}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <MdStatusChip status={r.status} queued={r.queuedAt} />
                    <button type="button" onClick={() => setTimeline(r.id)} className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="History" title="History">
                      <History className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {view === 'mine' && (
                  <div className="mt-2 text-xs text-slate-600">
                    Sent {qtyText(r.dispatchedQty, r.unit)} · left to send {qtyText(r.remaining, r.unit)}
                    {r.queuedBy ? ` · taken up by ${r.queuedBy}` : ''}
                  </div>
                )}
                {!list.length && view === 'mine' && (
                  <div className="mt-2 space-y-2">
                    <div className="text-xs text-indigo-700">
                      In Purchase's dispatch list — nothing sent yet.
                      {r.confirmedAt && (
                        <span className="ml-1 inline-flex items-center gap-1 font-semibold text-teal-700">
                          <BadgeCheck className="w-3.5 h-3.5" /> Confirmed{r.confirmedBy ? ` by ${r.confirmedBy}` : ''}
                        </span>
                      )}
                    </div>
                    {canTakeBack && (
                      <div className="grid grid-cols-2 sm:flex sm:justify-end gap-2">
                        {!r.confirmedAt && (
                          <button
                            type="button"
                            disabled={confirming === r.id}
                            onClick={() => void confirmRow(r)}
                            className="inline-flex justify-center items-center gap-1.5 px-3 py-2.5 sm:py-1.5 rounded-xl text-sm sm:text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50"
                          >
                            {confirming === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <BadgeCheck className="w-4 h-4" />} Confirm
                          </button>
                        )}
                        <button type="button" onClick={() => setTakingBack(r)} className={`${r.confirmedAt ? 'col-span-2 ' : ''}inline-flex justify-center items-center gap-1.5 px-3 py-2.5 sm:py-1.5 rounded-xl text-sm sm:text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50`}>
                          <Undo2 className="w-4 h-4" /> Take back
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {list.length > 0 && (
                <div className="mt-3 divide-y divide-slate-100 border border-slate-100 rounded-xl">
                  {list.map((d) => (
                    <div key={d.id} className="px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap text-xs">
                      <div className="flex items-start gap-2 min-w-0">
                        <Truck className={`w-4 h-4 shrink-0 mt-0.5 ${d.status === 'sent' ? 'text-sky-600' : 'text-emerald-600'}`} />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800">
                            {qtyText(d.qty, r.unit)} sent on {d.dispatchDate ? formatDate(d.dispatchDate) : '—'}
                          </div>
                          <div className="text-slate-500">{[d.supplier, d.challanNo && `Challan ${d.challanNo}`, d.vehicleNo && `Vehicle ${d.vehicleNo}`].filter(Boolean).join(' · ') || '—'}</div>
                          {d.status === 'received' && (
                            <div className={d.receivedQty !== null && d.receivedQty < d.qty ? 'text-amber-700' : 'text-emerald-700'}>{receiptText(d, r.unit)}</div>
                          )}
                        </div>
                      </div>
                      {d.status === 'sent' && view === 'mine' && <span className="text-[11px] font-semibold text-sky-700">On the way</span>}
                      {d.status === 'sent' && view !== 'mine' && (
                        <button type="button" onClick={() => setReceiving({ row: r, d })} className="w-full sm:w-auto justify-center inline-flex items-center gap-1.5 px-3 py-2.5 sm:py-1.5 rounded-xl text-sm sm:text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
                          <PackageCheck className="w-4 h-4" /> Receive
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {receiving && (
        <ReceivePopup
          token={token}
          row={receiving.row}
          d={receiving.d}
          onClose={() => setReceiving(null)}
          onDone={(complete) => {
            setReceiving(null);
            setNotice(complete ? `${receiving.row.mprNo} ${receiving.row.item}: all received — this MPR row is complete.` : 'Saved — thank you.');
            void load();
          }}
        />
      )}
      {bulk && (
        <BulkReceivePopup
          token={token}
          group={bulk}
          onClose={() => setBulk(null)}
          onDone={(text) => {
            setBulk(null);
            setNotice(text);
            void load();
          }}
        />
      )}
      {takingBack && (
        <TakeBackPopup
          token={token}
          row={takingBack}
          onClose={() => setTakingBack(null)}
          onDone={(text) => {
            setTakingBack(null);
            setNotice(text);
            void load();
          }}
        />
      )}
      {timeline !== null && <MdTimelinePopup token={token} entryId={timeline} onClose={() => setTimeline(null)} />}
    </div>
  );
};
