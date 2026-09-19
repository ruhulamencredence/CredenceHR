/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Wallet, Plus, ChevronRight, Inbox, Paperclip } from 'lucide-react';
import { UserClaim, UserClaimStatus } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';
import { NewConveyanceClaimModal } from './NewConveyanceClaimModal';
import { ConveyanceClaimDetailModal } from './ConveyanceClaimDetailModal';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

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
  // Same isNativeApp split as Timesheet.tsx/LeaveApplication.tsx — the
  // "Main / Conveyance Bill Claim" module-path breadcrumb is a web-only
  // affordance (native app users navigate this same page via the mobile
  // tile menu/bottom nav, so a breadcrumb trail above it is redundant there).
  const isNativeApp = Capacitor.isNativePlatform();
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
    <>
      {!isNativeApp && (
        <div className="px-2 sm:px-0">
          <ModulePath path={['Main', 'Conveyance Bill Claim']} />
        </div>
      )}
    <div className="bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] overflow-hidden md:bg-white md:from-transparent md:via-transparent md:to-transparent md:backdrop-blur-none md:border-slate-200 md:rounded-lg md:shadow-none">
      {/* Top Header — hidden on mobile: the mobile header now shows this
          page's own "Conveyance Bill Claim" title in the logo's place (see
          headerPageTitle.ts in UserPanel.tsx), so repeating it here would be
          a redundant duplicate, and "+ New Claim" already lives in the
          floating pill button at the bottom of the page on mobile. Desktop
          has no such header takeover, so it keeps the full row. */}
      <div className="hidden md:flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <div className="p-1.5 bg-indigo-50 rounded-lg">
          <Wallet className="w-4 h-4 text-indigo-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900">Conveyance Bill Claim</div>
          <div className="text-xs text-slate-400">Submit an expense claim for approval</div>
        </div>
        <button
          type="button"
          onClick={() => setShowNewClaim(true)}
          className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> New Claim
        </button>
      </div>

      {message && <div className="mx-4 mt-2 text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700">{message}</div>}

      {/* Bottom Content — My Conveyance Claims history. Extra top padding on
          mobile since the header row above is hidden there (see above),
          so this doesn't sit flush against the card's rounded top edge. */}
      <div className="px-4 pt-5 md:pt-2 pb-1">
        <div className="text-xs font-semibold text-slate-500">My Conveyance Claims</div>
      </div>

      {/* Review / Approved / Rejected — rounded-pill segmented control
          (matching the reference "Expense Summary" design's switcher): a
          light slate-100 track, the active pill fully filled with the app
          accent color + white text + soft shadow, and a small round count
          badge on every pill (white/25%-on-accent when active,
          slate-200-on-slate-500 when not). */}
      <div className="px-4 pt-1.5 pb-1">
        <div className="flex items-center gap-1.5 rounded-full bg-white/50 md:bg-slate-100 backdrop-blur md:backdrop-blur-none p-1 text-xs font-semibold">
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
        <>
          {/* Mobile — stacked cards. */}
          <div className="md:hidden max-h-72 overflow-y-auto divide-y divide-white/40">
            {filtered.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => setViewingClaim(c)}
                className="w-full text-left px-4 py-2.5 hover:bg-white/40 active:bg-white/60 transition-colors"
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

          {/* Desktop — a real row table instead of the mobile card list, same
              pattern ClaimsPanel.tsx uses for Movement Claims. */}
          <div className="hidden md:block max-h-72 overflow-y-auto overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider sticky top-0">
                <tr>
                  <th className="px-4 py-2.5 text-left">Date</th>
                  <th className="px-4 py-2.5 text-left">Category</th>
                  <th className="px-4 py-2.5 text-left">Amount</th>
                  <th className="px-4 py-2.5 text-left">Attachment</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-left"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setViewingClaim(c)}
                    className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 whitespace-nowrap font-medium text-slate-900 text-xs">{formatDate(c.claim_date)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">{c.category}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">
                      ৳{Number(c.amount).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      {c.has_file ? (
                        <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      <div className="flex items-center gap-1.5">
                        <UserClaimStatusBadge status={c.status} />
                      </div>
                      {c.status === 'pending' && c.approval?.current_approver_name && (
                        <div className="text-[10px] text-amber-600 mt-0.5">
                          Waiting on {c.approval.current_approver_name}
                          {c.approval.total_steps > 1 ? ` (Layer ${c.approval.current_step} of ${c.approval.total_steps})` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 inline-block" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

    </div>

      {/* Floating "New Claim" — mobile only, same style/position as Movement
          Claim's floating "Add Check In/Out" button (bottom-right, sitting
          above BottomNav's fixed bar) instead of the old small header
          button, so the two Claims pages match. z-50 for the same reason
          that one uses it — always paints on top of BottomNav (z-40).
          Deliberately a SIBLING of the card above, not nested inside it —
          the card's own backdrop-blur-xl (liquid glass) makes it a
          containing block for any `position: fixed` descendant per the CSS
          spec (same as `transform`/`filter`), which was pinning this button
          to the CARD's box instead of the viewport and made it drift up/down
          as the card's own height changed with its content. Sitting outside
          the card sidesteps that entirely. */}
      <button
        type="button"
        onClick={() => setShowNewClaim(true)}
        // Liquid glass pill — same translucent gradient + blur + glossy inset
        // highlight + colored drop shadow treatment as Check In/Out's and
        // Submit Leave's floating buttons, instead of the old flat solid
        // color.
        className="md:hidden fixed right-4 z-50 flex items-center gap-1.5 pl-3.5 pr-4 py-2.5 rounded-full text-white text-xs font-semibold backdrop-blur-xl border border-white/40 bg-gradient-to-br from-indigo-400/90 via-indigo-600/90 to-violet-700/90 shadow-[0_10px_28px_-6px_rgba(79,70,229,0.55),inset_0_1px_0_rgba(255,255,255,0.45)] active:scale-95 active:shadow-[0_4px_14px_-4px_rgba(79,70,229,0.5),inset_0_1px_0_rgba(255,255,255,0.3)] transition-all"
        style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <Plus className="w-3.5 h-3.5" /> New Claim
      </button>

      {showNewClaim && (
        <NewConveyanceClaimModal token={token} onClose={() => setShowNewClaim(false)} onSubmitted={handleSubmitted} />
      )}
      {viewingClaim && <ConveyanceClaimDetailModal claim={viewingClaim} onClose={() => setViewingClaim(null)} />}
    </>
  );
};