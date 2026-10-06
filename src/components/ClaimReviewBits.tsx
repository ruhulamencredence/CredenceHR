/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pieces every approver screen (PendingApprovalsCard, ApproveApplications,
// Admin Panel -> Approvals) shows on a Conveyance Bill Claim:
//   - what the employee changed since the last Return/Reject (or since they
//     first submitted it), from claim_changes on the approvals list;
//   - the "Allow re-claim" tick that goes with Reject;
//   - the Return button (send it back for correction).
// The rules behind them are in the Bill Claim Policy (Editing & review) and
// ConveyanceClaimHistory.ts.

import React from 'react';
import { History, RotateCcw } from 'lucide-react';

export interface ClaimReviewFields {
  claim_version?: number;
  claim_change_note?: string | null;
  claim_changes?: string[];
  claim_allow_return?: boolean;
  claim_allow_reclaim?: boolean;
}

export const ClaimChangesNotice: React.FC<{ item: ClaimReviewFields; className?: string }> = ({ item, className = '' }) => {
  if (!item.claim_change_note) return null;
  return (
    <div className={`rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 ${className}`}>
      <div className="font-semibold flex items-center gap-1">
        <History className="w-3.5 h-3.5" /> {item.claim_change_note}
      </div>
      {(item.claim_changes || []).length > 0 ? (
        <ul className="mt-1 space-y-0.5 list-disc pl-4">
          {item.claim_changes!.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5">No change to the bills.</p>
      )}
    </div>
  );
};

export const ReclaimTick: React.FC<{ item: ClaimReviewFields; checked: boolean; onChange: (v: boolean) => void }> = ({ item, checked, onChange }) => {
  if (!item.claim_allow_reclaim) return null;
  return (
    <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-rose-600" />
      If rejecting: allow re-claim (the employee may edit and resubmit it)
    </label>
  );
};

export const ReturnButton: React.FC<{ item: ClaimReviewFields; disabled?: boolean; onClick: () => void; compact?: boolean }> = ({
  item,
  disabled,
  onClick,
  compact
}) => {
  if (!item.claim_allow_return) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title="Send back to the employee to correct — needs a reason in Remarks"
      className={`${compact ? '' : 'flex-1'} text-xs font-semibold px-3 py-2 rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1`}
    >
      <RotateCcw className="w-3.5 h-3.5" /> Return
    </button>
  );
};
