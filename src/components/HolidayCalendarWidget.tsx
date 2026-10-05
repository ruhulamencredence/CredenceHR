/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
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

// GET /api/calendar-attendance — the viewer's own Delay / Extreme Delay, and
// Leave for just the viewer, or their Department with the Monthly Attendance
// Report module, or everyone for the Superadmin; see PayrollRoutes.ts.
interface DayMark {
  user_id: number;
  kind: 'delay' | 'extreme' | 'leave';
  leave_type?: string;
  status?: 'approved' | 'pending';
}
interface CalendarPerson {
  user_id: number;
  name: string;
  department: string | null;
}

type MarkFilter = 'all' | 'delay' | 'extreme' | 'leave' | `type:${string}`;
const matchesFilter = (m: DayMark, f: MarkFilter) =>
  f === 'all' || m.kind === f || (f.startsWith('type:') && m.kind === 'leave' && m.leave_type === f.slice(5));

function markStyle(m: DayMark): { label: string; detail: string; dot: string; ring: string; text: string } {
  if (m.kind === 'leave') {
    const pending = m.status === 'pending';
    return {
      label: pending ? 'Pending' : 'Leave',
      detail: `${m.leave_type || ''} leave · ${pending ? 'Pending' : 'Approved'}`.trim(),
      dot: pending ? 'bg-white ring-2 ring-inset ring-emerald-500' : 'bg-emerald-500',
      ring: pending ? 'ring-emerald-300' : 'ring-emerald-500',
      text: 'text-emerald-700'
    };
  }
  if (m.kind === 'extreme') return { label: 'Extreme', detail: 'Extreme Delay', dot: 'bg-rose-500', ring: 'ring-rose-500', text: 'text-rose-600' };
  return { label: 'Delay', detail: 'Delay', dot: 'bg-orange-400', ring: 'ring-orange-400', text: 'text-orange-600' };
}

// Profile photo (GET /api/profile/photo/:userId), initials until it loads or
// when there's none. Cached per user for the page's lifetime.
const photoCache = new Map<number, Promise<string | null>>();
const PersonPhoto: React.FC<{ userId: number; name: string; token: string; className: string }> = ({ userId, name, token, className }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!photoCache.has(userId)) {
      photoCache.set(
        userId,
        fetch(apiUrl(`/api/profile/photo/${userId}`), { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => (r.ok ? r.blob().then((b) => URL.createObjectURL(b)) : null))
          .catch(() => null)
      );
    }
    photoCache.get(userId)!.then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, token]);
  if (url) return <img src={url} alt={name} className={`${className} rounded-full object-cover`} />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span className={`${className} rounded-full bg-gradient-to-br from-violet-400 to-blue-500 text-white font-bold flex items-center justify-center`}>
      <span className="text-[0.55em] leading-none">{initials}</span>
    </span>
  );
};

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
// holder sees their whole Department's (faces on each day, tap a day for the
// list), the Superadmin everyone's — scoped by /api/calendar-attendance.
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

  // Who was late / on Leave on each day of the visible grid.
  const [people, setPeople] = useState<CalendarPerson[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const [marksByDate, setMarksByDate] = useState<Record<string, DayMark[]>>({});
  const [filter, setFilter] = useState<MarkFilter>('all');
  const [openDay, setOpenDay] = useState<{ date: string; rect: DOMRect } | null>(null);
  const gridFrom = gridCells[0].dateStr;
  const gridTo = gridCells[gridCells.length - 1].dateStr;
  useEffect(() => {
    let cancelled = false;
    dedupedFetchJson(apiUrl(`/api/calendar-attendance?from=${gridFrom}&to=${gridTo}`), token).then((r: any) => {
      if (cancelled) return;
      setPeople(Array.isArray(r?.people) ? r.people : []);
      setMe(typeof r?.me === 'number' ? r.me : null);
      setMarksByDate(r?.days || {});
    });
    return () => {
      cancelled = true;
    };
  }, [token, gridFrom, gridTo]);
  const personById = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);
  // Others' Leave shows as faces; the viewer's own day (their Leave or
  // lateness) is a word under the date.
  const leaveTypes = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(marksByDate)) for (const m of list) if (m.kind === 'leave' && m.leave_type) set.add(m.leave_type);
    return Array.from(set).sort();
  }, [marksByDate]);
  const marksFor = (dateStr: string) => (marksByDate[dateStr] || []).filter((m) => matchesFilter(m, filter));

  // The viewer's own mark as a word, everyone else's Leave as faces.
  const renderMarks = (dateStr: string, isToday: boolean) => {
    const all = marksFor(dateStr);
    if (all.length === 0) return null;
    const mine = all.find((m) => m.user_id === me);
    const marks = all.filter((m) => m.user_id !== me);
    const mineStyle = mine ? markStyle(mine) : null;
    const word = mineStyle && (
      <span
        className={`inline-flex items-center gap-1 font-bold uppercase tracking-wide ${large ? 'text-[10px]' : 'text-[7px]'} ${
          isToday && large ? 'text-white' : mineStyle.text
        }`}
      >
        {large && <span className={`w-1.5 h-1.5 rounded-full ${mineStyle.dot}`} />}
        {mineStyle.label}
      </span>
    );
    if (marks.length === 0) return word;
    const max = large ? (word ? 2 : 3) : word ? 1 : 2;
    return (
      <>
        {word}
        <span className="flex items-center -space-x-1.5">
        {marks.slice(0, max).map((m) => (
          <span key={m.user_id} className={`rounded-full ring-2 ${markStyle(m).ring} bg-white`}>
            <PersonPhoto
              userId={m.user_id}
              name={personById.get(m.user_id)?.name || '?'}
              token={token}
              className={large ? 'w-6 h-6' : 'w-4 h-4'}
            />
          </span>
        ))}
        {marks.length > max && (
          <span
            className={`relative rounded-full bg-slate-700 text-white font-bold flex items-center justify-center ring-2 ring-white ${
              large ? 'w-6 h-6 text-[9px]' : 'w-4 h-4 text-[7px]'
            }`}
          >
            +{marks.length - max}
          </span>
        )}
      </span>
      </>
    );
  };
  const openDayMarks = openDay ? marksFor(openDay.date) : [];

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

      <div className={`flex items-center justify-between gap-2 ${large ? 'px-6 pt-3' : 'px-4 pt-2.5 pb-2.5 border-b border-white/40'}`}>
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
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as MarkFilter)}
          className={`rounded-lg border font-medium text-slate-600 outline-none focus:ring-2 focus:ring-blue-200 ${
            large ? 'border-slate-200 bg-slate-50 px-3 py-1.5 text-xs' : 'border-white/60 bg-white/60 px-2.5 py-1 text-[11px]'
          }`}
          aria-label="Show"
        >
          <option value="all">All</option>
          <option value="delay">Delay</option>
          <option value="extreme">Extreme Delay</option>
          <option value="leave">Leave</option>
          {leaveTypes.map((t) => (
            <option key={t} value={`type:${t}`}>
              {t} leave
            </option>
          ))}
        </select>
      </div>

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
              const hasMarks = cell.inCurrentMonth && marksFor(cell.dateStr).length > 0;
              // Bigger square cells with room for a day-type label under the
              // number, same look HolidayCalendarPanel's own Admin grid uses.
              return (
                <div
                  key={cell.dateStr}
                  title={entry ? `${entry.title} (${dayTypeLabel(entry.day_type)})` : undefined}
                  onClick={hasMarks ? (e) => setOpenDay({ date: cell.dateStr, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                  className={`${hasMarks ? 'cursor-pointer' : ''} relative h-16 flex flex-col items-center justify-center gap-0.5 rounded-xl text-sm ${
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
                  {cell.inCurrentMonth && renderMarks(cell.dateStr, isToday)}
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
              const hasMarks = cell.inCurrentMonth && marksFor(cell.dateStr).length > 0;
              return (
                <div
                  key={cell.dateStr}
                  title={entry ? `${entry.title} (${dayTypeLabel(entry.day_type)})` : undefined}
                  onClick={hasMarks ? (e) => setOpenDay({ date: cell.dateStr, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                  className={`${hasMarks ? 'cursor-pointer' : ''} relative ${hasMarks && marksFor(cell.dateStr).some((m) => m.user_id !== me) ? 'h-[60px]' : dates.sub ? 'h-14' : 'h-12'} flex flex-col items-center justify-center gap-0.5 border-b border-r border-white/40 text-[11px] transition-colors ${
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
                  {cell.inCurrentMonth && renderMarks(cell.dateStr, isToday)}
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
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Approved
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-white ring-2 ring-inset ring-emerald-500" /> Pending
        </span>
        {loading && <span className="ml-auto text-slate-300">Loading…</span>}
      </div>

      {/* A day's people — liquid-glass card anchored under the tapped day. */}
      {openDay &&
        openDayMarks.length > 0 &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setOpenDay(null)} onWheel={() => setOpenDay(null)} onTouchMove={() => setOpenDay(null)} />
            <div
              className="fixed z-[91] w-[260px]"
              style={{
                left: Math.max(12, Math.min(openDay.rect.left + openDay.rect.width / 2 - 130, window.innerWidth - 272)),
                ...(openDay.rect.bottom + 260 > window.innerHeight
                  ? { bottom: window.innerHeight - openDay.rect.top + 6 }
                  : { top: openDay.rect.bottom + 6 })
              }}
            >
              <div className="liquid-glass liquid-glass-in rounded-[32px] p-3">
                <div className="flex items-center justify-between px-2 pb-2">
                  <span className="text-xs font-bold text-slate-700">
                    {Number(openDay.date.slice(8))} {MONTH_LABELS[Number(openDay.date.slice(5, 7)) - 1]}
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpenDay(null)}
                    className="liquid-glass-chip w-7 h-7 rounded-full flex items-center justify-center text-slate-500"
                    aria-label="Close"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="liquid-glass-inset rounded-2xl p-1.5 max-h-[240px] overflow-y-auto">
                  {openDayMarks.map((m) => {
                    const st = markStyle(m);
                    const name = personById.get(m.user_id)?.name || 'Unknown';
                    return (
                      <div key={m.user_id} className="flex items-center gap-2.5 px-2 py-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                        <PersonPhoto userId={m.user_id} name={name} token={token} className="w-7 h-7 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-800 truncate">{name}</div>
                          <div className={`text-[11px] font-medium ${st.text}`}>{st.detail}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
};