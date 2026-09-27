/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// History of one Asset Requisition (GET /api/assets/requisitions/:id/history):
// the items as they stand — which the employee asked for, which the
// Supervisor added, changed or removed — and a timeline of every operation.

import React, { useEffect, useState } from 'react';
import { X, History, CheckCircle2, XCircle, Pencil, PackageCheck, AlertTriangle, Send, RotateCcw, ThumbsUp } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface HistoryItem {
  id: number;
  item_name: string;
  purpose: string;
  unit: string;
  quantity: number;
  source: string;
  original_quantity: number | null;
  removed: boolean;
}

interface HistoryEvent {
  id: number;
  action: string;
  message: string;
  actor_name: string | null;
  created_at: string;
}

const EVENT_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  submitted: { icon: Send, cls: 'bg-blue-100 text-blue-700' },
  approved_step: { icon: ThumbsUp, cls: 'bg-emerald-100 text-emerald-700' },
  approved: { icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { icon: XCircle, cls: 'bg-rose-100 text-rose-700' },
  items_edited: { icon: Pencil, cls: 'bg-amber-100 text-amber-700' },
  handed_over: { icon: PackageCheck, cls: 'bg-teal-100 text-teal-700' },
  acknowledged: { icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-700' },
  issue_reported: { icon: AlertTriangle, cls: 'bg-orange-100 text-orange-700' },
  issue_resolved: { icon: CheckCircle2, cls: 'bg-sky-100 text-sky-700' },
  return_requested: { icon: RotateCcw, cls: 'bg-slate-100 text-slate-700' },
  returned: { icon: RotateCcw, cls: 'bg-slate-100 text-slate-700' }
};

const fmtWhen = (v: string) => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

interface Props {
  token: string;
  requisitionId: number;
  onClose: () => void;
}

export function AssetRequisitionHistoryModal({ token, requisitionId, onClose }: Props) {
  useBackButtonClose(true, onClose);
  const [data, setData] = useState<{ events: HistoryEvent[]; items: HistoryItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(apiUrl(`/api/assets/requisitions/${requisitionId}/history`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.error || 'Could not load the history.');
        setData(json);
      })
      .catch((err) => setError(err.message));
  }, [requisitionId, token]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <History className="w-4 h-4 text-blue-600" /> Requisition #{requisitionId} — History
          </h2>
          <button type="button" onClick={onClose} className="p-2 -mr-1 rounded-full text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error ? (
            <p className="text-xs text-rose-600">{error}</p>
          ) : !data ? (
            <div className="flex justify-center py-10">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : (
            <>
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Items</h3>
                <div className="space-y-1.5">
                  {data.items.map((it) => {
                    const qtyChanged = it.original_quantity != null && Number(it.original_quantity) !== Number(it.quantity);
                    return (
                      <div
                        key={it.id}
                        className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${
                          it.removed ? 'border-rose-100 bg-rose-50/50' : 'border-slate-200'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className={`font-semibold ${it.removed ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{it.item_name}</div>
                          <div className="text-slate-500 truncate">{it.purpose}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {it.source === 'supervisor' ? (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">Added by Supervisor</span>
                            ) : (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">Requested by employee</span>
                            )}
                            {qtyChanged && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">
                                Qty changed by Supervisor ({Number(it.original_quantity)} → {Number(it.quantity)})
                              </span>
                            )}
                            {it.removed && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">Removed by Supervisor</span>
                            )}
                          </div>
                        </div>
                        <div className={`shrink-0 font-semibold ${it.removed ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                          {Number(it.quantity)} {it.unit}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Timeline</h3>
                {data.events.length === 0 ? (
                  <p className="text-xs text-slate-400">No recorded activity yet.</p>
                ) : (
                  <ol className="relative border-l border-slate-200 ml-3 space-y-4">
                    {data.events.map((e) => {
                      const st = EVENT_STYLE[e.action] || { icon: History, cls: 'bg-slate-100 text-slate-600' };
                      const Icon = st.icon;
                      return (
                        <li key={e.id} className="ml-5">
                          <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${st.cls}`}>
                            <Icon className="w-3 h-3" />
                          </span>
                          <p className="text-xs text-slate-800">{e.message}</p>
                          <p className="text-[11px] text-slate-400 mt-0.5">{fmtWhen(e.created_at)}</p>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
