/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BellRing, Check, ChevronLeft, Trash2 } from 'lucide-react';
import { Alert } from '../types';
import { MyAssetTarget } from '../lib/quickAccess';
import { apiUrl } from '../lib/api';
import { isHrSideCaseAlert, openGrievanceAdmin } from '../lib/grievanceNav';
import { formatDate } from '../lib/formatDate';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';

interface AlertsPageProps {
  token: string;
  onBack: () => void;
  // Same destination AlertsBell's dropdown already jumps to for a
  // 'leave_application' alert — see App.tsx's onOpenLeaveApplication.
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
  // Grievance / Disciplinary alerts open Self Service -> Grievance & Disciplinary;
  // the HR-side ones open the Admin Panel module instead when this account
  // can see it (canOpenGrievanceAdmin).
  onOpenMyCases?: () => void;
  canOpenGrievanceAdmin?: boolean;
  // HR Operations: a letter issued to this account -> My Letters; HR-side
  // updates (a letter acknowledged/requested, an action decided) -> the
  // HR Operations module.
  onOpenMyLetters?: () => void;
  onOpenHrOperations?: () => void;
}

// Full "self service" style page for the Personal Alerts inbox — same data
// (GET/POST /api/alerts...) AlertsBell.tsx's Navbar dropdown already uses,
// just given its own page instead of only a 320px-wide dropdown, same as
// every other self-service section (Employee Directory, My Leave, ...).
// Reachable from GlobalSidebar's "Alerts" item and AlertsBell's dropdown
// footer "View all" link.
export const AlertsPage: React.FC<AlertsPageProps> = ({ token, onBack, onOpenLeaveApplication, onOpenApproveApplications, onOpenVehicleManagement, onOpenConveyanceClaim, onOpenMyAsset, onOpenResignation, onOpenMyCases, canOpenGrievanceAdmin, onOpenMyLetters, onOpenHrOperations }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const isNativeApp = Capacitor.isNativePlatform();

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/alerts'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setAlerts(await res.json());
    } catch {
      // Offline or server unreachable — page just stays empty/stale.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const unreadCount = alerts.filter((a) => !a.is_read).length;

  const markRead = async (id: number) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, is_read: true } : a)));
    try {
      await fetch(apiUrl(`/api/alerts/${id}/read`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best-effort — a failed mark-read just means it may show unread again next refresh.
    }
  };

  const markAllRead = async () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
    try {
      await fetch(apiUrl('/api/alerts/read-all'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best-effort, same as markRead above.
    }
  };

  const removeAlert = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(apiUrl(`/api/alerts/${id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
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
        ? canOpenGrievanceAdmin && isHrSideCaseAlert(alert.title)
          ? () => openGrievanceAdmin(alert.type === 'disciplinary' ? 'disciplinary' : 'grievances')
          : onOpenMyCases
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
      target();
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-2 sm:px-6 lg:px-8 pt-3 pb-8 max-w-3xl mx-auto">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Alerts']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-transparent sm:bg-white rounded-none sm:rounded-2xl shadow-none sm:shadow-sm border-0 sm:border sm:border-slate-200 overflow-hidden">
          <div className="p-5 sm:p-6 max-sm:px-3 max-sm:pt-2 max-sm:pb-3 sm:border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {isNativeApp && (
                <button type="button" onClick={onBack} className="p-1.5 -ml-1.5 text-slate-500 hover:bg-slate-100 rounded-lg">
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}
              <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center shrink-0">
                <BellRing className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-800">Alerts</h1>
                <p className="text-xs text-slate-500 mt-0.5">
                  {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
                </p>
              </div>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-medium flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors shrink-0 max-sm:rounded-full max-sm:font-semibold max-sm:bg-white/60 max-sm:border max-sm:border-white/80 max-sm:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_8px_-2px_rgba(15,23,42,0.2)]"
                style={{ color: 'var(--g-accent)' }}
              >
                <Check className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          {/* Phones: each alert is its own glass card (same look as the
              liquid-glass Alerts sheet in AlertsBell.tsx) with a dot while
              unread; no backdrop blur per card, so long lists still scroll
              smoothly. */}
          <div className="max-sm:px-2 max-sm:space-y-2">
            {loading ? (
              <div className="px-4 py-16 flex items-center justify-center">
                <Spinner size={24} />
              </div>
            ) : alerts.length === 0 ? (
              <div className="px-4 py-16 text-center text-sm text-slate-400">No alerts yet.</div>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  onClick={() => handleAlertClick(alert)}
                  className={`px-4 sm:px-6 py-4 sm:border-b border-slate-100 last:border-b-0 cursor-pointer flex items-start gap-3 transition-colors sm:hover:bg-slate-50 max-sm:rounded-2xl max-sm:border max-sm:border-white/80 max-sm:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_18px_-12px_rgba(31,38,135,0.35)] ${
                    alert.is_read ? 'max-sm:bg-white/45' : 'sm:bg-[var(--g-accent-soft)] max-sm:bg-white/80'
                  }`}
                >
                  <span className={`sm:hidden mt-1.5 w-2 h-2 rounded-full shrink-0 ${alert.is_read ? 'bg-transparent' : 'bg-violet-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm text-slate-900 ${alert.is_read ? 'font-medium' : 'font-medium max-sm:font-semibold'}`}>{alert.title}</div>
                    <div className="text-xs mt-1 text-slate-600">{alert.message}</div>
                    <div className="text-[11px] mt-1.5 text-slate-400">{formatDate(alert.created_at)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => removeAlert(alert.id, e)}
                    className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    title="Remove"
                    aria-label="Remove alert"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
