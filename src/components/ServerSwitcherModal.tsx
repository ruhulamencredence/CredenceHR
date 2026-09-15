/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Server, Check, X, RefreshCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface CatalogEntry {
  id: number;
  name: string;
  url: string;
}

interface ServerSwitcherModalProps {
  token: string;
  onClose: () => void;
}

// Full-screen-on-mobile / centered-on-desktop modal — native-app-only, for
// EVERY signed-in account (not just Superadmin — any employee may need to
// point their device at a different company/deployment server). Fetches the
// live server catalog from whichever backend this device is CURRENTLY
// loaded from (GET /api/server-profiles) and lets the user open a DIFFERENT
// deployment right inside the app.
//
// "Switching" here is a full page navigation (window.location.href), not a
// change to some background fetch target: tapping an entry makes the
// WebView load that other server's app fresh — its own login screen, its
// own everything — exactly like opening a different website in a browser
// tab. See src/lib/api.ts for why: both platforms already load the whole
// app live from one real server (capacitor.config.ts's server.url), so
// there's no separate "API base" to redirect independently of the page
// itself anymore.
//
// The catalog itself (adding/editing/removing entries) is managed
// separately, on the WEB, from Admin Panel -> Servers (ServerProfilesPanel.tsx)
// — this modal is deliberately just a picker, not an editor.
export const ServerSwitcherModal: React.FC<ServerSwitcherModalProps> = ({ token, onClose }) => {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  const isCurrentServer = (url: string): boolean => {
    try {
      return new URL(url).origin === currentOrigin;
    } catch {
      return false;
    }
  };

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/server-profiles'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ([]));
      if (!res.ok) {
        setError((data as any)?.error || "Couldn't load the server list.");
        return;
      }
      setEntries(data);
    } catch {
      setError("Couldn't reach the current server to load the list.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const handleUse = (entry: CatalogEntry) => {
    if (!window.confirm(`Open "${entry.name}"? This app will reload from that server, and you'll need to sign in there.`)) {
      return;
    }
    const root = entry.url.replace(/\/+$/, '') + '/';
    window.location.href = root;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(31, 31, 31, 0.45)' }}
      onClick={onClose}
    >
      <div
        className="gemini-card w-full sm:max-w-md max-h-[85vh] flex flex-col px-5 py-5 sm:px-6 sm:py-6 rounded-b-none sm:rounded-b-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4" style={{ color: 'var(--g-accent)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--g-text)' }}>
              Switch Server
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={fetchCatalog} className="p-1.5 rounded-full" style={{ color: 'var(--g-text-muted)' }} title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-full" style={{ color: 'var(--g-text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <p className="text-xs mb-4" style={{ color: 'var(--g-text-muted)' }}>
          Tap a server to open its app here — it'll reload and you'll sign in there. To add, edit, or remove a
          server from this list, use Admin Panel → Servers on the web.
        </p>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
          {loading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}

          {!loading && error && (
            <div className="text-sm text-center py-8 rounded-2xl" style={{ background: '#fce8e6', color: '#c5221f' }}>
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div
              className="text-sm text-center py-8 rounded-2xl"
              style={{ background: 'var(--g-surface-muted)', color: 'var(--g-text-muted)' }}
            >
              No servers in the catalog yet — add one from Admin Panel → Servers on the web.
            </div>
          )}

          {!loading && !error && entries.map((entry) => {
            const isCurrent = isCurrentServer(entry.url);
            return (
              <button
                key={entry.id}
                className="w-full flex items-center gap-2 px-4 py-3 rounded-2xl text-left"
                style={{
                  background: isCurrent ? 'var(--g-accent-soft)' : 'var(--g-surface-muted)',
                  border: isCurrent ? '1px solid var(--g-accent-300)' : '1px solid transparent',
                }}
                onClick={() => !isCurrent && handleUse(entry)}
                disabled={isCurrent}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--g-text)' }}>
                      {entry.name}
                    </span>
                    {isCurrent && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--g-accent)' }} />}
                  </div>
                  <div className="text-xs truncate" style={{ color: 'var(--g-text-muted)' }}>
                    {entry.url}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
