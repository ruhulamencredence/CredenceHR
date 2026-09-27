/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Car, Package, ChevronRight } from 'lucide-react';
import { useActiveRides, ACTIVE_LABEL } from './BookRideCard';
import { useMyAssetSummary } from './MyAssetCard';
import { BookRideTarget, MyAssetTarget } from '../lib/quickAccess';

interface MobileQuickAccessProps {
  token: string;
  userId: number;
  onOpenBookRide: (target: BookRideTarget) => void;
  onOpenMyAsset: (target: MyAssetTarget) => void;
}

// Mobile Dashboard quick access — Book a Ride and My Asset as two tiles side
// by side, in the same liquid-glass surface as the Leave Summary card above
// them. Each tile's second line is live: the current ride's status, or the
// assets waiting on this account.
export const MobileQuickAccess: React.FC<MobileQuickAccessProps> = ({ token, userId, onOpenBookRide, onOpenMyAsset }) => {
  const rides = useActiveRides(token, userId);
  const assets = useMyAssetSummary(token);
  const ride = rides && rides.length > 0 ? rides[0] : null;

  const tiles = [
    {
      key: 'ride',
      title: 'Book a Ride',
      icon: Car,
      onClick: () => onOpenBookRide(ride ? 'status' : 'book'),
      line: ride ? ACTIVE_LABEL[ride.status].text : 'Where are you going?',
      lineClass: ride ? 'text-emerald-700' : 'text-slate-500'
    },
    {
      key: 'asset',
      title: 'My Asset',
      icon: Package,
      onClick: () => onOpenMyAsset('my-assets'),
      line: !assets
        ? 'Your assets & requests'
        : assets.awaitingAck > 0
          ? `${assets.awaitingAck} awaiting your Ack`
          : `${assets.held} held · ${assets.openRequests} open`,
      lineClass: assets && assets.awaitingAck > 0 ? 'text-amber-700' : 'text-slate-500'
    }
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={t.onClick}
          className="glass-mask-fix relative rounded-[22px] overflow-hidden border border-white/70 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 p-3.5 text-left active:scale-[0.98] transition-transform"
        >
          <div className="flex items-center justify-between">
            <span className="w-9 h-9 rounded-full flex items-center justify-center text-white" style={{ background: 'var(--g-gradient)' }}>
              <t.icon className="w-[18px] h-[18px]" />
            </span>
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 text-sm font-bold text-slate-900">{t.title}</div>
          <div className={`text-[11px] truncate ${t.lineClass}`}>{t.line}</div>
        </button>
      ))}
    </div>
  );
};
