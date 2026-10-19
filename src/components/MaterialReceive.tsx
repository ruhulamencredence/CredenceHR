/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> PEPM Operation -> Material Receive (users.can_receive_material,
// MprDispatchRoutes.ts): material Purchase has sent to this account's projects
// (user_project_permissions). Confirm each dispatch when it arrives — all of it,
// or less with a reason. When an MPR row's whole Qty has arrived, its cycle is
// complete.

import React, { useEffect, useState } from 'react';
import { PackageCheck, Truck, History, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { MdDispatch, MdRow, MdStatusChip, MdTimelinePopup, isOverdue, mdFetch, qtyText, todayDhaka } from './MprDispatchShared';

const ReceivePopup: React.FC<{ token: string; row: MdRow; d: MdDispatch; onClose: () => void; onDone: (complete: boolean) => void }> = ({ token, row, d, onClose, onDone }) => {
  const [qty, setQty] = useState(String(d.qty));
  const [date, setDate] = useState(todayDhaka());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = Number(qty);
  const short = Number.isFinite(n) && qty !== '' && n < d.qty;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await mdFetch<{ status: string }>(token, `/api/material-receive/${d.id}`, 'POST', { receivedQty: qty, receivedDate: date, note });
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
      size="md"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={primaryBtn} onClick={() => void go()} disabled={busy || qty === '' || (short && !note.trim())}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Confirm received
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-3 text-xs space-y-0.5">
          <div className="font-semibold text-slate-800">{row.projectName} · {row.mprNo}</div>
          <div className="text-slate-700">{row.item}{row.specification ? ` (${row.specification})` : ''}</div>
          <div className="text-slate-500">
            Sent {qtyText(d.qty, row.unit)} on {d.dispatchDate ? formatDate(d.dispatchDate) : '—'}
            {d.supplier ? ` · ${d.supplier}` : ''}
            {d.challanNo ? ` · Challan ${d.challanNo}` : ''}
            {d.vehicleNo ? ` · Vehicle ${d.vehicleNo}` : ''}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Qty that arrived{row.unit ? ` (${row.unit})` : ''}</label>
            <input className={inputCls} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          </div>
          <div>
            <label className={labelCls}>Received on</label>
            <input type="date" className={inputCls} value={date} max={todayDhaka()} min={d.dispatchDate || undefined} onChange={(e) => setDate(e.target.value)} />
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

export const MaterialReceive: React.FC<{ token: string }> = ({ token }) => {
  const [view, setView] = useState<'open' | 'received'>('open');
  const [rows, setRows] = useState<MdRow[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receiving, setReceiving] = useState<{ row: MdRow; d: MdDispatch } | null>(null);
  const [timeline, setTimeline] = useState<number | null>(null);
  const today = todayDhaka();
  const load = () => {
    setError('');
    return mdFetch<{ rows: MdRow[] }>(token, `/api/material-receive${view === 'received' ? '?view=received' : ''}`)
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
              Material Purchase has sent to your projects against their MPR rows. When it arrives, confirm how much came. When all of an MPR row has arrived, it is complete.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl bg-slate-100 p-1">
              {([['open', `On the way${view === 'open' && rows ? ` (${onTheWay})` : ''}`], ['received', 'Received (60 days)']] as const).map(([k, label]) => (
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
          {view === 'open' ? 'Nothing on the way to your projects right now.' : 'Nothing received in the last 60 days.'}
        </div>
      ) : (
        <div className="space-y-3">
          {(rows || []).map((r) => {
            const late = isOverdue(r, today);
            const list = r.dispatches.filter((d) => (view === 'open' ? d.status === 'sent' : d.status === 'received'));
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
                    <MdStatusChip status={r.status} />
                    <button type="button" onClick={() => setTimeline(r.id)} className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="History" title="History">
                      <History className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
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
                            <div className={d.receivedQty !== null && d.receivedQty < d.qty ? 'text-amber-700' : 'text-emerald-700'}>
                              Received {qtyText(d.receivedQty, r.unit)} on {d.receivedDate ? formatDate(d.receivedDate) : '—'}
                              {d.receivedNote ? ` — ${d.receivedNote}` : ''}
                            </div>
                          )}
                        </div>
                      </div>
                      {d.status === 'sent' && (
                        <button type="button" onClick={() => setReceiving({ row: r, d })} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
                          <PackageCheck className="w-4 h-4" /> Received
                        </button>
                      )}
                    </div>
                  ))}
                </div>
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
      {timeline !== null && <MdTimelinePopup token={token} entryId={timeline} onClose={() => setTimeline(null)} />}
    </div>
  );
};
