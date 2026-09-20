/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Bell, ChevronLeft } from 'lucide-react';
import { ActiveNotice } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface NoticeBoardProps {
  token: string;
  onBack: () => void;
}

// A persistent, browsable list of every notice currently active for this
// account — unlike NoticePopup.tsx (which shows the same GET /api/notices/active
// data as a one-at-a-time modal right after login, and permanently removes an
// entry from that list once dismissed), this page never dismisses anything:
// it's just somewhere to come back and re-read a notice later.
export const NoticeBoard: React.FC<NoticeBoardProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [notices, setNotices] = useState<ActiveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        // /api/notices/board, not /active — the latter is the login popup's
        // endpoint and hides anything this account has dismissed, which made
        // this page unable to do the one thing it exists for (below).
        const res = await fetch(apiUrl('/api/notices/board'), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load Notice Board');
        setNotices(await res.json());
      } catch (err: any) {
        setError(err.message || 'Failed to load Notice Board');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8 max-w-2xl mx-auto">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Notice Board']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}
        {/* On the native Android app there's no on-screen Back button here —
            the hardware/gesture back navigates back to the tile menu on its
            own (UserPanel.tsx's useBackButtonClose(mobileActiveSection !==
            null, () => goToMobileSection(null))), so a duplicate on-screen
            button would be redundant. The web build above keeps its own
            (there's no OS-level back gesture to fall back on there). */}

        {/* Hidden on mobile — the mobile header now shows this page's own
            "Notice Board" title in the logo's place (see headerPageTitle.ts
            in UserPanel.tsx), so repeating it here would be a redundant
            duplicate. Desktop has no such header takeover, so it keeps the
            full row. The Back button above stays either way — it's
            navigation, not a duplicate label. */}
        <div className="hidden md:flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Bell className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Notice Board</h1>
            <p className="text-xs text-slate-500 mt-0.5">Every notice currently posted for you</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner size={28} />
          </div>
        ) : error ? (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>
        ) : notices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <Bell className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500">No notices posted right now.</p>
          </div>
        ) : (
          /* No backdrop-blur on these cards on purpose — this list can grow
             to many notices, and blurring behind each one individually was
             a real contributor to the app feeling slow/stuttery switching
             into this page on Android. A flatter, more opaque tint keeps
             the same glass look without a per-card blur cost. */
          <div className="space-y-3">
            {notices.map((n) => (
              <div
                key={n.id}
                className="bg-gradient-to-br from-violet-100/90 via-white/85 to-indigo-50/80 rounded-[28px] border border-white/70 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] p-5 md:bg-white md:from-transparent md:via-transparent md:to-transparent md:rounded-2xl md:border-slate-200 md:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-sm font-bold text-slate-900">{n.title}</h2>
                  {n.created_at && (
                    <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">{formatDate(n.created_at)}</span>
                  )}
                </div>
                <div
                  className="text-sm text-slate-700 leading-relaxed mt-2 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
                  dangerouslySetInnerHTML={{ __html: n.content_html }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
