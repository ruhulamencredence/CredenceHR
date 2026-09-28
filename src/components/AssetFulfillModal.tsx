/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Fulfill / Hand Over form for an Asset Requisition. Opens with one line per
// item the employee requested (prefilled name/quantity/unit); the fulfiller
// types what was actually handed over — Serial No, Asset Tag and a note are
// optional. There's no picking from inventory: each line becomes the
// employee's My Asset entry, where they Accept & Acknowledge it or report an
// issue.
//
// mode 'fulfill'  -> POST /api/assets/requisitions/:id/fulfill (already Approved)
// mode 'approve'  -> PUT  /api/assets/requisitions/:id/approve-and-fulfill
//                    (the Template's Asset Fulfiller Layer on Pending Approvals)

import React, { useState } from 'react';
import { X, Plus, Trash2, PackageCheck } from 'lucide-react';
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

const inputClass =
  'w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';

export function AssetFulfillModal({ token, requisitionId, mode, requesterName, items, onClose, onDone }: AssetFulfillModalProps) {
  useBackButtonClose(true, onClose);
  const [lines, setLines] = useState<Line[]>(() =>
    (items.length > 0 ? items : [{ item_name: '' }]).map((it) => ({
      item_name: it.item_name || '',
      quantity: it.quantity != null && it.quantity !== '' ? String(Number(it.quantity)) : '1',
      unit: it.unit || 'pcs',
      serial_number: '',
      asset_tag: '',
      note: '',
      category: it.item_name || undefined,
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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
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

          {lines.map((l, idx) => (
            <div key={idx} className="border border-slate-200 rounded-xl p-3 bg-slate-50/60">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Item {idx + 1}</div>
                  {l.requested && <div className="text-[11px] text-slate-400 truncate">Requested: {l.requested}</div>}
                </div>
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
              </div>
              <div className="grid grid-cols-6 gap-2">
                <label className="col-span-6 sm:col-span-3">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Item handed over *</span>
                  <input value={l.item_name} onChange={(e) => update(idx, { item_name: e.target.value })} placeholder="e.g. Dell Latitude 5440" className={inputClass} />
                </label>
                <label className="col-span-3 sm:col-span-1">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Qty *</span>
                  <input type="number" min={0} step="any" value={l.quantity} onChange={(e) => update(idx, { quantity: e.target.value })} className={inputClass} />
                </label>
                <label className="col-span-3 sm:col-span-2">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Unit</span>
                  <input value={l.unit} onChange={(e) => update(idx, { unit: e.target.value })} placeholder="pcs" className={inputClass} />
                </label>
                <label className="col-span-3">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Serial No (optional)</span>
                  <input value={l.serial_number} onChange={(e) => update(idx, { serial_number: e.target.value })} className={inputClass} />
                </label>
                <label className="col-span-3">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Asset Tag (optional)</span>
                  <input value={l.asset_tag} onChange={(e) => update(idx, { asset_tag: e.target.value })} placeholder="Auto if blank" className={inputClass} />
                </label>
                <label className="col-span-6">
                  <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Note (optional)</span>
                  <input value={l.note} onChange={(e) => update(idx, { note: e.target.value })} placeholder="Brand, condition, accessories…" className={inputClass} />
                </label>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, { item_name: '', quantity: '1', unit: 'pcs', serial_number: '', asset_tag: '', note: '' }])}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border-2 border-dashed border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            <Plus className="w-3.5 h-3.5" /> Add another line
          </button>

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
