/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Wallet, Plus, ChevronRight, Inbox, Paperclip } from 'lucide-react';
import { UserClaim, UserClaimStatus } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';
import { NewConveyanceClaimModal } from './NewConveyanceClaimModal';
import { ConveyanceClaimDetailModal } from './ConveyanceClaimDetailModal';
import { Spinner } from './Spinner';

interface ConveyanceClaimCardProps {
  token: string;
  // Present only on mobile, where this card is one of the tile-menu sections
  // (alongside Budget/Jobs/Entries/Attendance/My Claims) — same "Back to Menu"
  // pattern those cards already use. Omit on desktop, where it's always visible.
  onBack?: () => void;
}

type ClaimTab = UserClaimStatus;

const TABS: { key: ClaimTab; label: string }[] = [
  { key: 'pending', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }
];

// User Panel -> "Conveyance Bill Claim" — a dedicated card (Wallet icon, same
// visual treatment as ClaimCard/MyClaimsCard) that lets a User submit a direct
// expense claim (Claim Date, optional multi-day From/To range, Category, Amount,
// optional Description/attachment) for Admin approval, and browse their own
// submission history with status badges. Top header carries the "+ New Claim"
// action; the body is the "My Conveyance Claims" history list.
export const ConveyanceClaimCard: React.FC<ConveyanceClaimCardProps> = ({ token, onBack }) => {
  const [claims, setClaims] = useState<UserClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewClaim, setShowNewClaim] = useState(false);
  const [viewingClaim, setViewingClaim] = useState<UserClaim | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<ClaimTab>('pending');

  const fetchClaims = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/user-claims/mine'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setClaims(await res.json());
    } catch {
      // Offline/unreachable — just show the empty state below.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClaims();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleSubmitted = () => {
    setShowNewClaim(false);
    setMessage('Claim submitted — it\u2019s now pending Admin review.');
    fetchClaims();
    setTimeout(() => setMessage(null), 4000);
  };

  // Counts for each tab's round badge, and the list filtered to whichever
  // tab is currently selected — same Review/Approved/Rejected split
  // LeaveReviewPage uses for Leave Applications.
  const countFor = (key: ClaimTab) => claims.filter((c) => c.status === key).length;
  const filtered = claims.filter((c) => c.status === tab);
  const emptyLabel =
    tab === 'pending' ? 'Nothing waiting on review.' : tab === 'approved' ? 'No approved claims yet.' : 'No rejected claims.';

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      {/* Top Header Action */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-indigo-50 rounded-lg">
            <Wallet className="w-4 h-4 text-indigo-600" />
          </div>
          <div>
            <div className="text-sm font-medium text-slate-900">Conveyance Bill Claim</div>
            <div className="text-xs text-slate-400">Submit an expense claim for approval</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNewClaim(true)}
          className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" /> New Claim
        </button>
      </div>

      {message && <div className="mx-4 mt-2 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700">{message}</div>}

      {/* Bottom Content — My Conveyance Claims history */}
      <div className="px-4 pt-2 pb-1">
        <div className="text-xs font-semibold text-slate-500">My Conveyance Claims</div>
      </div>

      {/* Review / Approved / Rejected — rounded-pill segmented control
          (matching the reference "Expense Summary" design's switcher): a
          light slate-100 track, the active pill fully filled with the app
          accent color + white text + soft shadow, and a small round count
          badge on every pill (white/25%-on-accent when active,
          slate-200-on-slate-500 when not). */}
      <div className="px-4 pt-1.5 pb-1">
        <div className="flex items-center gap-1.5 rounded-full bg-slate-100 p-1 text-xs font-semibold">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = countFor(t.key);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-full transition-colors ${
                  active ? 'text-white shadow-sm bg-indigo-600' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {t.label}
                <span
                  className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                    active ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-7">
          <Spinner size={20} className="text-slate-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 text-center py-7 px-4 text-slate-400">
          <Inbox className="w-5 h-5 text-slate-300" />
          <p className="text-sm">
            {tab === 'pending' && claims.length === 0
              ? 'No claims submitted yet — tap + New Claim to submit your first one.'
              : emptyLabel}
          </p>
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
          {filtered.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => setViewingClaim(c)}
              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 active:bg-slate-100 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                    {formatDate(c.claim_date)}
                    {c.has_file && <Paperclip className="w-3 h-3 text-slate-400 shrink-0" />}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {c.category} &middot; ৳{Number(c.amount).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  {c.status === 'pending' && c.approval?.current_approver_name && (
                    <div className="text-[11px] text-amber-600 mt-0.5">
                      Waiting on {c.approval.current_approver_name}
                      {c.approval.total_steps > 1 ? ` (Layer ${c.approval.current_step} of ${c.approval.total_steps})` : ''}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <UserClaimStatusBadge status={c.status} />
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {showNewClaim && (
        <NewConveyanceClaimModal token={token} onClose={() => setShowNewClaim(false)} onSubmitted={handleSubmitted} />
      )}
      {viewingClaim && <ConveyanceClaimDetailModal claim={viewingClaim} onClose={() => setViewingClaim(null)} />}
    </div>
  );
};