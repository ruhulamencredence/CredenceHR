/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Clock, CheckCircle2, XCircle } from 'lucide-react';
import { UserClaimStatus } from '../types';

// Same tiny-pill visual treatment as ApprovalBadge.tsx (Attendance/Movement Claim
// approval trail), reused here for a Conveyance Bill Claim's simpler Pending /
// Approved / Rejected status — this isn't a multi-step chain, just one Admin
// decision, so it renders straight from `status` rather than an ApprovalStatusSummary.
export const UserClaimStatusBadge: React.FC<{ status: UserClaimStatus }> = ({ status }) => {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-2.5 h-2.5" /> Approved
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
        <XCircle className="w-2.5 h-2.5" /> Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
      <Clock className="w-2.5 h-2.5" /> Pending
    </span>
  );
};
