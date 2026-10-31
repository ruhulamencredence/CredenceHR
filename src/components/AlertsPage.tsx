/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BellRing, Check, ChevronLeft, Mail, MailOpen } from 'lucide-react';
import { Alert } from '../types';
import { MyAssetTarget } from '../lib/quickAccess';
import { apiUrl } from '../lib/api';
import { isHrSideCaseAlert, openGrievanceAdmin } from '../lib/grievanceNav';
import { formatDate } from '../lib/formatDate';
import { ModulePath } from './ModulePath';
import { LoadingBlock } from './LoadingBlock';
import { PagerBar } from './PagerBar';

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
  // 'assign' — a ride already approved that still needs a vehicle (or one
  // that expired): open where vehicles are assigned instead of Approvals.
  onOpenVehicleManagement?: (target?: 'status' | 'assign' | 'trips') => void;
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
  // Every alert this account ever got, 50 (or the chosen size) per page;
  // nothing is ever removed from here.
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const isNativeApp = Capacitor.isNativePlatform();
  const [show, setShow] = useState<'all' | 'unread' | 'read'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [counts, setCounts] = useState({ total: 0, unread: 0, read: 0, shown: 0 });

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/alerts?page=${page}&page_size=${pageSize}&show=${show}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setAlerts(Array.isArray(data.alerts) ? data.alerts : []);
        setCounts({ total: Number(data.total) || 0, unread: Number(data.unread) || 0, read: Number(data.read) || 0, shown: Number(data.shown_total) || 0 });
        // A page past the end (e.g. after marking the last unread one read) -> last page.
        const last = Math.max(1, Math.ceil((Number(data.shown_total) || 0) / pageSize));
        if (page > last) setPage(last);
      }
    } catch {
      // Offline or server unreachable — page just stays empty/stale.
    } finally {
      setLoading(false);
    }
  }, [token, page, pageSize, show]);
  // New alerts appear without a page reload.
  useLiveRefresh(() => fetchAlerts());

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const unreadCount = counts.unread;

  const setRead = async (id: number, read: boolean) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, is_read: read } : a)));
    try {
      await fetch(apiUrl(`/api/alerts/${id}/${read ? 'read' : 'unread'}`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best-effort — the next refresh shows the real state.
    }
    fetchAlerts();
  };
  const markRead = (id: number) => setRead(id, true);

  // Read <-> Unread on one alert (the row's envelope button).
  const toggleRead = (alert: Alert, e: React.MouseEvent) => {
    e.stopPropagation();
    setRead(alert.id, !alert.is_read);
  };

  const markAllRead = async () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
    try {
      await fetch(apiUrl('/api/alerts/read-all'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best-effort, same as setRead above.
    }
    fetchAlerts();
  };

  const handleAlertClick = (alert: Alert) => {
    if (!alert.is_read) markRead(alert.id);
    const rideNeedsVehicle =
      alert.type === 'vehicle_approval' && (/Needs a Vehicle|Ride Request Expired/.test(alert.title) || /still needs a vehicle/.test(alert.message || ''));
    // The driver's / assigner's trip alerts open My Trips (Start Ride).
    const rideForDriver = alert.type === 'vehicle_requisition' && /Ride Assigned to You|Press Start Ride/.test(alert.title);
    const target =
      alert.type === 'leave_application'
        ? onOpenLeaveApplication
        : rideNeedsVehicle && onOpenVehicleManagement
        ? () => onOpenVehicleManagement('assign')
        : rideForDriver && onOpenVehicleManagement
        ? () => onOpenVehicleManagement('trips')
        : alert.type === 'vehicle_approval' || alert.type === 'leave_approval' || alert.type === 'conveyance_approval' || alert.type === 'asset_approval' || alert.type === 'exit_clearance' || alert.type === 'mobile_limit_approval' || alert.type === 'loan_approval'
        ? onOpenApproveApplications
        : alert.type === 'vehicle_requisition' && onOpenVehicleManagement
        ? () => onOpenVehicleManagement('status')
        : alert.type === 'conveyance_claim' || alert.type === 'conveyance_disbursed'
        ? onOpenConveyanceClaim
        : alert.type === 'asset_requisition' && alert.related_type !== 'asset_return' && onOpenMyAsset
        ? () => onOpenMyAsset(alert.related_type === 'asset_requisition' ? 'status' : 'my-assets')
        : alert.type === 'resignation'
        ? onOpenResignation
        : alert.type === 'grievance' || alert.type === 'disciplinary'
        ? canOpenGrievanceAdmin && isHrSideCaseAlert(alert.title)
          ? () => openGrievanceAdmin(alert.type === 'disciplinary' ? 'disciplinary' : 'grievances')
          : onOpenMyCases
        : alert.type === 'assistant_support'
        ? () => window.dispatchEvent(new CustomEvent('credence:open-assistant-support', { detail: alert.related_id }))
        : alert.type === 'hr_reminder'
        ? () => {
            // HR reminders (probation / contract / document / retirement /
            // increment dates): HR Operations -> Dashboard -> Coming up.
            try {
              sessionStorage.setItem('hr_ops_tab', 'dashboard');
            } catch {
              // storage unavailable
            }
            (onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' }))))();
            setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: 'dashboard' })), 0);
          }
        : alert.type === 'requisition'
        ? alert.related_type === 'requisition_hr'
          ? () => {
              // HR: HR Operations -> SIM & ID Card.
              try {
                sessionStorage.setItem('hr_ops_tab', 'requisitions');
              } catch {
                // storage unavailable
              }
              window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' }));
              setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: 'requisitions' })), 0);
            }
          : () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'myRequisitions' }))
        : alert.type === 'hr_action' && alert.related_type === 'onboarding_application'
        ? () => {
            // HR: Onboarding -> New Joiners.
            try {
              sessionStorage.setItem('hr_ops_tab', 'onboarding');
            } catch {
              // storage unavailable
            }
            (onOpenHrOperations || (() => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'hr_operations' }))))();
            setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: 'onboarding' })), 0);
          }
        : alert.type === 'hr_action' && alert.related_type === 'attendance_correction' && !/Awaiting Your Approval/.test(alert.title)
        ? () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'timesheet' }))
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
        : alert.type === 'target'
        ? // My Targets, with this target open (App.tsx, MyTargets.tsx).
          () => {
            try {
              if (alert.related_id) sessionStorage.setItem('open_target_id', String(alert.related_id));
            } catch {
              // storage unavailable — the page opens without the target
            }
            window.dispatchEvent(new CustomEvent('credence:open-target'));
          }
        : alert.type === 'payroll_approval' && alert.title === 'Salary Paid'
        ? // My Payslip with that month open (App.tsx, MyPayslips.tsx).
          () => {
            try {
              if (alert.related_id) sessionStorage.setItem('open_payslip_id', String(alert.related_id));
            } catch {
              // storage unavailable — the list opens instead
            }
            window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'myPayslips' }));
          }
        : alert.type === 'payroll_approval' && alert.title !== 'Salary Paid'
        ? // Audit / Accounts / HR: Payroll -> Approval (App.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-payroll-approval'))
        : alert.type === 'loan_request'
        ? // My Loan / Advance, or Payroll -> Loans & Advances for one to decide (App.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-loan', { detail: { title: alert.title } }))
        : alert.type === 'mobile_bill'
        ? // My Mobile SIM, or HR's Mobile Bill for a request with no approval chain (App.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-mobile-bill', { detail: { title: alert.title } }))
        : alert.type === 'device_request' && alert.related_type === 'user_device_decision'
        ? undefined
        : alert.type === 'asset_requisition' && alert.related_type === 'asset_return'
        ? () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'asset_management' }))
        : alert.type === 'device_request'
        ? // Superadmin: Admin Panel -> Device Access, to approve the new phone.
          () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'devices' }))
        : alert.type === 'mail'
        ? // Credence Mail, with this mail open (App.tsx, mail/CredenceMail.tsx).
          () => {
            try {
              if (alert.related_id) sessionStorage.setItem('open_mail_id', String(alert.related_id));
            } catch {
              // storage unavailable — Credence Mail opens on the Inbox
            }
            window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'credenceMail' }));
          }
        : alert.type === 'site_attendance'
        ? () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'teamAttendance' }))
        : alert.type === 'document_sign'
        ? // Documents to Sign, or Document Vault for a signed / declined one (App.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-esign', { detail: { title: alert.title } }))
        : alert.type === 'notice_draft'
        ? // Admin Panel -> Notices, where the draft waits to be published.
          () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'notices' }))
        : alert.type === 'interview'
        ? // Admin Panel -> Recruitment (ATS); opens only for an account with that module.
          () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'recruitment' }))
        : alert.type === 'password_request'
        ? // Admin Panel -> Users -> Password requests (AdminPanel.tsx listens).
          () => {
            window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'users' }));
            setTimeout(() => window.dispatchEvent(new CustomEvent('credence:password-requests')), 300);
          }
        : alert.type === 'mpr_dispatch'
        ? // Material on its way -> Material Receive; a short receipt -> Purchase's Dispatch Material.
          alert.title === 'Material dispatched'
          ? () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'materialReceive' }))
          : () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'reports' }))
        : alert.type === 'roster'
        ? // Self Service -> My Duty Roster (App.tsx, MyRoster.tsx).
          () => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: 'myRoster' }))
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
      <div className="w-full px-2 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <ModulePath path={['Self Service', 'Alerts']} onBack={onBack} />
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
            <div className="flex items-center gap-2 shrink-0">
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
          </div>

          {/* Phones: each alert is its own glass card (same look as the
              liquid-glass Alerts sheet in AlertsBell.tsx) with a dot while
              unread; no backdrop blur per card, so long lists still scroll
              smoothly. */}
          {counts.total > 0 && (
            <div className="px-4 sm:px-6 py-3 max-sm:px-3 sm:border-b border-slate-100 flex items-center gap-1.5">
              {(
                [
                  ['all', `All (${counts.total})`],
                  ['unread', `Unread (${counts.unread})`],
                  ['read', `Read (${counts.read})`]
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setShow(k); setPage(1); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${show === k ? 'text-white' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'}`}
                  style={show === k ? { background: 'var(--g-accent)' } : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="max-sm:px-2 max-sm:space-y-2">
            {loading ? (
              <LoadingBlock />
            ) : counts.total === 0 ? (
              <div className="px-4 py-16 text-center text-sm text-slate-400">No alerts yet.</div>
            ) : alerts.length === 0 ? (
              <div className="px-4 py-16 text-center text-sm text-slate-400">{show === 'unread' ? 'No unread alerts.' : 'No read alerts.'}</div>
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
                    <div className={`text-sm text-slate-900 ${alert.is_read ? 'font-medium' : 'font-bold'}`}>{alert.title}</div>
                    <div className="text-xs mt-1 text-slate-600">{alert.message}</div>
                    <div className="text-[11px] mt-1.5 text-slate-400">{formatDate(alert.created_at)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => toggleRead(alert, e)}
                    className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    title={alert.is_read ? 'Mark as unread' : 'Mark as read'}
                    aria-label={alert.is_read ? 'Mark as unread' : 'Mark as read'}
                  >
                    {alert.is_read ? <Mail className="w-3.5 h-3.5" /> : <MailOpen className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))
            )}
          </div>
          <PagerBar page={page} pageSize={pageSize} total={counts.shown} onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }); }} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
        </div>
      </div>
    </div>
  );
};
