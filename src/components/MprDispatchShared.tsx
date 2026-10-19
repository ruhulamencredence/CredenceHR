/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared by Dispatch Material (MprDispatchMaterial.tsx), Material Receive
// (MaterialReceive.tsx) and the MPR Entries report: the row / dispatch shapes
// of MprDispatchRoutes.ts, the status chip and an MPR row's timeline popup.

import React, { useEffect, useState } from 'react';
import { History, Loader2, Truck, PackageCheck, XCircle, FileText } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { MailPopup as Popup } from './mail/MailPopup';

export type MdStatus = 'pending' | 'partly_dispatched' | 'dispatched' | 'partly_received' | 'received';

export interface MdDispatch {
  id: number;
  entryId: number;
  qty: number;
  dispatchDate: string | null;
  supplier: string;
  rate: number | null;
  poNo: string;
  challanNo: string;
  vehicleNo: string;
  note: string;
  source: string;
  status: 'sent' | 'received' | 'cancelled';
  sentBy: string;
  receivedQty: number | null;
  receivedDate: string | null;
  receivedNote: string;
  receivedBy: string;
  cancelReason: string;
}

export interface MdRow {
  id: number;
  entryDate: string | null;
  projectId: number;
  projectName: string;
  mprNo: string;
  jobNo: string;
  jobName: string;
  budgetName: string;
  item: string;
  specification: string;
  unit: string;
  qty: number | null;
  deliveryDate: string | null;
  requestedBy: string;
  status: MdStatus;
  dispatchedQty: number;
  receivedQty: number;
  remaining: number | null;
  lastDispatchDate: string | null;
  receivedDate: string | null;
  dispatches: MdDispatch[];
}

export const MD_STATUS: Record<MdStatus, { label: string; cls: string }> = {
  pending: { label: 'Not dispatched', cls: 'bg-slate-100 text-slate-600' },
  partly_dispatched: { label: 'Partly dispatched', cls: 'bg-amber-50 text-amber-700' },
  dispatched: { label: 'Dispatched', cls: 'bg-sky-50 text-sky-700' },
  partly_received: { label: 'Partly received', cls: 'bg-violet-50 text-violet-700' },
  received: { label: 'Received', cls: 'bg-emerald-50 text-emerald-700' }
};
export const mdStatusLabel = (s: string | null | undefined) => MD_STATUS[(s || 'pending') as MdStatus]?.label || 'Not dispatched';

export const MdStatusChip: React.FC<{ status: string | null | undefined }> = ({ status }) => {
  const s = MD_STATUS[(status || 'pending') as MdStatus] || MD_STATUS.pending;
  return <span className={`inline-block whitespace-nowrap text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>;
};

export const qtyText = (n: number | null | undefined, unit?: string) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
// Delivery date already passed while material is still owed.
export const isOverdue = (r: Pick<MdRow, 'deliveryDate' | 'status'>, today: string) => !!r.deliveryDate && r.deliveryDate < today && r.status !== 'received' && r.status !== 'dispatched';
export const todayDhaka = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

export async function mdFetch<T>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { data });
  return data as T;
}

interface TimelineEvent {
  action: 'request' | 'dispatch' | 'receive' | 'cancel';
  qty: number | null;
  detail: string;
  at: string | null;
  by: string;
}
const EVENT: Record<TimelineEvent['action'], { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  request: { label: 'Asked for', icon: FileText, cls: 'bg-slate-100 text-slate-600' },
  dispatch: { label: 'Dispatched', icon: Truck, cls: 'bg-sky-100 text-sky-700' },
  receive: { label: 'Received', icon: PackageCheck, cls: 'bg-emerald-100 text-emerald-700' },
  cancel: { label: 'Dispatch cancelled', icon: XCircle, cls: 'bg-rose-100 text-rose-700' }
};

// One MPR row's whole story: asked for, every dispatch, every receipt.
// extra: actions a page adds under the dispatches (Cancel on Dispatch Material).
export const MdTimelinePopup: React.FC<{
  token: string;
  entryId: number;
  onClose: () => void;
  dispatchAction?: (d: MdDispatch, reload: () => void) => React.ReactNode;
}> = ({ token, entryId, onClose, dispatchAction }) => {
  const [data, setData] = useState<{ row: MdRow; events: TimelineEvent[] } | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    mdFetch<{ row: MdRow; events: TimelineEvent[] }>(token, `/api/mpr-dispatch/entries/${entryId}/timeline`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, entryId]);
  const r = data?.row;
  return (
    <Popup title={r ? `${r.mprNo} · ${r.item}` : 'MPR row'} icon={<History className="w-4 h-4" />} onClose={onClose} size="lg">
      {error && <div className="text-sm text-rose-700 bg-rose-50 rounded-xl px-3 py-2">{error}</div>}
      {!data && !error ? (
        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : (
        r && (
          <div className="space-y-4 text-left">
            <div className="liquid-glass-inset rounded-[24px] p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><div className="text-slate-500">Project</div><div className="font-semibold text-slate-800">{r.projectName}</div></div>
              <div><div className="text-slate-500">Asked for</div><div className="font-semibold text-slate-800">{qtyText(r.qty, r.unit)}</div></div>
              <div><div className="text-slate-500">Delivery date</div><div className="font-semibold text-slate-800">{r.deliveryDate ? formatDate(r.deliveryDate) : '—'}</div></div>
              <div><div className="text-slate-500">Status</div><MdStatusChip status={r.status} /></div>
              <div><div className="text-slate-500">Sent</div><div className="font-semibold text-slate-800">{qtyText(r.dispatchedQty, r.unit)}</div></div>
              <div><div className="text-slate-500">Received</div><div className="font-semibold text-slate-800">{qtyText(r.receivedQty, r.unit)}</div></div>
              <div><div className="text-slate-500">Left to send</div><div className="font-semibold text-slate-800">{qtyText(r.remaining, r.unit)}</div></div>
              <div><div className="text-slate-500">Specification</div><div className="font-semibold text-slate-800">{r.specification || '—'}</div></div>
            </div>
            {r.dispatches.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1.5">Dispatches</div>
                <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
                  {r.dispatches.map((d) => (
                    <div key={d.id} className="px-3 py-2.5 text-xs flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-800">
                          {qtyText(d.qty, r.unit)} on {d.dispatchDate ? formatDate(d.dispatchDate) : '—'}
                          {d.status === 'cancelled' && <span className="ml-2 text-rose-600">Cancelled — {d.cancelReason}</span>}
                        </div>
                        <div className="text-slate-500">
                          {[d.supplier, d.poNo && `P.O. ${d.poNo}`, d.rate != null && `Rate ${d.rate}`, d.challanNo && `Challan ${d.challanNo}`, d.vehicleNo && `Vehicle ${d.vehicleNo}`, d.sentBy && `by ${d.sentBy}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                        {d.status === 'received' && (
                          <div className={d.receivedQty !== null && d.receivedQty < d.qty ? 'text-amber-700' : 'text-emerald-700'}>
                            Received {qtyText(d.receivedQty, r.unit)} on {d.receivedDate ? formatDate(d.receivedDate) : '—'}
                            {d.receivedBy ? ` by ${d.receivedBy}` : ''}
                            {d.receivedNote ? ` — ${d.receivedNote}` : ''}
                          </div>
                        )}
                        {d.status === 'sent' && <div className="text-sky-700">On the way — not received yet</div>}
                      </div>
                      {dispatchAction?.(d, () => void load())}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1.5">Timeline</div>
              <ol className="space-y-2">
                {data.events.map((e, i) => {
                  const k = EVENT[e.action] || EVENT.request;
                  const Icon = k.icon;
                  return (
                    <li key={i} className="flex items-start gap-2.5 text-xs">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${k.cls}`}><Icon className="w-3.5 h-3.5" /></span>
                      <div className="min-w-0">
                        <div className="text-slate-800">
                          <span className="font-semibold">{k.label}</span>
                          {e.qty !== null && e.qty !== undefined ? ` ${qtyText(e.qty, r.unit)}` : ''}
                          {e.by ? ` · ${e.by}` : ''}
                        </div>
                        <div className="text-slate-500">
                          {e.at
                            ? e.action === 'request'
                              ? formatDate(String(e.at).slice(0, 10)) // an entry has a date, no time
                              : new Date(e.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                            : ''}
                          {e.detail ? ` — ${e.detail}` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        )
      )}
    </Popup>
  );
};
