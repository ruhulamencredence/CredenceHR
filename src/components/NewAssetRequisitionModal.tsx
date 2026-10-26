/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { UnitPicker } from './UnitPicker';

// "My Asset" -> "+ New Requisition" — its own full-screen popup (portal,
// header / scrolling body / footer), in the liquid-glass house style. See
// POST /api/assets/requisitions.

interface RequisitionItem {
  item_name: string;
  purpose: string;
  unit: string;
  quantity: number;
}

const emptyItem = (): RequisitionItem => ({ item_name: '', purpose: '', unit: 'pcs', quantity: 1 });

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

interface NewAssetRequisitionModalProps {
  onClose: () => void;
  onSubmitted: () => void;
}

export const NewAssetRequisitionModal: React.FC<NewAssetRequisitionModalProps> = ({ onClose, onSubmitted }) => {
  const [items, setItems] = useState<RequisitionItem[]>([emptyItem()]);
  const [meta, setMeta] = useState({ urgency: 'medium', target_date: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useBackButtonClose(true, submitting ? () => {} : onClose);

  function updateItem(index: number, patch: Partial<RequisitionItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      // Drop any fully-empty row (e.g. a trailing "+ Add Item" the person
      // never filled in) rather than failing the whole submission on it.
      const cleanItems = items
        .map((it) => ({ ...it, item_name: it.item_name.trim(), purpose: it.purpose.trim(), unit: it.unit.trim() }))
        .filter((it) => it.item_name || it.purpose);
      if (cleanItems.length === 0) throw new Error('Add at least one item.');
      for (const it of cleanItems) {
        if (!it.item_name) throw new Error('Every item needs a name.');
        if (!it.purpose) throw new Error('Every item needs a purpose.');
        if (!it.unit) throw new Error('Every item needs a unit.');
        if (!it.quantity || it.quantity <= 0) throw new Error('Every item needs a quantity greater than 0.');
      }

      const res = await fetch(apiUrl('/api/assets/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ items: cleanItems, ...meta })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      onSubmitted();
    } catch (err: any) {
      setError(err.message || 'Could not submit request.');
    } finally {
      setSubmitting(false);
    }
  }

  // Rendered via a portal straight onto document.body — same reason as
  // NewLeaveApplicationModal / NewConveyanceClaimModal: escapes the
  // `overflow-hidden` dashboard ancestor that clips `position: fixed` on a
  // number of Android WebViews. Fills the whole screen (house liquid-glass
  // style, CLAUDE.md), so a long list of items has room on a phone too.
  const field =
    'w-full bg-white/80 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-100 focus:border-violet-400';
  const label = 'block text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1';
  return createPortal(
    <div
      className="fixed inset-0 z-50 liquid-glass-backdrop flex p-2 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.5rem)'
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="new-req-title" className="liquid-glass liquid-glass-in rounded-[32px] flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        <div className="px-5 sm:px-8 pt-5 pb-4 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3 id="new-req-title" className="text-lg font-bold text-slate-900">
              New Requisition
            </h3>
            <p className="text-xs text-slate-500">What you need, why, and how many.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center text-slate-600 disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form id="new-asset-requisition-form" onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-8 pb-4 space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Items ({items.length})</span>
              <button type="button" onClick={addItem} className="text-xs font-semibold text-violet-700 hover:text-violet-900">
                + Add Item
              </button>
            </div>
            <div className="liquid-glass-inset rounded-[24px] divide-y divide-white/70">
              {/* Column header — shown once where the columns sit side by side
                  (md+); below that each field keeps its own label. */}
              <div className="hidden md:grid grid-cols-12 gap-3 px-4 pt-3 pb-1.5">
                <div className="col-span-4 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Item Name</div>
                <div className="col-span-4 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Purpose</div>
                <div className="col-span-2 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Unit</div>
                <div className="col-span-1 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Qty</div>
                <div className="col-span-1" />
              </div>
              {items.map((it, idx) => (
                <div key={idx} className="p-4">
                  <div className="grid grid-cols-12 gap-3">
                    <div className="col-span-12 md:col-span-4">
                      <label className={`${label} md:hidden`}>Item Name</label>
                      <input
                        required
                        value={it.item_name}
                        onChange={(e) => updateItem(idx, { item_name: e.target.value })}
                        placeholder="e.g. Laptop, A4 Paper"
                        aria-label="Item name"
                        className={field}
                      />
                    </div>
                    <div className="col-span-12 md:col-span-4">
                      <label className={`${label} md:hidden`}>Purpose</label>
                      <input
                        required
                        value={it.purpose}
                        onChange={(e) => updateItem(idx, { purpose: e.target.value })}
                        placeholder="Why this item is needed"
                        aria-label="Purpose"
                        className={field}
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className={`${label} md:hidden`}>Unit</label>
                      <UnitPicker required value={it.unit} onChange={(unit) => updateItem(idx, { unit })} className={field} />
                    </div>
                    <div className="col-span-4 md:col-span-1">
                      <label className={`${label} md:hidden`}>Qty</label>
                      <input
                        required
                        type="number"
                        min={0.01}
                        step="any"
                        value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                        aria-label="Quantity"
                        className={field}
                      />
                    </div>
                    <div className="col-span-2 md:col-span-1 flex items-end justify-end">
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          aria-label="Remove item"
                          className="w-9 h-9 rounded-full text-rose-500 hover:bg-rose-50 flex items-center justify-center transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 max-w-xl">
            <div>
              <label className={label}>Urgency</label>
              <select value={meta.urgency} onChange={(e) => setMeta({ ...meta, urgency: e.target.value })} className={field}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className={label}>Target Date</label>
              <input type="date" value={meta.target_date} onChange={(e) => setMeta({ ...meta, target_date: e.target.value })} className={field} />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </form>

        <div className="px-5 sm:px-8 py-4 border-t border-white/70 flex items-center justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="liquid-glass-chip px-5 py-2.5 rounded-full text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="new-asset-requisition-form"
            disabled={submitting}
            className="liquid-glass-button rounded-full px-6 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {submitting ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
