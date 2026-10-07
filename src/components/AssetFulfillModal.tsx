/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Fulfill / Hand Over form for an Asset Requisition. Opens with one line per
// item the employee requested (prefilled name/quantity/unit); the fulfiller
// types what was actually handed over — Serial No, Asset Tag and a note are
// optional. There's no picking from inventory: each line becomes the
// employee's My Asset entry, where they Accept & Acknowledge it or report an
// issue. Only the requested items can be handed over — a line can be removed
// or its quantity lowered, but no extra line added or quantity raised (the
// API checks the same).
//
// mode 'fulfill'  -> POST /api/assets/requisitions/:id/fulfill (already Approved)
// mode 'approve'  -> PUT  /api/assets/requisitions/:id/approve-and-fulfill
//                    (the Template's Asset Fulfiller Layer on Pending Approvals)

import React, { useState } from 'react';
import { X, Trash2, PackageCheck } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

export interface RequestedItem {
  item_name: string;
  purpose?: string | null;
  unit?: string | null;
  quantity?: number | string | null;
}

interface Line {
  item_name: string;
  quantity: string;
  unit: string;
  serial_number: string;
  asset_tag: string;
  note: string;
  requested?: string;
  // The requested item's name ("Laptop") — saved as the handed-over item's
  // category, so "Dell Latitude 5440" reads as a Laptop in My Asset.
  category?: string;
  // Which requested item this line hands over, and its requested quantity.
  requested_index: number;
  max_quantity: number | null;
}

interface AssetFulfillModalProps {
  token: string;
  requisitionId: number;
  mode: 'fulfill' | 'approve';
  requesterName?: string | null;
  items: RequestedItem[];
  onClose: () => void;
  onDone: () => void;
}

// An input that fills its table cell, the cell border doing the framing.
const cellInput =
  'w-full min-w-0 text-[11px] px-1.5 py-1.5 bg-transparent border-0 focus:ring-2 focus:ring-inset focus:ring-blue-600 focus:outline-none placeholder:text-slate-300';

const inputClass =
  'w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';

export function AssetFulfillModal({ token, requisitionId, mode, requesterName, items, onClose, onDone }: AssetFulfillModalProps) {
  useBackButtonClose(true, onClose);
  const [lines, setLines] = useState<Line[]>(() =>
    (items.length > 0 ? items : [{ item_name: '' }]).map((it: RequestedItem, i) => ({
      item_name: it.item_name || '',
      quantity: it.quantity != null && it.quantity !== '' ? String(Number(it.quantity)) : '1',
      unit: it.unit || 'pcs',
      serial_number: '',
      asset_tag: '',
      note: '',
      category: it.item_name || undefined,
      requested_index: i,
      max_quantity: it.quantity != null && it.quantity !== '' && Number(it.quantity) > 0 ? Number(it.quantity) : null,
      requested: it.item_name ? `${it.item_name} × ${Number(it.quantity ?? 1)} ${it.unit || 'pcs'}${it.purpose ? ` — ${it.purpose}` : ''}` : undefined
    }))
  );
  const [condition, setCondition] = useState<'new' | 'good'>('good');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (idx: number, patch: Partial<Line>) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const submit = async () => {
    setError(null);
    for (const [i, l] of lines.entries()) {
      if (!l.item_name.trim()) return setError(`Item #${i + 1}: type what you're handing over.`);
      if (!(Number(l.quantity) > 0)) return setError(`Item #${i + 1}: quantity must be greater than 0.`);
      if (l.max_quantity != null && Number(l.quantity) > l.max_quantity) {
        return setError(`Item #${i + 1}: at most ${l.max_quantity} ${l.unit || 'pcs'} were requested.`);
      }
    }
    setSaving(true);
    try {
      const url =
        mode === 'approve'
          ? `/api/assets/requisitions/${requisitionId}/approve-and-fulfill`
          : `/api/assets/requisitions/${requisitionId}/fulfill`;
      const res = await fetch(apiUrl(url), {
        method: mode === 'approve' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          condition_on_assign: condition,
          remarks: remarks.trim() || undefined,
          items: lines.map((l) => ({
            item_name: l.item_name.trim(),
            requested_index: l.requested_index,
            quantity: Number(l.quantity),
            unit: l.unit.trim() || 'pcs',
            serial_number: l.serial_number.trim() || undefined,
            asset_tag: l.asset_tag.trim() || undefined,
            note: l.note.trim() || undefined,
            category: l.category || undefined
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not fulfill this requisition.');
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
              <PackageCheck className="w-4.5 h-4.5 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Fulfill & Hand Over — Requisition #{requisitionId}</h2>
              <p className="text-xs text-slate-500">
                {requesterName ? `For ${requesterName}. ` : ''}Type what you're handing over; they'll confirm it in My Asset.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {error && <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5">{error}</div>}

          {/* Same look as the PEPM report table: bordered cells, blue header. */}
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full min-w-[860px] border-collapse text-[11px] leading-snug">
              <thead className="bg-blue-50">
                <tr>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-right w-8">Sl</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left w-[18%]">Requested</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left w-[20%]">Item handed over *</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-right w-16">Qty *</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left w-16">Unit</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left">Serial No</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left">Asset Tag</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-left">Note</th>
                  <th className="px-1.5 py-2 border border-slate-200 font-semibold text-slate-700 text-center w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx} className="odd:bg-white even:bg-slate-50/70 hover:bg-blue-50/50 transition-colors">
                    <td className="px-1.5 py-1.5 border border-slate-200 align-top text-right text-slate-500 tabular-nums">{idx + 1}.</td>
                    <td className="px-1.5 py-1.5 border border-slate-200 align-top text-slate-700">
                      <div className="line-clamp-2 break-words" title={l.requested}>{l.requested || '—'}</div>
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input value={l.item_name} onChange={(e) => update(idx, { item_name: e.target.value })} placeholder="e.g. Dell Latitude 5440" className={cellInput} />
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input
                        type="number"
                        min={0}
                        max={l.max_quantity ?? undefined}
                        step="any"
                        value={l.quantity}
                        onChange={(e) => update(idx, { quantity: e.target.value })}
                        className={`${cellInput} text-right tabular-nums`}
                      />
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input value={l.unit} onChange={(e) => update(idx, { unit: e.target.value })} placeholder="pcs" className={cellInput} />
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input value={l.serial_number} onChange={(e) => update(idx, { serial_number: e.target.value })} placeholder="Optional" className={cellInput} />
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input value={l.asset_tag} onChange={(e) => update(idx, { asset_tag: e.target.value })} placeholder="Auto if blank" className={cellInput} />
                    </td>
                    <td className="p-0 border border-slate-200 align-top">
                      <input value={l.note} onChange={(e) => update(idx, { note: e.target.value })} placeholder="Brand, condition…" className={cellInput} />
                    </td>
                    <td className="px-1 py-1 border border-slate-200 align-top text-center">
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-400 hover:text-rose-600 rounded"
                          title="Remove this line"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-400">Only the requested items can be handed over — remove a line or lower its quantity if something isn't given.</p>

          <div className="grid sm:grid-cols-2 gap-3">
            <label>
              <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Condition</span>
              <select value={condition} onChange={(e) => setCondition(e.target.value as 'new' | 'good')} className={inputClass}>
                <option value="new">New</option>
                <option value="good">Good</option>
              </select>
            </label>
            {mode === 'approve' && (
              <label>
                <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Remarks (optional)</span>
                <input value={remarks} onChange={(e) => setRemarks(e.target.value)} className={inputClass} />
              </label>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <Spinner size={14} /> : <PackageCheck className="w-4 h-4" />} Fulfill & Hand Over
          </button>
        </div>
      </div>
    </div>
  );
}
