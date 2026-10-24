/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> PEPM Operation -> Material Receive (users.can_receive_material,
// MprDispatchRoutes.ts).
//   My MPR in Dispatch  the rows this account entered itself (its Job
//                       entries) that Purchase took into Dispatch Material —
//                       where each stands. With users.can_return_dispatch
//                       a row can be taken back out of Dispatch Material
//                       while nothing has been sent on it (Purchase is told).
//   On the way          material Purchase sent to this account's projects
//                       (user_project_permissions): confirm each dispatch when
//                       it arrives — all of it, or less with a reason.
// When an MPR row's whole Qty has arrived, its cycle is complete.

import React, { useEffect, useState } from 'react';
import { PackageCheck, Truck, History, Loader2, RefreshCw, AlertTriangle, Undo2 } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { MdDispatch, MdRow, MdStatusChip, MdTimelinePopup, PO_STATUSES, isOverdue, mdFetch, qtyText, receiptText, todayDhaka } from './MprDispatchShared';

// Truck No: numbers, with single dashes between them (11-2345).
const truckDigits = (v: string) => v.replace(/[^0-9-]/g, '').replace(/-+/g, '-').replace(/^-/, '');
const nowTimeDhaka = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false });

// The receiving form. Project, MPR No, material and Qty come from the
// dispatch; Supplier too when Purchase gave one. Date and time start at now.
const ReceivePopup: React.FC<{ token: string; row: MdRow; d: MdDispatch; onClose: () => void; onDone: (complete: boolean) => void }> = ({ token, row, d, onClose, onDone }) => {
  const [qty, setQty] = useState(String(d.qty));
  const [date, setDate] = useState(todayDhaka());
  const [time, setTime] = useState(nowTimeDhaka());
  const [supplier, setSupplier] = useState(d.supplier);
  const [truckNo, setTruckNo] = useState(truckDigits(d.vehicleNo).replace(/-$/, ''));
  const [poStatus, setPoStatus] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = Number(qty);
  const short = Number.isFinite(n) && qty !== '' && n < d.qty;
  const ready = qty !== '' && !!date && !!time && !!supplier.trim() && !!truckNo && !!poStatus && !!receivedBy.trim() && !(short && !note.trim());
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await mdFetch<{ status: string }>(token, `/api/material-receive/${d.id}`, 'POST', {
        receivedQty: qty,
        receivedDate: date,
        receivedTime: time,
        supplier,
        truckNo: truckNo.replace(/-$/, ''),
        poStatus,
        receivedBy,
        note
      });
      onDone(r.status === 'received');
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  const fixed = (label: string, value: React.ReactNode) => (
    <div>
      <div className={labelCls}>{label}</div>
      <div className="liquid-glass-inset rounded-2xl px-3 py-2 text-sm text-slate-800 min-h-[38px]">{value || '—'}</div>
    </div>
  );
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {fixed('Project', row.projectName)}
          {fixed('MPR No', row.mprNo)}
          {fixed('Materials Name', `${row.item}${row.specification ? ` (${row.specification})` : ''}`)}
          {fixed('Quantity sent', `${qtyText(d.qty, row.unit)} on ${d.dispatchDate ? formatDate(d.dispatchDate) : '—'}${d.poNo ? ` · P.O. ${d.poNo}` : ''}`)}
          <div>
            <label className={labelCls}>Receiving Date</label>
            <input type="date" className={inputCls} value={date} max={todayDhaka()} min={d.dispatchDate || undefined} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Receiving Time</label>
            <input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          {d.supplier ? (
            fixed('Supplier Name', d.supplier)
          ) : (
            <div>
              <label className={labelCls}>Supplier Name</label>
              <input className={inputCls} value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Purchase didn't give one — type it" />
            </div>
          )}
          <div>
            <label className={labelCls}>Quantity received{row.unit ? ` (${row.unit})` : ''}</label>
            <input className={inputCls} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Truck No</label>
            <input className={inputCls} inputMode="numeric" value={truckNo} onChange={(e) => setTruckNo(truckDigits(e.target.value))} placeholder="e.g. 11-2345" />
          </div>
          <div>
            <label className={labelCls}>PO Status</label>
            <select className={inputCls} value={poStatus} onChange={(e) => setPoStatus(e.target.value)}>
              <option value="">Pick…</option>
              {PO_STATUSES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Received By</label>
            <input className={inputCls} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Name of the person who took the material" />
          </div>
        </div>
        <div>
          <label className={labelCls}>{short ? 'Why less? (needed)' : 'Note (optional)'}</label>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder={short ? 'e.g. 20 cft short on the truck, 5 bags damaged' : ''} />
          {short && <p className="mt-1 text-[11px] text-amber-700">Purchase is told; what didn't arrive can be sent again.</p>}
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// Takes one MPR row back out of Dispatch Material, with an optional reason.
const TakeBackPopup: React.FC<{ token: string; row: MdRow; onClose: () => void; onDone: (text: string) => void }> = ({ token, row, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await mdFetch<{ removed: number; kept: number }>(token, '/api/material-receive/take-back', 'POST', { entryIds: [row.id], reason });
      if (!r.removed) throw new Error(r.kept ? 'Purchase has already sent material on this row — it can no longer be taken back.' : 'This row is no longer in Dispatch Material.');
      onDone(`${row.mprNo} ${row.item}: taken back from Dispatch — it is back in the MPR list.`);
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
          <button type="button" className={primaryBtn} onClick={() => void go()} disabled={busy}>
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
          <label className={labelCls}>Reason (optional)</label>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. not needed now, will ask again later" autoFocus />
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

  const onTheWay = (rows || []).reduce((n, r) => n + r.dispatches.filter((d) => d.status === 'sent').length, 0);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><PackageCheck className="w-5 h-5 text-emerald-600" /> Material Receive</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              My MPR in Dispatch: where the MPR rows you entered stand with Purchase. On the way: material sent to your projects — when it arrives, confirm how much came.
              When all of an MPR row has arrived, it is complete.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl bg-slate-100 p-1">
              {([['mine', 'My MPR in Dispatch'], ['open', `On the way${view === 'open' && rows ? ` (${onTheWay})` : ''}`], ['received', 'Received (60 days)']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setView(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${view === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                  {label}
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
                  <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-indigo-700">In Purchase's dispatch list — nothing sent yet.</span>
                    {canTakeBack && (
                      <button type="button" onClick={() => setTakingBack(r)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50">
                        <Undo2 className="w-4 h-4" /> Take back
                      </button>
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
                        <button type="button" onClick={() => setReceiving({ row: r, d })} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
                          <PackageCheck className="w-4 h-4" /> Received
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
