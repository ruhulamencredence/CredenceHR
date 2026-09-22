/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BellRing, Check, ChevronLeft, Trash2 } from 'lucide-react';
import { Alert } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';

interface AlertsPageProps {
  token: string;
  onBack: () => void;
  // Same destination AlertsBell's dropdown already jumps to for a
  // 'leave_application' alert — see App.tsx's onOpenLeaveApplication.
  onOpenLeaveApplication?: () => void;
}

// Full "self service" style page for the Personal Alerts inbox — same data
// (GET/POST /api/alerts...) AlertsBell.tsx's Navbar dropdown already uses,
// just given its own page instead of only a 320px-wide dropdown, same as
// every other self-service section (Employee Directory, My Leave, ...).
// Reachable from GlobalSidebar's "Alerts" item and AlertsBell's dropdown
// footer "View all" link.
export const AlertsPage: React.FC<AlertsPageProps> = ({ token, onBack, onOpenLeaveApplication }) => {
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
    if (alert.type === 'leave_application' && onOpenLeaveApplication) {
      onOpenLeaveApplication();
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
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
          <div className="p-5 sm:p-6 border-b border-slate-200 flex items-center justify-between gap-3">
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
                className="text-xs font-medium flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors shrink-0"
                style={{ color: 'var(--g-accent)' }}
              >
                <Check className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div>
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
                  className="px-4 sm:px-6 py-4 border-b border-slate-100 last:border-b-0 cursor-pointer flex items-start gap-3 transition-colors hover:bg-slate-50"
                  style={{ background: alert.is_read ? 'transparent' : 'var(--g-accent-soft)' }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900">{alert.title}</div>
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
