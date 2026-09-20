/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Bell, ChevronRight } from 'lucide-react';
import { ActiveNotice } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

interface NoticePreviewCardProps {
  token: string;
  // Opens the full Notice Board page.
  onOpen: () => void;
  className?: string;
}

const MAX_NOTICES = 3;

// Plain-text opening line of a notice, for the preview under its title. The
// body is stored as HTML, so it's parsed rather than regex-stripped — and
// read through DOMParser, which builds an inert document: nothing in the
// markup runs, and only textContent is taken out of it.
function previewText(html: string): string {
  try {
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Dashboard "Notice Board" preview — the few most recent notices posted for
// this account. Notices used to appear exactly once, as a popup right after
// login (NoticePopup.tsx); dismissing that popup left no trace of them
// anywhere a person would look afterwards. This reads GET /api/notices/board,
// which unlike the popup's endpoint doesn't hide dismissed notices — closing
// the popup means "stop putting this in front of me", not "erase it".
export const NoticePreviewCard: React.FC<NoticePreviewCardProps> = ({ token, onOpen, className = '' }) => {
  const [notices, setNotices] = useState<ActiveNotice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/notices/board'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setNotices(await res.json());
      } catch {
        // Offline/unreachable — falls through to rendering nothing.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // No notices posted is the normal state for most of the year, so this stays
  // out of the way entirely rather than holding a slot for an empty card —
  // including while the first fetch runs, so nothing flashes and vanishes.
  if (loading || notices.length === 0) return null;

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-4 h-4 text-blue-600" /> Notice Board
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">Latest notices posted for you</p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors"
        >
          See all <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="divide-y divide-slate-100">
        {notices.slice(0, MAX_NOTICES).map((n) => {
          const preview = previewText(n.content_html);
          return (
            <button
              key={n.id}
              type="button"
              onClick={onOpen}
              className="w-full px-5 py-3.5 sm:px-6 text-left hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-semibold text-slate-900 truncate">{n.title}</span>
                {n.created_at && (
                  <span className="text-[10px] text-slate-400 shrink-0 whitespace-nowrap">{formatDate(n.created_at)}</span>
                )}
              </div>
              {preview && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{preview}</p>}
            </button>
          );
        })}
      </div>
    </div>
  );
};
