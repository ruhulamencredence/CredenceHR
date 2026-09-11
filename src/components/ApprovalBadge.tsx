import React from 'react';
import { Clock, CheckCircle2, XCircle } from 'lucide-react';
import { ApprovalStatusSummary } from '../types';

// Tiny inline pill shown next to a User's own Check In / Check Out (Attendance
// card, Claim card) so they know where it stands in the Approval Workflow. Renders
// nothing if no chain was configured yet when that event happened — the check-in/
// out itself is never blocked either way, this is purely informational.
export const ApprovalBadge: React.FC<{ approval?: ApprovalStatusSummary | null; label?: string }> = ({ approval, label }) => {
  if (!approval) return null;
  const prefix = label ? `${label}: ` : '';
  if (approval.status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="w-2.5 h-2.5" /> {prefix}Approved
      </span>
    );
  }
  if (approval.status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">
        <XCircle className="w-2.5 h-2.5" /> {prefix}Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
      <Clock className="w-2.5 h-2.5" /> {prefix}Pending approval ({approval.current_step}/{approval.total_steps})
    </span>
  );
};
