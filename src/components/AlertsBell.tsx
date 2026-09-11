/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BellRing, Check, Trash2 } from 'lucide-react';
import { Alert } from '../types';
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
}

// Personal Alerts inbox — same component renders in the shared Navbar on
// both the web build and the Capacitor mobile app, since they run the exact
// same React code. On by default for every account (no module grant needed,
// unlike the Admin Panel tabs). Polls the lightweight unread-count endpoint
// so the badge stays current without re-fetching the whole list constantly;
// the full list is only fetched when the dropdown is actually opened.
export const AlertsBell: React.FC<AlertsBellProps> = ({ token, onOpenLeaveApplication }) => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
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
    if (alert.type === 'leave_application' && onOpenLeaveApplication) {
      setOpen(false);
      onOpenLeaveApplication();
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

      {open && (
        <div
          className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-2xl shadow-lg border overflow-hidden z-50"
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
        </div>
      )}
    </div>
  );
};
