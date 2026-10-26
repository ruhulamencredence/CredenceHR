/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Package, Plus, Minus, Trash2, Send, CalendarDays } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { UnitPicker } from './UnitPicker';

// "My Asset" -> "+ New Requisition" — a full-screen sheet (portal) in the
// liquid-glass house style: header, a centred column of item cards (name,
// purpose, unit, quantity stepper), urgency + target date, and a footer that
// stays put. See POST /api/assets/requisitions.

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
  // number of Android WebViews.
  const field =
    'w-full h-11 bg-white border border-slate-200 rounded-2xl px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-4 focus:ring-violet-100 focus:border-violet-400 transition-shadow';
  const label = 'block text-xs font-semibold text-slate-600 mb-1.5';
  const filled = items.filter((it) => it.item_name.trim()).length;
  const URGENCY = [
    { key: 'low', label: 'Low', on: 'bg-emerald-50 border-emerald-300 text-emerald-800', dot: 'bg-emerald-500' },
    { key: 'medium', label: 'Medium', on: 'bg-amber-50 border-amber-300 text-amber-800', dot: 'bg-amber-500' },
    { key: 'high', label: 'High', on: 'bg-rose-50 border-rose-300 text-rose-800', dot: 'bg-rose-500' }
  ];
  const step = (idx: number, by: number) => updateItem(idx, { quantity: Math.max(1, Math.round((Number(items[idx].quantity) || 0) + by)) });
  return createPortal(
    <div
      className="fixed inset-0 z-50 liquid-glass-backdrop flex p-0 sm:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-req-title"
        className="liquid-glass liquid-glass-in sm:rounded-[32px] flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
        // Full screen: a near-white sheet, so the page behind doesn't tint it.
        // The phone's notch / home bar are kept clear inside the sheet.
        style={{
          background: 'linear-gradient(170deg, rgba(255,255,255,0.97) 0%, rgba(248,250,252,0.95) 100%)',
          paddingTop: 'var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))',
          paddingBottom: 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))'
        }}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-slate-200/70">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
            <div className="liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0">
              <Package className="w-5 h-5 text-violet-700" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 id="new-req-title" className="text-lg font-bold text-slate-900 leading-tight">
                New Requisition
              </h3>
              <p className="text-xs text-slate-500">Ask for the items you need — your approver gets it next.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
              className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center text-slate-600 disabled:opacity-40 shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <form id="new-asset-requisition-form" onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-6">
            <section>
              <div className="flex items-baseline justify-between mb-3">
                <h4 className="text-sm font-bold text-slate-900">Items</h4>
                <span className="text-xs text-slate-500">{items.length === 1 ? '1 item' : `${items.length} items`}</span>
              </div>
              <div className="space-y-3">
                {items.map((it, idx) => (
                  <div key={idx} className="rounded-3xl bg-white border border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-3">
                      <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
                        <span className="w-6 h-6 rounded-full bg-violet-100 text-violet-700 text-[11px] font-bold flex items-center justify-center">{idx + 1}</span>
                        Item {idx + 1}
                      </span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          aria-label="Remove item"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-rose-600 px-2 py-1 rounded-full hover:bg-rose-50 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2 sm:col-span-1">
                        <label className={label}>Item name</label>
                        <input
                          required
                          value={it.item_name}
                          onChange={(e) => updateItem(idx, { item_name: e.target.value })}
                          placeholder="e.g. Laptop, A4 paper"
                          aria-label="Item name"
                          className={field}
                        />
                      </div>
                      <div className="col-span-2 sm:col-span-1">
                        <label className={label}>Purpose</label>
                        <input
                          required
                          value={it.purpose}
                          onChange={(e) => updateItem(idx, { purpose: e.target.value })}
                          placeholder="Why it is needed"
                          aria-label="Purpose"
                          className={field}
                        />
                      </div>
                      <div>
                        <label className={label}>Unit</label>
                        <UnitPicker required value={it.unit} onChange={(unit) => updateItem(idx, { unit })} className={field} />
                      </div>
                      <div>
                        <label className={label}>Quantity</label>
                        <div className="flex items-center h-11 bg-white border border-slate-200 rounded-2xl overflow-hidden focus-within:ring-4 focus-within:ring-violet-100 focus-within:border-violet-400">
                          <button type="button" onClick={() => step(idx, -1)} aria-label="Less" className="w-9 sm:w-11 h-full flex items-center justify-center text-slate-500 hover:bg-slate-50 shrink-0">
                            <Minus className="w-4 h-4" />
                          </button>
                          <input
                            required
                            type="number"
                            min={0.01}
                            step="any"
                            value={it.quantity}
                            onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                            aria-label="Quantity"
                            className="flex-1 min-w-0 h-full text-center text-sm font-semibold text-slate-900 bg-transparent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          />
                          <button type="button" onClick={() => step(idx, 1)} aria-label="More" className="w-9 sm:w-11 h-full flex items-center justify-center text-slate-500 hover:bg-slate-50 shrink-0">
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addItem}
                  className="w-full h-12 rounded-3xl border-2 border-dashed border-violet-200 text-violet-700 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-violet-50/60 hover:border-violet-300 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add another item
                </button>
              </div>
            </section>

            <section className="rounded-3xl bg-white border border-slate-200 p-4 sm:p-5">
              <h4 className="text-sm font-bold text-slate-900 mb-3">Details</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <span className={label}>Urgency</span>
                  <div role="radiogroup" aria-label="Urgency" className="grid grid-cols-3 gap-2">
                    {URGENCY.map((u) => {
                      const on = meta.urgency === u.key;
                      return (
                        <button
                          key={u.key}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setMeta({ ...meta, urgency: u.key })}
                          className={`h-11 rounded-2xl border text-sm font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${
                            on ? u.on : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full ${on ? u.dot : 'bg-slate-300'}`} />
                          {u.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className={label} htmlFor="new-req-date">
                    Needed by <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <div className="relative">
                    <CalendarDays className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="new-req-date"
                      type="date"
                      value={meta.target_date}
                      onChange={(e) => setMeta({ ...meta, target_date: e.target.value })}
                      className={`${field} pl-10`}
                    />
                  </div>
                </div>
              </div>
            </section>

            {error && (
              <div className="flex items-center gap-2 text-sm px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-200/70 bg-white/70">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3.5 flex items-center gap-3">
            <span className="hidden sm:block flex-1 text-xs text-slate-500">
              {filled ? `${filled} ${filled === 1 ? 'item' : 'items'} ready to send` : 'Add at least one item'}
            </span>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 sm:flex-none h-11 px-5 sm:px-6 rounded-full text-sm font-semibold whitespace-nowrap text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-asset-requisition-form"
              disabled={submitting}
              className="liquid-glass-button flex-[1.4] sm:flex-none h-11 px-5 sm:px-6 rounded-full text-sm font-semibold whitespace-nowrap inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <Send className="w-4 h-4" />
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
