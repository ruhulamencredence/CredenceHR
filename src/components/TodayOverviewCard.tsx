/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { CalendarDays, Sun, Users } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

interface TodayOverviewCardProps {
  token: string;
  className?: string;
}

// GET /api/today-overview — see its route comment in holidayRoutes.ts for why
// the on-leave list carries names and return dates only.
interface TodayOverview {
  today: string;
  today_off: { day_type: 'holiday' | 'weekend'; title: string } | null;
  next_off: { date: string; day_type: 'holiday' | 'weekend'; title: string; days_away: number } | null;
  on_leave_today: { user_id: number; name: string; until: string }[];
  on_leave_count: number;
}

// How many colleagues to name before collapsing the rest into a count.
const MAX_NAMES = 4;

function daysAwayLabel(daysAway: number): string {
  if (daysAway <= 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  return `in ${daysAway} days`;
}

// Dashboard "Today" — the next non-working day, and who's out on approved
// Leave right now. Both already existed in the app (the Holiday Calendar
// widget, and each person's own Leave pages), but neither answered the
// planning questions worth asking at a glance: is the office open, and who
// can I not expect a reply from today. The full calendar still sits further
// down the Dashboard for actually browsing dates.
export const TodayOverviewCard: React.FC<TodayOverviewCardProps> = ({ token, className = '' }) => {
  const [data, setData] = useState<TodayOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/today-overview'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setData(await res.json());
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

  // Nothing worth flashing an empty shell for, and nothing to say at all if
  // there's no calendar entry ahead and nobody is out.
  if (loading || !data) return null;
  if (!data.today_off && !data.next_off && data.on_leave_count === 0) return null;

  const named = data.on_leave_today.slice(0, MAX_NAMES);
  const remaining = data.on_leave_count - named.length;

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-blue-600" /> Today
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">{formatDate(data.today)}</p>
      </div>

      <div className="p-5 sm:px-6 space-y-3">
        {data.today_off ? (
          <div className="flex items-start gap-2.5 text-sm px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-800">
            <Sun className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold">{data.today_off.day_type === 'weekend' ? 'Weekend' : 'Holiday'}</span>
              {data.today_off.title ? ` — ${data.today_off.title}` : ''}
            </span>
          </div>
        ) : data.next_off ? (
          <div className="flex items-start gap-2.5 text-sm text-slate-700">
            <Sun className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <span>
              Next {data.next_off.day_type === 'weekend' ? 'weekend' : 'holiday'}{' '}
              <span className="font-semibold">{daysAwayLabel(data.next_off.days_away)}</span> ·{' '}
              {formatDate(data.next_off.date)}
              {data.next_off.title ? ` — ${data.next_off.title}` : ''}
            </span>
          </div>
        ) : null}

        {data.on_leave_count > 0 && (
          <div className="flex items-start gap-2.5 text-sm text-slate-700">
            <Users className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div>
                <span className="font-semibold">{data.on_leave_count}</span> on leave today
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {named.map((p) => p.name).join(', ')}
                {remaining > 0 ? ` +${remaining} more` : ''}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
