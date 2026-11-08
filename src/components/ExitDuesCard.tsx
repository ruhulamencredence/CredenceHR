/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Exit / Offboarding -> one exit -> "Dues from other modules"
// (ExitOffboardingRoutes.ts collectExitDues): what the leaving Employee still
// has or owes elsewhere — assets not returned, an active SIM, loan / advance
// balances, open claims and rides. Loan / advance balances can be added to
// the Full & Final Settlement; anything marked "Blocks payment" must be
// cleared before the settlement can be marked Paid. Shown only to accounts
// with the Exit layer "exit_dues" (the server checks it too).

import React, { useEffect, useState } from 'react';
import { Package, Smartphone, Wallet, Receipt, Car, AlertTriangle, CheckCircle2, X, ExternalLink, Plus } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';

export interface ExitDue {
  key: string;
  // 'status' / 'clearance' only come with a refused Paid / Settle (the exit
  // itself: clearance not started, a department not cleared).
  kind: 'asset' | 'sim' | 'loan' | 'loan_request' | 'claim' | 'bill' | 'vehicle' | 'status' | 'clearance';
  label: string;
  detail: string | null;
  amount: number | null;
  blocking: boolean;
  added: boolean;
}

const GROUPS: { kinds: ExitDue['kind'][]; title: string; icon: React.ComponentType<{ className?: string }>; module: string; moduleLabel: string }[] = [
  { kinds: ['asset'], title: 'Assets', icon: Package, module: 'asset_management', moduleLabel: 'Asset Management' },
  { kinds: ['sim'], title: 'Mobile SIM', icon: Smartphone, module: 'mobile_bill', moduleLabel: 'Mobile Bill' },
  { kinds: ['loan', 'loan_request'], title: 'Loans & advances', icon: Wallet, module: 'payroll', moduleLabel: 'Payroll' },
  { kinds: ['claim', 'bill'], title: 'Claims & bills', icon: Receipt, module: 'claims', moduleLabel: 'Claims' },
  { kinds: ['vehicle'], title: 'Vehicle', icon: Car, module: 'vehicle_management', moduleLabel: 'Vehicle Management' }
];

const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const openModule = (key: string) => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: key }));

export const ExitDuesCard: React.FC<{ token: string; exitId: number; settlementPaid: boolean; refreshKey: number; onAdded: () => void }> = ({
  token,
  exitId,
  settlementPaid,
  refreshKey,
  onAdded
}) => {
  const [items, setItems] = useState<ExitDue[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = async () => {
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/exit-requests/${exitId}/dues`), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load dues');
      setItems(data.items || []);
      setPicked(new Set());
    } catch (e: any) {
      setError(e.message);
      setItems([]);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitId, refreshKey]);

  const addable = (items || []).filter((d) => d.kind === 'loan' && !d.added && d.amount);
  const add = async () => {
    const chosen = addable.filter((d) => picked.has(d.key));
    if (!chosen.length) return;
    const total = chosen.reduce((t, d) => t + (d.amount || 0), 0);
    if (!(await confirmDialog(`Add ${taka(total)} (${chosen.length} balance${chosen.length === 1 ? '' : 's'}) to this settlement's outstanding dues? The net payable goes down by the same amount.`, { title: 'Add to settlement', confirmLabel: 'Add', tone: 'default' })))
      return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/exit-requests/${exitId}/settlement/add-dues`), { method: 'POST', headers, body: JSON.stringify({ keys: chosen.map((d) => d.key) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add to the settlement');
      await load();
      onAdded();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const blocking = (items || []).filter((d) => d.blocking).length;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-bold text-slate-700">Dues from other modules</p>
        {items &&
          (blocking ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
              <AlertTriangle className="w-3 h-3" /> {blocking} to clear before payment
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              <CheckCircle2 className="w-3 h-3" /> Nothing blocks payment
            </span>
          ))}
      </div>
      {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
      {!items ? (
        <div className="rounded-xl border border-slate-200 p-3.5 space-y-2 animate-pulse" aria-busy="true" aria-label="Loading dues">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-3.5 py-4 text-center text-xs text-slate-500">No assets, SIM, loans, claims or rides on record for this person.</div>
      ) : (
        <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
          {GROUPS.map((g) => {
            const rows = items.filter((d) => g.kinds.includes(d.kind));
            if (!rows.length) return null;
            const Icon = g.icon;
            return (
              <div key={g.title} className="p-3">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <Icon className="w-3.5 h-3.5" /> {g.title}
                  </span>
                  <button type="button" onClick={() => openModule(g.module)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 hover:text-blue-700">
                    Open {g.moduleLabel} <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {rows.map((d) => {
                    const canPick = d.kind === 'loan' && !d.added && !!d.amount && !settlementPaid;
                    return (
                      <li key={d.key} className="flex items-start gap-2 text-xs">
                        {d.kind === 'loan' && (
                          <input
                            type="checkbox"
                            className="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                            checked={d.added || picked.has(d.key)}
                            disabled={!canPick}
                            onChange={(e) =>
                              setPicked((p) => {
                                const n = new Set(p);
                                if (e.target.checked) n.add(d.key);
                                else n.delete(d.key);
                                return n;
                              })
                            }
                            aria-label={`Add ${d.label} to the settlement`}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-700">{d.label}</div>
                          {d.detail && <div className="text-[11px] text-slate-500">{d.detail}</div>}
                        </div>
                        <div className="text-right shrink-0">
                          {d.amount ? <div className="font-semibold text-slate-800">{taka(d.amount)}</div> : null}
                          {d.added ? (
                            <span className="text-[10px] font-semibold text-emerald-700">In settlement</span>
                          ) : d.blocking ? (
                            <span className="text-[10px] font-semibold text-rose-600">Blocks payment</span>
                          ) : (
                            <span className="text-[10px] text-slate-400">For information</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {addable.length > 0 && !settlementPaid && (
            <div className="p-3 flex items-center justify-between gap-2 bg-slate-50/60">
              <span className="text-[11px] text-slate-500">Tick the loan / advance balances to deduct from the Full &amp; Final Settlement.</span>
              <button
                type="button"
                onClick={add}
                disabled={busy || !addable.some((d) => picked.has(d.key))}
                className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                <Plus className="w-3 h-3" /> Add to settlement
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// "Mark Paid" / "Settled" refused because something is still open elsewhere.
export const DuesBlockedModal: React.FC<{ message: string; items: ExitDue[]; onClose: () => void }> = ({ message, items, onClose }) => (
  <div className="liquid-glass-backdrop fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose} role="presentation">
    <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Can't settle yet">
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" /> Can't settle yet
          </h3>
          <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-4 overflow-y-auto flex-1">
          <p className="text-sm text-slate-600">{items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} still open — finish ${items.length === 1 ? 'it' : 'them'} first:` : message}</p>
          {items.length > 0 && (
            <ul className="liquid-glass-inset rounded-2xl mt-3 px-4 py-3 space-y-2 text-xs">
              {items.map((d) => (
                <li key={d.key}>
                  <div className="font-semibold text-slate-800">{d.label}</div>
                  <div className="text-slate-500">
                    {d.kind === 'loan' ? `Balance ${taka(d.amount || 0)} not added to the settlement` : d.detail}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-5 pb-5">
          <button type="button" onClick={onClose} className="liquid-glass-button w-full rounded-full py-2.5 text-sm font-semibold">
            OK
          </button>
        </div>
      </div>
    </div>
  </div>
);
