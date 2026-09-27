/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Supervisor Layer of an Asset Requisition: before approving, the
// requester's Supervisor can change quantities, delete lines and add lines
// (PUT /api/assets/requisitions/:id/items). Every change is kept in the
// requisition's History and the requester is notified.

import React, { useState } from 'react';
import { X, Plus, Trash2, Pencil, RotateCcw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

export interface EditableItem {
  id?: number;
  item_name: string;
  purpose: string;
  unit: string;
  quantity: number | string;
  source?: string | null;
  original_quantity?: number | null;
}

interface Row {
  id?: number;
  item_name: string;
  purpose: string;
  unit: string;
  quantity: string;
  removed: boolean;
  initial?: { item_name: string; purpose: string; unit: string; quantity: number };
}

interface Props {
  token: string;
  requisitionId: number;
  requesterName?: string | null;
  items: EditableItem[];
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  'w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400';

export function AssetRequisitionEditItemsModal({ token, requisitionId, requesterName, items, onClose, onSaved }: Props) {
  useBackButtonClose(true, onClose);
  const [rows, setRows] = useState<Row[]>(() =>
    items.map((it) => ({
      id: it.id,
      item_name: it.item_name,
      purpose: it.purpose || '',
      unit: it.unit || 'pcs',
      quantity: String(Number(it.quantity)),
      removed: false,
      initial: { item_name: it.item_name, purpose: it.purpose || '', unit: it.unit || 'pcs', quantity: Number(it.quantity) }
    }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (idx: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const isChanged = (r: Row) =>
    !!r.initial &&
    (r.initial.item_name !== r.item_name.trim() ||
      r.initial.purpose !== r.purpose.trim() ||
      r.initial.unit !== r.unit.trim() ||
      r.initial.quantity !== Number(r.quantity));

  const save = async () => {
    setError(null);
    const kept = rows.filter((r) => !r.removed);
    if (kept.length === 0) return setError('Keep at least one item — reject the requisition instead if nothing is needed.');
    for (const [i, r] of kept.entries()) {
      if (!r.item_name.trim() || !r.purpose.trim() || !r.unit.trim()) return setError(`Item #${i + 1}: name, purpose and unit are required.`);
      if (!(Number(r.quantity) > 0)) return setError(`Item #${i + 1}: quantity must be greater than 0.`);
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/assets/requisitions/${requisitionId}/items`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          items: kept.map((r) => ({
            id: r.id,
            item_name: r.item_name.trim(),
            purpose: r.purpose.trim(),
            unit: r.unit.trim(),
            quantity: Number(r.quantity)
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save the items.');
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <Pencil className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Edit Items — Requisition #{requisitionId}</h2>
              <p className="text-xs text-slate-500">
                {requesterName ? `${requesterName} will be notified. ` : ''}Every change is saved in the requisition’s history.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {error && <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5">{error}</div>}
          {rows.map((r, idx) => {
            const badge = r.removed
              ? { text: 'Will be removed', cls: 'bg-rose-50 text-rose-700 border-rose-200' }
              : !r.id
                ? { text: 'New — added by you', cls: 'bg-blue-50 text-blue-700 border-blue-200' }
                : isChanged(r)
                  ? { text: 'Changed', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                  : null;
            return (
              <div key={idx} className={`border rounded-xl p-3 ${r.removed ? 'border-rose-200 bg-rose-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Item {idx + 1}</span>
                    {badge && <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.text}</span>}
                    {r.initial && (
                      <span className="text-[11px] text-slate-400 truncate">
                        Requested: {r.initial.item_name} × {r.initial.quantity} {r.initial.unit}
                      </span>
                    )}
                  </div>
                  {r.removed ? (
                    <button type="button" onClick={() => update(idx, { removed: false })} className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-blue-700">
                      <RotateCcw className="w-3 h-3" /> Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => (r.id ? update(idx, { removed: true }) : setRows((prev) => prev.filter((_, i) => i !== idx)))}
                      className="p-1 text-slate-400 hover:text-rose-600 rounded"
                      title="Delete this item"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-6 gap-2">
                  <label className="col-span-6 sm:col-span-3">
                    <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Item</span>
                    <input disabled={r.removed} value={r.item_name} onChange={(e) => update(idx, { item_name: e.target.value })} className={inputClass} />
                  </label>
                  <label className="col-span-3 sm:col-span-1">
                    <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Qty</span>
                    <input disabled={r.removed} type="number" min={0} step="any" value={r.quantity} onChange={(e) => update(idx, { quantity: e.target.value })} className={inputClass} />
                  </label>
                  <label className="col-span-3 sm:col-span-2">
                    <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Unit</span>
                    <input disabled={r.removed} value={r.unit} onChange={(e) => update(idx, { unit: e.target.value })} className={inputClass} />
                  </label>
                  <label className="col-span-6">
                    <span className="block text-[10px] font-semibold text-slate-500 mb-0.5">Purpose</span>
                    <input disabled={r.removed} value={r.purpose} onChange={(e) => update(idx, { purpose: e.target.value })} className={inputClass} />
                  </label>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { item_name: '', purpose: '', unit: 'pcs', quantity: '1', removed: false }])}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border-2 border-dashed border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            <Plus className="w-3.5 h-3.5" /> Add item
          </button>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving && <Spinner size={14} />} Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
