/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ClipboardList, Route, CreditCard, CalendarClock, Clock, ChevronRight } from 'lucide-react';
import { LeaveApplication, ClaimRecord, UserClaim, AttendanceCorrection } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

// Which UserPanel section a row opens — same values goToMobileSection takes
// (these four drive the page on desktop too, not just mobile; see
// showingClaimsPage in UserPanel.tsx).
export type MyRequestTarget = 'claim' | 'conveyanceClaim' | 'leave' | 'timesheet';

interface MyRequestsCardProps {
  token: string;
  // Each source endpoint is module-gated server-side
  // (requireMovementClaimAccess / requireConveyanceClaimAccess /
  // requireTimesheetAccess), so a source this account isn't granted is never
  // fetched at all rather than fetched and 403'd. Leave Applications have no
  // such gate — every account can have them — so they're always fetched.
  canSeeMovementClaim: boolean;
  canSeeConveyanceClaim: boolean;
  canSeeTimesheet: boolean;
  onOpen: (target: MyRequestTarget) => void;
  // Applied to this card's own root, for the Dashboard grid's column span.
  className?: string;
}

// 'open' only ever comes from a Movement Claim — the one source here that
// isn't approval-reviewed at all (see the mapping below).
type RowStatus = 'pending' | 'approved' | 'rejected' | 'open';

interface RequestRow {
  key: string;
  target: MyRequestTarget;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  // Sorted on, and shown on the right of the row. Either a plain 'YYYY-MM-DD'
  // or a full ISO timestamp depending on the source, so anything comparing
  // these slices to the date part first.
  date: string;
  status: RowStatus;
  // Who/what it's sitting with while still pending — the whole reason to look
  // at this card rather than each feature's own page.
  waitingOn?: string | null;
}

const STATUS_STYLES: Record<RowStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  approved: { label: 'Approved', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  open: { label: 'Open', className: 'bg-blue-50 text-blue-700 border-blue-200' }
};

// A request still waiting on somebody — sorted to the top, and counted in the
// header pill.
const isWaiting = (status: RowStatus) => status === 'pending' || status === 'open';

// How many rows the card shows before it stops and points at the full pages.
const MAX_ROWS = 6;

// Dashboard "My Requests" — every request this account has submitted, across
// all four workflows that have one (Leave Application, Movement Claim,
// Conveyance Bill Claim, Timesheet Correction), in one list with its current
// status. Each of those already has its own page showing its own history;
// what none of them could answer was the question an employee actually asks
// ("I submitted things — where are they stuck?"), which meant opening four
// pages to find out. Read-only on purpose: acting on a request belongs on
// that request's own page, which a row opens.
export const MyRequestsCard: React.FC<MyRequestsCardProps> = ({
  token,
  canSeeMovementClaim,
  canSeeConveyanceClaim,
  canSeeTimesheet,
  onOpen,
  className = ''
}) => {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // A source that's unreachable (offline) or not granted just contributes
    // nothing — one failing workflow shouldn't blank out the other three.
    const fetchMine = async <T,>(path: string, enabled: boolean): Promise<T[]> => {
      if (!enabled) return [];
      try {
        const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    };

    (async () => {
      const [leaves, claims, conveyance, corrections] = await Promise.all([
        fetchMine<LeaveApplication>('/api/leave-applications/mine', true),
        fetchMine<ClaimRecord>('/api/claims/mine', canSeeMovementClaim),
        fetchMine<UserClaim>('/api/user-claims/mine', canSeeConveyanceClaim),
        fetchMine<AttendanceCorrection>('/api/attendance/corrections/mine', canSeeTimesheet)
      ]);
      if (cancelled) return;

      const collected: RequestRow[] = [
        ...leaves.map((a) => ({
          key: `leave-${a.id}`,
          target: 'leave' as const,
          icon: CalendarClock,
          title: 'Leave Application',
          detail: `${a.leave_type_label || a.leave_type} · ${a.day_count} ${a.day_count === 1 ? 'Day' : 'Days'}`,
          date: a.apply_date,
          status: a.status,
          // A Leave Application waits on its Reliever FIRST and only reaches
          // the Approval Workflow once they've approved (see
          // NewLeaveApplicationModal.tsx), so naming the approver while it's
          // still with the Reliever would point at the wrong person.
          waitingOn:
            a.status !== 'pending'
              ? null
              : a.reliever_status === 'pending'
              ? `Reliever${a.reliever_name ? ` · ${a.reliever_name}` : ''}`
              : a.approver_name
              ? `${a.approver_name}${a.total_steps ? ` · Layer ${a.current_step} of ${a.total_steps}` : ''}`
              : null
        })),
        // Only STILL-OPEN Movement Claims. Unlike the other three, a Movement
        // Claim is never routed through the Approval Chain at all (no
        // approval_requests row is ever created for source_type 'claim' — see
        // POST /api/claims/check-in in server.ts), so a completed one has no
        // decision to wait on and is just history, which My Claims already
        // lists in full. An OPEN one is the part worth surfacing here: it
        // means this account checked in and hasn't checked out yet.
        ...claims
          .filter((c) => c.status === 'open')
          .map((c) => ({
            key: `claim-${c.id}`,
            target: 'claim' as const,
            icon: Route,
            title: 'Movement Claim',
            detail: `${c.purpose} · not checked out yet`,
            date: c.check_in_at,
            status: 'open' as const,
            waitingOn: null
          })),
        ...conveyance.map((c) => ({
          key: `conveyance-${c.id}`,
          target: 'conveyanceClaim' as const,
          icon: CreditCard,
          title: 'Conveyance Bill Claim',
          detail: `${c.category} · ৳${Number(c.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}`,
          date: c.claim_date,
          status: c.status,
          waitingOn: null
        })),
        ...corrections.map((c) => ({
          key: `correction-${c.id}`,
          target: 'timesheet' as const,
          icon: Clock,
          title: 'Timesheet Correction',
          detail: `For ${formatDate(c.attendance_date)}`,
          date: c.created_at || c.attendance_date,
          status: c.status,
          waitingOn: c.status === 'pending' ? c.approval?.current_approver_name || null : null
        }))
      ];

      // Whatever is still waiting comes first — that's what this card is for —
      // and within each half, most recent first.
      collected.sort((a, b) => {
        const waitDiff = (isWaiting(a.status) ? 0 : 1) - (isWaiting(b.status) ? 0 : 1);
        if (waitDiff !== 0) return waitDiff;
        return b.date.slice(0, 10).localeCompare(a.date.slice(0, 10));
      });

      setRows(collected);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [token, canSeeMovementClaim, canSeeConveyanceClaim, canSeeTimesheet]);

  const waitingCount = rows.filter((r) => isWaiting(r.status)).length;
  const visible = rows.slice(0, MAX_ROWS);

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-blue-600" /> My Requests
          {waitingCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-white text-[11px] font-bold">
              {waitingCount}
            </span>
          )}
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">
          {waitingCount > 0
            ? `${waitingCount} of your requests ${waitingCount === 1 ? 'is' : 'are'} still waiting on a decision.`
            : "Everything you've submitted, and where it stands."}
        </p>
      </div>

      {loading ? (
        <div className="divide-y divide-slate-100 animate-pulse">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-5 py-3.5 sm:px-6">
              <div className="h-3.5 w-40 bg-slate-100 rounded" />
              <div className="h-3 w-24 bg-slate-100 rounded mt-2" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 sm:px-6 text-center">
          <p className="text-sm text-slate-500">Nothing submitted yet.</p>
          <p className="text-xs text-slate-400 mt-1">
            Leave Applications, Claims and Timesheet Corrections you submit will show up here with their status.
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-slate-100">
            {visible.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => onOpen(row.target)}
                className="w-full px-5 py-3.5 sm:px-6 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
              >
                <row.icon className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900 truncate">{row.title}</div>
                  <div className="text-xs text-slate-500 truncate mt-0.5">{row.detail}</div>
                  {row.waitingOn && (
                    <div className="text-[11px] text-amber-700 truncate mt-0.5">With {row.waitingOn}</div>
                  )}
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLES[row.status].className}`}
                  >
                    {STATUS_STYLES[row.status].label}
                  </span>
                  <span className="text-[10px] text-slate-400 whitespace-nowrap">{formatDate(row.date)}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              </button>
            ))}
          </div>

          {rows.length > MAX_ROWS && (
            <div className="px-5 py-2.5 sm:px-6 border-t border-slate-100 text-[11px] text-slate-400">
              Showing the {MAX_ROWS} most relevant of {rows.length} — open a request above for its full history.
            </div>
          )}
        </>
      )}
    </div>
  );
};
