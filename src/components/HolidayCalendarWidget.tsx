/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { HolidayEntry } from '../types';
import { apiUrl } from '../lib/api';

interface HolidayCalendarWidgetProps {
  token: string;
  // 'compact' (default) is the small pocket-calendar used on mobile's
  // Dashboard. 'large' is the same data/behavior at desktop scale — bigger
  // header, bigger day cells, and each Holiday/Weekend date gets its own
  // small label under the day number instead of just a colored dot's worth
  // of room.
  size?: 'compact' | 'large';
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateStr = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

interface GridCell {
  dateStr: string;
  day: number;
  inCurrentMonth: boolean;
}

// Same fixed 6-row (42 cell) grid builder as HolidayCalendarPanel's own
// buildGrid() / LeaveDurationCalendar's — leading/trailing days from the
// neighbouring months so the grid height never jumps while navigating.
function buildGrid(year: number, month: number): GridCell[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const totalInMonth = daysInMonth(year, month);
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const totalInPrevMonth = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const offset = i - firstWeekday;
    if (offset < 0) {
      const day = totalInPrevMonth + offset + 1;
      cells.push({ dateStr: toDateStr(prevYear, prevMonth, day), day, inCurrentMonth: false });
    } else if (offset >= totalInMonth) {
      const day = offset - totalInMonth + 1;
      cells.push({ dateStr: toDateStr(nextYear, nextMonth, day), day, inCurrentMonth: false });
    } else {
      const day = offset + 1;
      cells.push({ dateStr: toDateStr(year, month, day), day, inCurrentMonth: true });
    }
  }
  return cells;
}

// Dashboard -> a small, read-only "pocket calendar" of the Global Calendar
// (Admin Panel -> Holidays) — every role sees this exact same widget; only
// accounts granted the 'holidays' module can actually add/edit/remove dates
// (from Admin Panel -> Holidays instead). GET /api/holidays is open to every
// signed-in account, so this needs no extra permission of its own.
export const HolidayCalendarWidget: React.FC<HolidayCalendarWidgetProps> = ({ token, size = 'compact' }) => {
  const large = size === 'large';
  const [entries, setEntries] = useState<HolidayEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const todayStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());

  const fetchHolidays = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/holidays'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setEntries(await res.json());
    } catch {
      // Offline/unreachable — the widget just shows a blank calendar; no
      // error banner needed for a read-only Dashboard extra like this.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchHolidays();
  }, [fetchHolidays]);

  const entryByDate = useMemo(() => {
    const map = new Map<string, HolidayEntry>();
    for (const e of entries) map.set(e.entry_date, e);
    return map;
  }, [entries]);

  const gridCells = useMemo(() => buildGrid(calYear, calMonth), [calYear, calMonth]);

  const goPrevMonth = () => {
    if (calMonth === 0) {
      setCalYear((y) => y - 1);
      setCalMonth(11);
    } else {
      setCalMonth((m) => m - 1);
    }
  };
  const goNextMonth = () => {
    if (calMonth === 11) {
      setCalYear((y) => y + 1);
      setCalMonth(0);
    } else {
      setCalMonth((m) => m + 1);
    }
  };

  return (
    <div
      className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${
        large ? 'max-w-2xl' : 'max-w-sm mx-auto md:mx-0'
      }`}
    >
      <div className={`flex items-center justify-between border-b border-slate-100 ${large ? 'px-6 py-4' : 'px-4 py-3'}`}>
        <div className="flex items-center gap-2">
          <CalendarDays className={large ? 'w-5 h-5 text-blue-600' : 'w-4 h-4 text-blue-600'} />
          <span className={large ? 'text-lg font-bold text-slate-900' : 'text-sm font-bold text-slate-900'}>
            {MONTH_LABELS[calMonth]} {calYear}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrevMonth}
            className={`text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors ${large ? 'p-2' : 'p-1'}`}
            aria-label="Previous month"
          >
            <ChevronLeft className={large ? 'w-5 h-5' : 'w-4 h-4'} />
          </button>
          <button
            type="button"
            onClick={goNextMonth}
            className={`text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors ${large ? 'p-2' : 'p-1'}`}
            aria-label="Next month"
          >
            <ChevronRight className={large ? 'w-5 h-5' : 'w-4 h-4'} />
          </button>
        </div>
      </div>

      <div className={large ? 'px-5 pt-4' : 'px-3 pt-3'}>
        <div className="grid grid-cols-7">
          {WEEKDAY_LABELS.map((w, i) => (
            <div
              key={i}
              className={`text-center font-bold uppercase tracking-wide text-slate-400 ${large ? 'text-xs pb-2' : 'text-[10px] pb-1.5'}`}
            >
              {w}
            </div>
          ))}
        </div>
        <div className={`grid grid-cols-7 ${large ? 'gap-1' : 'gap-y-1'}`}>
          {gridCells.map((cell) => {
            const entry = entryByDate.get(cell.dateStr);
            const isToday = cell.dateStr === todayStr;

            if (large) {
              // Bigger square cells with room for a day-type label under the
              // number, same look HolidayCalendarPanel's own Admin grid uses.
              return (
                <div
                  key={cell.dateStr}
                  title={entry ? `${entry.title} (${entry.day_type === 'weekend' ? 'Weekend' : 'Holiday'})` : undefined}
                  className={`h-16 flex flex-col items-center justify-center gap-0.5 rounded-xl text-sm ${
                    !cell.inCurrentMonth
                      ? 'text-slate-200'
                      : isToday
                        ? 'bg-blue-600 text-white font-bold'
                        : entry
                          ? entry.day_type === 'weekend'
                            ? 'bg-sky-50 text-sky-700'
                            : 'bg-amber-50 text-amber-700'
                          : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span className="font-semibold">{cell.day}</span>
                  {entry && cell.inCurrentMonth && (
                    <span className="text-[10px] font-bold uppercase tracking-wide">
                      {entry.day_type === 'weekend' ? 'Weekend' : 'Holiday'}
                    </span>
                  )}
                </div>
              );
            }

            return (
              <div key={cell.dateStr} className="flex items-center justify-center py-0.5">
                <span
                  title={entry ? `${entry.title} (${entry.day_type === 'weekend' ? 'Weekend' : 'Holiday'})` : undefined}
                  className={`w-7 h-7 flex items-center justify-center rounded-full text-[11px] font-semibold ${
                    !cell.inCurrentMonth
                      ? 'text-slate-200'
                      : isToday
                        ? 'bg-blue-600 text-white'
                        : entry
                          ? entry.day_type === 'weekend'
                            ? 'bg-sky-100 text-sky-700'
                            : 'bg-amber-100 text-amber-700'
                          : 'text-slate-700'
                  }`}
                >
                  {cell.day}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={`flex items-center gap-4 border-t border-slate-100 font-medium text-slate-500 ${
          large ? 'px-6 py-3 mt-2 text-xs' : 'px-4 py-2.5 mt-1 text-[10px]'
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> Holiday
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> Weekend
        </span>
        {loading && <span className="ml-auto text-slate-300">Loading…</span>}
      </div>
    </div>
  );
};
