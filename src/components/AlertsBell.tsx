/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { BellRing, Check, Trash2, X } from 'lucide-react';
import { Alert } from '../types';
import { MyAssetTarget } from '../lib/quickAccess';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface AlertsBellProps {
  token: string;
  // Clicking a 'leave_application' alert jumps straight to the Leave
  // Application self-service page (same destination the "Self Service" menu
  // in Navbar already points at) — optional so this component still works
  // standing alone if nothing wires it up.
  onOpenLeaveApplication?: () => void;
  // 'vehicle_approval' = a ride request waiting on this account (approve, or
  // assign a vehicle on a Vehicle Maintainer Layer) -> Approve Application.
  // 'vehicle_requisition' = the requester's own ride updates -> Book a Ride.
  onOpenApproveApplications?: () => void;
  onOpenVehicleManagement?: () => void;
  // The claimant's own Conveyance Bill Claim updates -> Conveyance Bill Claim.
  onOpenConveyanceClaim?: () => void;
  // The requester's own Asset Requisition updates -> My Asset (Status for
  // the requisition's approval updates, My Assets for handed-over items).
  onOpenMyAsset?: (target: MyAssetTarget) => void;
  // The employee's own resignation updates -> My Resignation.
  onOpenResignation?: () => void;
  // Grievance / Disciplinary alerts open Self Service -> Grievance & Disciplinary.
  onOpenMyCases?: () => void;
  // HR Operations: a letter issued to this account -> My Letters; HR-side
  // updates (a letter acknowledged/requested, an action decided) -> the
  // HR Operations module.
  onOpenMyLetters?: () => void;
  onOpenHrOperations?: () => void;
  // Dropdown footer "View all" link — opens AlertsPage.tsx (the full-page
  // inbox), since this dropdown itself only ever shows the 50 most recent.
  onViewAll?: () => void;
}

// Personal Alerts inbox — same component renders in the shared Navbar on
// both the web build and the Capacitor mobile app, since they run the exact
// same React code. On by default for every account (no module grant needed,
// unlike the Admin Panel tabs). Polls the lightweight unread-count endpoint
// so the badge stays current without re-fetching the whole list constantly;
// the full list is only fetched when the dropdown is actually opened.
export const AlertsBell: React.FC<AlertsBellProps> = ({ token, onOpenLeaveApplication, onOpenApproveApplications, onOpenVehicleManagement, onOpenConveyanceClaim, onOpenMyAsset, onOpenResignation, onOpenMyCases, onOpenMyLetters, onOpenHrOperations, onViewAll }) => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  // Starts true so the first open shows "Loading..." rather than flashing
  // "No alerts yet." for the render before fetchAlerts kicks in.
  const [loading, setLoading] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // The phone sheet is portalled to <body>, so outside-click checks both.
  const sheetRef = useRef<HTMLDivElement>(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/alerts/unread-count'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      setUnreadCount(Number(data?.count || 0));
    } catch {
      // Offline or server unreachable — silently skip, retried on next poll.
    }
  }, [token]);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/alerts'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setAlerts(await res.json());
    } catch {
      // Offline or server unreachable — dropdown just stays empty/stale.
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Poll the badge every 30s regardless of whether the dropdown is open, plus
  // once immediately on mount.
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  useEffect(() => {
    if (open) fetchAlerts();
  }, [open, fetchAlerts]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || sheetRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useBackButtonClose(open, () => setOpen(false));

  const markRead = async (id: number) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, is_read: true } : a)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await fetch(apiUrl(`/api/alerts/${id}/read`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Best-effort — a failed mark-read just means it may show unread again
      // next refresh, which is harmless.
    }
  };

  const markAllRead = async () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
    setUnreadCount(0);
    try {
      await fetch(apiUrl('/api/alerts/read-all'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Best-effort, same as markRead above.
    }
  };

  const removeAlert = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasUnread = alerts.find((a) => a.id === id)?.is_read === false;
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await fetch(apiUrl(`/api/alerts/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Best-effort, same as markRead above.
    }
  };

  const handleAlertClick = (alert: Alert) => {
    if (!alert.is_read) markRead(alert.id);
    const target =
      alert.type === 'leave_application'
        ? onOpenLeaveApplication
        : alert.type === 'vehicle_approval' || alert.type === 'leave_approval' || alert.type === 'conveyance_approval' || alert.type === 'asset_approval' || alert.type === 'exit_clearance' || alert.type === 'mobile_limit_approval'
        ? onOpenApproveApplications
        : alert.type === 'vehicle_requisition'
        ? onOpenVehicleManagement
        : alert.type === 'conveyance_claim' || alert.type === 'conveyance_disbursed'
        ? onOpenConveyanceClaim
        : alert.type === 'asset_requisition' && onOpenMyAsset
        ? () => onOpenMyAsset(alert.related_type === 'asset_requisition' ? 'status' : 'my-assets')
        : alert.type === 'resignation'
        ? onOpenResignation
        : alert.type === 'grievance' || alert.type === 'disciplinary'
        ? onOpenMyCases
        : alert.type === 'hr_action'
        ? /Awaiting Your Approval/.test(alert.title)
          ? onOpenApproveApplications
          : onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' })))
        : alert.type === 'hr_request'
        ? /^Submitted for review/.test(alert.title)
          ? () => {
              // HR: Employee Reports -> Requests.
              try {
                sessionStorage.setItem('hr_ops_tab', 'reports');
                sessionStorage.setItem('hr_reports_view', 'requests');
              } catch {
                // storage unavailable
              }
              (onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' }))))();
              setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: 'reports' })), 0);
            }
          : onOpenMyLetters
          ? () => {
              // Employee: My Letters & Service Record -> Pending Items.
              try {
                sessionStorage.setItem('my_letters_tab', 'pending');
              } catch {
                // storage unavailable
              }
              onOpenMyLetters();
            }
          : undefined
        : alert.type === 'hr_report'
        ? () => {
            // HR Operations -> Employee Reports -> Received.
            try {
              sessionStorage.setItem('hr_ops_tab', 'reports');
              sessionStorage.setItem('hr_reports_view', 'received');
            } catch {
              // storage unavailable — opens on the default tab
            }
            (onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' }))))();
            setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: 'reports' })), 0);
          }
        : alert.type === 'task'
        ? // My Tasks / Task Management, with this task open (App.tsx).
          () => {
            try {
              if (alert.related_id) sessionStorage.setItem('open_task_id', String(alert.related_id));
            } catch {
              // storage unavailable — the page opens without the task
            }
            window.dispatchEvent(new CustomEvent('credence:open-task', { detail: { title: alert.title } }));
          }
        : alert.type === 'mobile_bill'
        ? // My Mobile SIM, or HR's Mobile Bill for a request with no approval chain (App.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-mobile-bill', { detail: { title: alert.title } }))
        : alert.type === 'device_request'
        ? // Superadmin: Admin Panel -> Device Access, to approve the new phone.
          () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'devices' }))
        : alert.type === 'site_attendance'
        ? () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'teamAttendance' }))
        : alert.type === 'hr_letter'
        ? /^New Letter|Request Rejected$/.test(alert.title)
          ? onOpenMyLetters
          : onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' })))
        : undefined;
    if (target) {
      setOpen(false);
      target();
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:opacity-70"
        style={{ color: 'var(--g-text-muted)' }}
        title="Alerts"
        aria-label="Alerts"
      >
        <BellRing className="w-[18px] h-[18px]" />
        {unreadCount > 0 && (
          <span
            className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            style={{ background: '#dc2626' }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Phones: a liquid-glass sheet (the house popup style — see
          CLAUDE.md / TrackingNoticeCard.tsx) under the header, each alert a
          glass well with a dot while unread. Portalled to <body> so its
          full-screen backdrop isn't clipped by the header. */}
      {open &&
        createPortal(
          <div className="sm:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Alerts">
            <div className="absolute inset-0 liquid-glass-backdrop" />
            <div
              ref={sheetRef}
              className="absolute left-3 right-3"
              style={{ top: 'calc(4.25rem + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))' }}
            >
              <div className="liquid-glass liquid-glass-in rounded-[32px] flex flex-col max-h-[calc(100dvh-10rem)] overflow-hidden">
                <div className="flex items-center gap-2 px-5 pt-4 pb-3">
                  <h3 className="text-base font-bold text-slate-900 flex-1">
                    Alerts
                    {unreadCount > 0 && <span className="ml-2 text-xs font-semibold text-rose-600">{unreadCount} new</span>}
                  </h3>
                  {unreadCount > 0 && (
                    <button type="button" onClick={markAllRead} className="liquid-glass-chip flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold" style={{ color: 'var(--g-accent)' }}>
                      <Check className="w-3.5 h-3.5" /> Mark all read
                    </button>
                  )}
                  <button type="button" onClick={() => setOpen(false)} className="liquid-glass-chip p-1.5 rounded-full text-slate-600" aria-label="Close alerts">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 space-y-2">
                  {loading && alerts.length === 0 ? (
                    <p className="py-8 text-center text-sm text-slate-500">Loading...</p>
                  ) : alerts.length === 0 ? (
                    <p className="py-8 text-center text-sm text-slate-500">No alerts yet.</p>
                  ) : (
                    alerts.map((alert) => (
                      <div
                        key={alert.id}
                        onClick={() => handleAlertClick(alert)}
                        className={`liquid-glass-inset rounded-2xl px-3.5 py-3 flex items-start gap-2.5 active:scale-[0.99] transition-transform ${alert.is_read ? '' : '!bg-white/80'}`}
                      >
                        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${alert.is_read ? 'bg-transparent' : 'bg-violet-600'}`} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm leading-snug ${alert.is_read ? 'font-medium text-slate-700' : 'font-semibold text-slate-900'}`}>{alert.title}</div>
                          <div className="text-xs mt-0.5 line-clamp-2 text-slate-500">{alert.message}</div>
                          <div className="text-[11px] mt-1 text-slate-400">{formatDate(alert.created_at)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => removeAlert(alert.id, e)}
                          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 active:bg-white/70"
                          aria-label="Remove alert"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {onViewAll && (
                  <div className="px-4 pt-1 pb-4 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onViewAll();
                      }}
                      className="liquid-glass-button w-full py-2.5 rounded-full text-sm font-semibold"
                    >
                      View all
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {open && (
        <div
          className="max-sm:hidden absolute right-0 mt-2 w-80 max-w-[90vw] rounded-2xl shadow-lg border overflow-hidden z-50"
          style={{ background: 'var(--g-surface, #fff)', borderColor: 'var(--g-border, #e5e7eb)' }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--g-border, #e5e7eb)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--g-text)' }}>
              Alerts
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-medium flex items-center gap-1 hover:opacity-70"
                style={{ color: 'var(--g-accent)' }}
              >
                <Check className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && alerts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--g-text-muted)' }}>
                Loading...
              </div>
            ) : alerts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--g-text-muted)' }}>
                No alerts yet.
              </div>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  onClick={() => handleAlertClick(alert)}
                  className="px-4 py-3 border-b last:border-b-0 cursor-pointer flex items-start gap-2 transition-colors hover:opacity-90"
                  style={{
                    borderColor: 'var(--g-border, #e5e7eb)',
                    background: alert.is_read ? 'transparent' : 'var(--g-accent-soft)'
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium" style={{ color: 'var(--g-text)' }}>
                      {alert.title}
                    </div>
                    <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--g-text-muted)' }}>
                      {alert.message}
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--g-text-muted)' }}>
                      {formatDate(alert.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => removeAlert(alert.id, e)}
                    className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center hover:opacity-70"
                    style={{ color: 'var(--g-text-muted)' }}
                    title="Remove"
                    aria-label="Remove alert"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          {onViewAll && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onViewAll();
              }}
              className="w-full px-4 py-2.5 text-xs font-medium text-center border-t hover:opacity-70"
              style={{ borderColor: 'var(--g-border, #e5e7eb)', color: 'var(--g-accent)' }}
            >
              View all
            </button>
          )}
        </div>
      )}
    </div>
  );
};
