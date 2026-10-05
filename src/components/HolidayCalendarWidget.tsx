/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, UserRound } from 'lucide-react';
import { HolidayEntry } from '../types';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import {
  BENGALI_GREGORIAN_MONTHS,
  BENGALI_WEEKDAYS_SHORT,
  CalendarSystem,
  altMonthTitle,
  toBengaliDate,
  toBengaliDigits,
  toHijriDate
} from '../lib/altCalendars';

const CALENDAR_SYSTEMS: { id: CalendarSystem; label: string }[] = [
  { id: 'english', label: 'English' },
  { id: 'bengali', label: 'বাংলা' },
  { id: 'hijri', label: 'Hijri' }
];

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

// GET /api/calendar-attendance — one person's own Delay / Extreme Delay /
// Leave per day (see PayrollRoutes.ts for who may open whose calendar).
interface DayStatus {
  late?: 'delay' | 'extreme';
  leave?: { type: string; status: 'approved' | 'pending' };
}
interface CalendarPerson {
  user_id: number;
  name: string;
  employee_code?: string | null;
  department: string | null;
}

// Short label + colours for a day's own status; Extreme Delay outranks a
// plain Delay, and a Leave day is never also late.
function statusBadge(s: DayStatus | undefined): { label: string; title: string; dot: string; text: string } | null {
  if (!s) return null;
  if (s.leave) {
    const pending = s.leave.status === 'pending';
    return {
      label: pending ? 'Leave?' : 'Leave',
      title: `${s.leave.type} leave (${pending ? 'pending approval' : 'approved'})`,
      dot: pending ? 'bg-white ring-2 ring-inset ring-violet-500' : 'bg-violet-500',
      text: 'text-violet-700'
    };
  }
  if (s.late === 'extreme') return { label: 'Extreme', title: 'Extreme Delay', dot: 'bg-rose-500', text: 'text-rose-600' };
  if (s.late === 'delay') return { label: 'Delay', title: 'Delay', dot: 'bg-orange-400', text: 'text-orange-600' };
  return null;
}

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
// On top of the Weekend/Holiday dates each day carries the viewer's own
// Delay / Extreme Delay / Leave. An Admin or a Monthly Attendance Report
// holder can switch to anyone in their own Department, the Superadmin to
// anyone; the server enforces the same rule (/api/calendar-attendance).
export const HolidayCalendarWidget: React.FC<HolidayCalendarWidgetProps> = ({ token, size = 'compact' }) => {
  const large = size === 'large';
  const [entries, setEntries] = useState<HolidayEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const todayStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
  // English / বাংলা / Hijri — always opens on English.
  const [system, setSystem] = useState<CalendarSystem>('english');
  const bn = system === 'bengali';

  // The big number in a day cell is that calendar's own date; under
  // বাংলা / Hijri the English date sits small beneath it.
  const cellDates = (cell: GridCell): { main: string; sub: string | null } => {
    if (system === 'english') return { main: String(cell.day), sub: null };
    const [y, m, d] = cell.dateStr.split('-').map(Number);
    const alt = bn ? toBengaliDate(y, m - 1, d) : toHijriDate(y, m - 1, d);
    if (!alt) return { main: String(cell.day), sub: null };
    return bn ? { main: toBengaliDigits(alt.day), sub: String(cell.day) } : { main: String(alt.day), sub: String(cell.day) };
  };
  const dayTypeLabel = (t: string) => (t === 'weekend' ? (bn ? 'সাপ্তাহিক' : 'Weekend') : bn ? 'ছুটি' : 'Holiday');
  const weekdayLabels = bn ? BENGALI_WEEKDAYS_SHORT : WEEKDAY_LABELS;
  const altTitle = altMonthTitle(system, calYear, calMonth);
  const englishTitle = bn ? `${BENGALI_GREGORIAN_MONTHS[calMonth]} ${toBengaliDigits(calYear)}` : `${MONTH_LABELS[calMonth]} ${calYear}`;

  const fetchHolidays = useCallback(async () => {
    setLoading(true);
    try {
      // This widget mounts twice on every Dashboard load (compact mobile +
      // large desktop copies, see UserPanel.tsx) — dedupedFetchJson means
      // only one of the two actually hits the network.
      const myGroup = await dedupedFetchJson(apiUrl('/api/my-holiday-group'), token);
      const appliesTo = myGroup?.applies_to === 'project_site' ? 'project_site' : 'head_office';
      const rows = await dedupedFetchJson(apiUrl(`/api/holidays?applies_to=${appliesTo}`), token);
      if (rows) setEntries(rows);
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

  // Whose attendance the grid shows. The list holds just the viewer unless
  // they're an Admin / Monthly Attendance Report holder (their Department)
  // or the Superadmin (everyone) — the picker only appears with 2+ people.
  const [people, setPeople] = useState<CalendarPerson[]>([]);
  const [viewUserId, setViewUserId] = useState<number | null>(null);
  const [statusByDate, setStatusByDate] = useState<Record<string, DayStatus>>({});
  useEffect(() => {
    dedupedFetchJson(apiUrl('/api/calendar-attendance/people'), token)
      .then((r: any) => setPeople(Array.isArray(r?.people) ? r.people : []))
      .catch(() => {});
  }, [token]);
  const gridFrom = gridCells[0].dateStr;
  const gridTo = gridCells[gridCells.length - 1].dateStr;
  useEffect(() => {
    let cancelled = false;
    const who = viewUserId ? `&user_id=${viewUserId}` : '';
    dedupedFetchJson(apiUrl(`/api/calendar-attendance?from=${gridFrom}&to=${gridTo}${who}`), token)
      .then((r: any) => {
        if (!cancelled) setStatusByDate(r?.days || {});
      })
      .catch(() => {
        if (!cancelled) setStatusByDate({});
      });
    return () => {
      cancelled = true;
    };
  }, [token, gridFrom, gridTo, viewUserId]);

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

  // Mobile (compact) only — swipe the grid itself left/right to change month,
  // no button tap needed. Plain touch coordinates (no library): record the
  // start point, compare to the end point, and only treat it as a swipe once
  // it clearly reads more horizontal than vertical (so a vertical page-scroll
  // through the calendar never gets mistaken for a month change).
  const swipeStart = React.useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD_PX = 40;
  const onGridTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
  };
  const onGridTouchEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) goNextMonth();
    else goPrevMonth();
  };

  return (
    <div
      className={
        large
          // No max-w here either (was max-w-2xl): this variant is used in
          // exactly one place, the desktop Dashboard, where every card above
          // it now runs the full content width — a 672px calendar left-
          // aligned under them just left a large empty patch beside itself.
          ? 'bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden'
          // No max-w/mx-auto here (previously max-w-sm mx-auto) — that
          // centered this card at a fixed 384px width regardless of the
          // actual viewport, so on any phone wider than that it sat visibly
          // narrower/more inset than the full-width quick-access tiles right
          // above it. This is mobile-only (see the `md:hidden` wrapper
          // around it in UserPanel.tsx) so it should just fill its parent's
          // width the same way those tiles do.
          : 'relative rounded-[28px] overflow-hidden border border-white/70 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-sky-100/70 via-white/50 to-blue-50/40 backdrop-blur-xl'
      }
    >
      <div
        className={
          large
            ? 'flex items-center justify-between border-b border-slate-100 px-6 py-4'
            : 'flex items-center justify-between border-b border-white/50 px-4 py-3'
        }
      >
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className={`shrink-0 ${large ? 'w-5 h-5 text-blue-600' : 'w-4 h-4 text-blue-600'}`} />
          <div className="min-w-0">
            <div className={large ? 'text-lg font-bold text-slate-900 leading-tight' : 'text-sm font-bold text-slate-900 leading-tight'}>
              {altTitle || englishTitle}
            </div>
            {altTitle && <div className={`text-slate-500 font-medium ${large ? 'text-xs' : 'text-[10px]'}`}>{englishTitle}</div>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={goPrevMonth}
            className={`text-slate-400 hover:text-slate-900 rounded-lg transition-colors ${
              large ? 'p-2 hover:bg-slate-100' : 'p-1 hover:bg-white/50'
            }`}
            aria-label="Previous month"
          >
            <ChevronLeft className={large ? 'w-5 h-5' : 'w-4 h-4'} />
          </button>
          <button
            type="button"
            onClick={goNextMonth}
            className={`text-slate-400 hover:text-slate-900 rounded-lg transition-colors ${
              large ? 'p-2 hover:bg-slate-100' : 'p-1 hover:bg-white/50'
            }`}
            aria-label="Next month"
          >
            <ChevronRight className={large ? 'w-5 h-5' : 'w-4 h-4'} />
          </button>
        </div>
      </div>

      <div className={`flex justify-center ${large ? 'px-6 pt-3' : 'px-4 pt-2.5 pb-2.5 border-b border-white/40'}`}>
        <div className="inline-flex rounded-full bg-slate-100/80 p-0.5" role="tablist" aria-label="Calendar">
          {CALENDAR_SYSTEMS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={system === c.id}
              onClick={() => setSystem(c.id)}
              className={`rounded-full font-semibold transition-colors ${large ? 'px-4 py-1.5 text-xs' : 'px-3 py-1 text-[11px]'} ${
                system === c.id ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {people.length > 1 && (
        <div className={large ? 'px-6 pt-3' : 'px-4 py-2 border-b border-white/40'}>
          <label className="flex items-center gap-2">
            <UserRound className={`shrink-0 text-slate-400 ${large ? 'w-4 h-4' : 'w-3.5 h-3.5'}`} />
            <select
              value={viewUserId ?? ''}
              onChange={(e) => setViewUserId(e.target.value ? Number(e.target.value) : null)}
              className={`w-full min-w-0 rounded-lg border font-medium text-slate-700 outline-none focus:ring-2 focus:ring-blue-200 ${
                large ? 'border-slate-200 bg-white px-3 py-1.5 text-sm' : 'border-white/60 bg-white/60 px-2.5 py-1.5 text-xs'
              }`}
              aria-label="Show attendance of"
            >
              <option value="">My attendance</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                  {p.employee_code ? ` (${p.employee_code})` : ''}
                  {p.department ? ` · ${p.department}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {large ? (
        <div className="px-5 pt-4">
          <div className="grid grid-cols-7">
            {weekdayLabels.map((w, i) => (
              <div key={i} className="text-center font-bold uppercase tracking-wide text-slate-400 text-xs pb-2">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {gridCells.map((cell) => {
              const entry = entryByDate.get(cell.dateStr);
              const isToday = cell.dateStr === todayStr;
              const dates = cellDates(cell);
              const badge = cell.inCurrentMonth ? statusBadge(statusByDate[cell.dateStr]) : null;
              // Bigger square cells with room for a day-type label under the
              // number, same look HolidayCalendarPanel's own Admin grid uses.
              return (
                <div
                  key={cell.dateStr}
                  title={[entry && `${entry.title} (${dayTypeLabel(entry.day_type)})`, badge?.title].filter(Boolean).join(' · ') || undefined}
                  className={`relative h-16 flex flex-col items-center justify-center gap-0.5 rounded-xl text-sm ${
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
                  <span className="font-semibold leading-none">{dates.main}</span>
                  {dates.sub && <span className={`text-[10px] leading-none ${isToday && cell.inCurrentMonth ? 'text-white/80' : 'opacity-60'}`}>{dates.sub}</span>}
                  {entry && cell.inCurrentMonth && (
                    <span className="text-[10px] font-bold uppercase tracking-wide">
                      {dayTypeLabel(entry.day_type)}
                    </span>
                  )}
                  {badge && (
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${
                        isToday ? 'text-white' : badge.text
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                      {badge.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        // Compact (mobile Dashboard) — same bordered table-style grid as
        // HolidayCalendarPanel's Admin calendar (weekday-label header row +
        // hard grid lines between day cells, each showing its Weekend/
        // Holiday label under the number) instead of the old small circular
        // day badges, now in the same liquid-glass tinted/blurred finish as
        // the rest of this card. Edge-to-edge (no side padding) so the grid
        // lines actually reach the card's own rounded corners, same as the
        // Admin grid reaching its bordered container's edges.
        <div onTouchStart={onGridTouchStart} onTouchEnd={onGridTouchEnd}>
          <div className="grid grid-cols-7 bg-white/30 border-b border-white/40">
            {weekdayLabels.map((w, i) => (
              <div key={i} className="py-2 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {gridCells.map((cell) => {
              const entry = entryByDate.get(cell.dateStr);
              const isToday = cell.dateStr === todayStr;
              const dates = cellDates(cell);
              const badge = cell.inCurrentMonth ? statusBadge(statusByDate[cell.dateStr]) : null;
              return (
                <div
                  key={cell.dateStr}
                  title={[entry && `${entry.title} (${dayTypeLabel(entry.day_type)})`, badge?.title].filter(Boolean).join(' · ') || undefined}
                  className={`relative ${dates.sub ? 'h-14' : 'h-12'} flex flex-col items-center justify-center gap-0.5 border-b border-r border-white/40 text-[11px] transition-colors ${
                    !cell.inCurrentMonth
                      ? 'text-slate-300'
                      : entry
                        ? entry.day_type === 'weekend'
                          ? 'bg-sky-100/50 text-sky-700'
                          : 'bg-amber-100/50 text-amber-700'
                        : 'text-slate-700'
                  }`}
                >
                  <span
                    className={`font-semibold ${
                      isToday && cell.inCurrentMonth ? 'w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center' : ''
                    }`}
                  >
                    {dates.main}
                  </span>
                  {dates.sub && <span className="text-[8px] leading-none opacity-60">{dates.sub}</span>}
                  {entry && cell.inCurrentMonth && (
                    <span className="text-[7px] font-bold uppercase tracking-wide truncate max-w-[90%]">
                      {dayTypeLabel(entry.day_type)}
                    </span>
                  )}
                  {badge && !entry && (
                    <span className={`text-[7px] font-bold uppercase tracking-wide truncate max-w-[90%] ${badge.text}`}>
                      {badge.label}
                    </span>
                  )}
                  {badge && <span className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${badge.dot}`} />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div
        className={
          large
            ? 'flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-100 font-medium text-slate-500 px-6 py-3 mt-2 text-xs'
            : 'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/40 bg-white/30 font-medium text-slate-500 px-4 py-2.5 text-[10px]'
        }
      >
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> {dayTypeLabel('holiday')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> {dayTypeLabel('weekend')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-orange-400" /> Delay
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Extreme
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-violet-500" /> Leave
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-white ring-2 ring-inset ring-violet-500" /> Pending
        </span>
        {loading && <span className="ml-auto text-slate-300">Loading…</span>}
      </div>
    </div>
  );
};