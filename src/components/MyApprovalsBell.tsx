/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, CheckCircle2, XCircle } from 'lucide-react';
import { ApprovalRequest } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface MyApprovalsBellProps {
  token: string;
}

const REQUEST_TYPE_LABEL: Record<string, string> = {
  user_claim: 'Conveyance Bill Claim',
  leave: 'Leave Application',
  attendance_correction: 'Timesheet Edit',
  attendance: 'Attendance/Movement Claim'
};

// Approver role is loosened company-wide — any logged-in account (including a
// plain 'user') can be placed on an Approval Workflow Template step. Someone
// like that never gets the Admin Panel's "approvals" module, so this is their
// entire way of seeing and acting on their own pending queue: a bell next to
// AlertsBell, rendered only when the account has no module access to the full
// Approvals screen (see Navbar.tsx). Superadmins/Admins with the module
// already have the richer ApprovalManager screen and don't need this too.
export const MyApprovalsBell: React.FC<MyApprovalsBellProps> = ({ token }) => {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);

  const fetchMine = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/approvals/mine'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data: ApprovalRequest[] = await res.json();
        setItems(data);
        setCount(data.length);
      }
    } catch {
      // Offline or server unreachable — badge just stays stale until next poll.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchMine();
    const interval = setInterval(fetchMine, 30000);
    return () => clearInterval(interval);
  }, [fetchMine]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useBackButtonClose(open, () => setOpen(false));

  const act = async (id: number, action: 'approved' | 'rejected') => {
    setActingId(id);
    try {
      const res = await fetch(apiUrl(`/api/approvals/${id}/act`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, remarks: remarksDraft[id] || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record your decision.');
      setItems((prev) => prev.filter((r) => r.id !== id));
      setCount((prev) => Math.max(0, prev - 1));
    } catch (err: any) {
      window.alert(err.message || 'Failed to record your decision.');
    } finally {
      setActingId(null);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:opacity-70"
        style={{ color: 'var(--g-text-muted)' }}
        title="My Approvals"
        aria-label="My Approvals"
      >
        <ClipboardCheck className="w-[18px] h-[18px]" />
        {count > 0 && (
          <span
            className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            style={{ background: '#2563eb' }}
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-2xl shadow-lg border overflow-hidden z-50"
          style={{ background: 'var(--g-surface, #fff)', borderColor: 'var(--g-border, #e5e7eb)' }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--g-border, #e5e7eb)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--g-text)' }}>
              My Approvals
            </span>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--g-text-muted)' }}>
                <Spinner size={16} className="mx-auto" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--g-text-muted)' }}>
                Nothing waiting on you right now.
              </div>
            ) : (
              items.map((r) => (
                <div key={r.id} className="px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--g-border, #e5e7eb)' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--g-accent)' }}>
                    {REQUEST_TYPE_LABEL[r.source_type] || r.source_type} \u2014 Step {r.current_step}/{r.total_steps}
                  </div>
                  <div className="text-sm font-medium mt-0.5" style={{ color: 'var(--g-text)' }}>
                    {r.source_label}
                    {r.source_amount != null ? ` \u2014 \u09f3${r.source_amount}` : ''}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--g-text-muted)' }}>
                    By {r.requested_by_name || '(account removed)'} \u2022 {formatDate(r.created_at)}
                  </div>
                  <textarea
                    value={remarksDraft[r.id] || ''}
                    onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder="Remarks (optional)"
                    rows={1}
                    className="w-full mt-2 text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      disabled={actingId === r.id}
                      onClick={() => act(r.id, 'approved')}
                      className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      disabled={actingId === r.id}
                      onClick={() => act(r.id, 'rejected')}
                      className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
