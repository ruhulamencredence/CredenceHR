/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Package, Plus, ChevronRight } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { MyAssetTarget } from '../lib/quickAccess';

interface MyAssetCardProps {
  token: string;
  onOpen: (target: MyAssetTarget) => void;
  className?: string;
}

export interface MyAssetSummary {
  held: number;
  awaitingAck: number;
  openRequests: number;
}

// Counts behind the My Asset quick access card/tile: assets held, ones still
// waiting for this account's acknowledgement, and requisitions not yet closed.
export function useMyAssetSummary(token: string): MyAssetSummary | null {
  const [summary, setSummary] = useState<MyAssetSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(apiUrl('/api/assets/my'), { headers }).then((r) => (r.ok ? r.json() : [])),
      fetch(apiUrl('/api/assets/requisitions/my'), { headers }).then((r) => (r.ok ? r.json() : []))
    ])
      .then(([assets, requisitions]) => {
        if (cancelled) return;
        const a = Array.isArray(assets) ? assets : [];
        const r = Array.isArray(requisitions) ? requisitions : [];
        setSummary({
          held: a.length,
          awaitingAck: a.filter((x: any) => !x.acknowledged_at && !x.pending_claim).length,
          openRequests: r.filter((x: any) => ['pending', 'manager_approved', 'approved', 'dispatched'].includes(x.status)).length
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);
  return summary;
}

// Web Dashboard quick access to My Asset (AssetManagement.tsx).
export const MyAssetCard: React.FC<MyAssetCardProps> = ({ token, onOpen, className = '' }) => {
  const summary = useMyAssetSummary(token);
  const stats: { label: string; value: number | null; target: MyAssetTarget; warn?: boolean }[] = [
    { label: 'Assets held', value: summary?.held ?? null, target: 'my-assets' },
    { label: 'Awaiting your Ack', value: summary?.awaitingAck ?? null, target: 'my-assets', warn: true },
    { label: 'Open requests', value: summary?.openRequests ?? null, target: 'status' }
  ];

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Package className="w-4 h-4 text-blue-600" /> My Asset
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">What you hold and what you've requested</p>
        </div>
        <button type="button" onClick={() => onOpen('status')} className="text-xs font-medium text-blue-600 hover:underline shrink-0">
          Status
        </button>
      </div>

      <div className="p-5 sm:px-6 space-y-3 flex-1">
        <div className="grid grid-cols-3 gap-2">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onOpen(s.target)}
              className="rounded-xl border border-slate-200 px-2 py-2.5 text-center hover:bg-slate-50 transition-colors"
            >
              <div className={`text-lg font-bold ${s.warn && s.value ? 'text-amber-600' : 'text-slate-900'}`}>{s.value ?? '–'}</div>
              <div className="text-[11px] text-slate-500 leading-tight">{s.label}</div>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onOpen('new')}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-slate-50 border border-slate-200 text-left hover:border-blue-300 hover:bg-white transition-colors"
        >
          <Plus className="w-5 h-5 text-blue-600 shrink-0" />
          <span className="flex-1 text-sm text-slate-600">New requisition</span>
          <ChevronRight className="w-4 h-4 text-slate-400" />
        </button>
      </div>
    </div>
  );
};
