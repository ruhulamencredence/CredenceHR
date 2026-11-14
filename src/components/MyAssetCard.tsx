/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveTick, RECORDS_CHANGED_EVENT } from '../lib/liveRefresh';
import { NewAssetRequisitionModal } from './NewAssetRequisitionModal';
import { useCachedState } from '../lib/screenCache';
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
  // Last copy from this device first (screenCache.ts), then the fresh counts.
  const [summary, setSummary] = useCachedState<MyAssetSummary | null>('asset-summary', null);
  // Live refresh: counts update without a page reload.
  const liveTick = useLiveTick();
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
  }, [token, liveTick]);
  return summary;
}

// Web Dashboard quick access to My Asset (AssetManagement.tsx).
// Card background: office things standing on a shelf (a monitor, a laptop,
// a printer, a chair) drawn as faint outlines in the bottom-right corner,
// fading out to the left. Colours from .ast-shelf in index.css (light and
// dark). Decorative only.
const AssetShelfBg: React.FC = () => (
  <svg
    className="ast-shelf absolute inset-0 w-full h-full pointer-events-none"
    viewBox="0 0 342 259"
    preserveAspectRatio="xMaxYMax slice"
    aria-hidden="true"
    style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent 40%, #000 85%)', maskImage: 'linear-gradient(90deg, transparent 40%, #000 85%)' }}
  >
    <rect width="342" height="259" fill="var(--as-fill)" />
    <g fill="none" stroke="var(--as-line)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* monitor */}
      <g transform="translate(236,240) scale(.68)">
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M8 20h8M12 16v4" />
      </g>
      {/* laptop */}
      <g transform="translate(258,241) scale(.64)">
        <rect x="4" y="5" width="16" height="11" rx="1.5" />
        <path d="M2 19h20" />
      </g>
      {/* printer */}
      <g transform="translate(278,240) scale(.68)">
        <path d="M7 9V3h10v6" />
        <rect x="4" y="9" width="16" height="8" rx="1.5" />
        <path d="M7 14h10v7H7z" />
      </g>
      {/* chair */}
      <g transform="translate(298,240) scale(.68)">
        <path d="M7 3h10v9H7z" />
        <path d="M6 12h12M8 12v9M16 12v9" />
      </g>
    </g>
    <path d="M226 256.5 H350" stroke="var(--as-line)" strokeWidth="2" />
  </svg>
);

export const MyAssetCard: React.FC<MyAssetCardProps> = ({ token, onOpen, className = '' }) => {
  const [showNew, setShowNew] = useState(false);
  const summary = useMyAssetSummary(token);
  const stats: { label: string; value: number | null; target: MyAssetTarget; warn?: boolean }[] = [
    { label: 'Assets held', value: summary?.held ?? null, target: 'my-assets' },
    { label: 'Awaiting your Ack', value: summary?.awaitingAck ?? null, target: 'my-assets', warn: true },
    { label: 'Open requests', value: summary?.openRequests ?? null, target: 'status' }
  ];

  return (
    <div className={`relative bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col ${className}`}>
      <AssetShelfBg />
      <div className="relative px-5 pt-5 pb-4 sm:px-6 flex items-start justify-between gap-3">
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

      <div className="relative p-5 pt-1 sm:px-6 space-y-3 flex-1">
        <div className="grid grid-cols-3 gap-2">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onOpen(s.target)}
              className="rounded-xl bg-white/80 backdrop-blur-sm border border-slate-200 px-2 py-2.5 text-center hover:bg-white transition-colors"
            >
              <div className={`text-lg font-bold ${s.warn && s.value ? 'text-amber-600' : 'text-slate-900'}`}>{s.value ?? '–'}</div>
              <div className="text-[11px] text-slate-500 leading-tight">{s.label}</div>
            </button>
          ))}
        </div>
        <button
          type="button"
          // The New Requisition popup opens right here on the Dashboard; on
          // submit the counts above refresh (no trip to the My Asset page).
          onClick={() => setShowNew(true)}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-white/80 backdrop-blur-sm border border-slate-200 text-left hover:border-blue-300 hover:bg-white transition-colors"
        >
          <Plus className="w-5 h-5 text-blue-600 shrink-0" />
          <span className="flex-1 text-sm text-slate-600">New requisition</span>
          <ChevronRight className="w-4 h-4 text-slate-400" />
        </button>
      </div>
      {showNew && (
        <NewAssetRequisitionModal
          onClose={() => setShowNew(false)}
          onSubmitted={() => {
            setShowNew(false);
            // The counts (Open requests…) and any other screen listening refresh now.
            window.dispatchEvent(new CustomEvent(RECORDS_CHANGED_EVENT, { detail: { type: 'asset_requisition', related_type: 'asset_requisition', related_id: null } }));
          }}
        />
      )}
    </div>
  );
};
