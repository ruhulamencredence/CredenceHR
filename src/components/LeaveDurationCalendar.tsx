/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { formatDate } from '../lib/formatDate';

interface LeaveDurationCalendarProps {
  // Both "YYYY-MM-DD". A single selected day (no range chosen yet) is simply
  // startDate === endDate — same shape NewLeaveApplicationModal already keeps
  // in its own startDate/endDate state, so this component owns no date state
  // of its own beyond which month the popup is currently showing.
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateStr = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

interface Cell {
  dateStr: string;
  day: number;
  inCurrentMonth: boolean;
}

// Builds a fixed 6-row (42 cell) grid — leading days from the previous month,
// every day of the shown month, then trailing days from the next month — so
// the grid height never jumps around while navigating between months.
function buildGrid(year: number, month: number): Cell[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const totalInMonth = daysInMonth(year, month);
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const totalInPrevMonth = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  const cells: Cell[] = [];
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

// "Leave Duration" — collapses to a single field (calendar icon, "Select
// Duration" placeholder / the chosen date(s), chevron), same as the rest of
// this form's other fields. Tapping it drops down a floating range calendar
// instead of the old separate Start Date / End Date inputs: first tap picks
// a single day (start === end); a second tap on a later day completes the
// range (highlighting every day in between); tapping again after a range is
// already complete starts a fresh one. Tapping a day before the current
// start restarts the selection there instead of forming a backwards range.
//
// The popup itself is portaled straight onto document.body and positioned
// with `fixed` coordinates measured off the trigger button — same reasoning
// as NewConveyanceClaimModal/NewLeaveApplicationModal's own portal: this
// field sits inside the modal's scrolling body, and a plain absolutely-
// positioned dropdown (like the Approver picker's) would get clipped by that
// scroll container the moment the calendar is taller than the remaining
// visible space below the trigger.
export const LeaveDurationCalendar: React.FC<LeaveDurationCalendarProps> = ({ startDate, endDate, onChange }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const initial = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());

  const cells = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  // Fixed compact size regardless of how wide the trigger field is — the old
  // `Math.max(rect.width, POPUP_WIDTH)` made the popup match (or exceed) the
  // trigger's own width, so on a wide desktop form the calendar stretched
  // out and every day cell (aspect-square, one of 7 columns) blew up along
  // with it. Capped at POPUP_WIDTH now, only shrinking below that on a
  // viewport narrower than the popup plus margins.
  const POPUP_WIDTH = 320;
  const POPUP_GAP = 6;
  // Rough height for the very first placement, before the popup has actually
  // mounted and can be measured (header + weekday row + 6 grid rows + footer
  // at POPUP_WIDTH). The layout effect below immediately corrects this to
  // the real measured height, so this only needs to be close enough that the
  // opening position doesn't visibly jump.
  const ESTIMATED_POPUP_HEIGHT = 400;

  // Placed above the trigger field (opens upward) on both mobile and web, so
  // it never covers the field or the "Purpose"/"Approver" fields right below
  // it. Falls back to below only when there truly isn't room above — e.g.
  // the field is pinned near the very top of the screen.
  const reposition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);

    const height = popupRef.current?.offsetHeight ?? ESTIMATED_POPUP_HEIGHT;
    const top =
      rect.top - POPUP_GAP - height >= 8 ? rect.top - POPUP_GAP - height : rect.bottom + POPUP_GAP;
    setCoords({ top, left, width });
  };

  const openPopup = () => {
    // Jump the calendar back to whichever month the current selection is in
    // every time it's reopened, so a stale month from an earlier browse
    // isn't left showing.
    const d = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    reposition();
    setOpen(true);
  };

  // Corrects the "open upward" placement using the popup's real measured
  // height as soon as it's actually in the DOM (runs before the browser
  // paints, so there's no visible flicker from the estimated-height guess
  // used for the very first placement in openPopup/reposition above).
  useLayoutEffect(() => {
    if (open) reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    reposition();

    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Scroll can happen on the modal's own scrolling body, which doesn't
    // bubble a 'scroll' event up to window — listening during the capture
    // phase still catches it on its way down. Rather than closing the popup
    // (which made it feel disconnected from the field on mobile, where the
    // whole form scrolls to reach it), this now re-measures the trigger's
    // position and moves the popup along with it, so it tracks the "Leave
    // Duration" field instead of being left floating over a stale spot.
    // Only if the field itself scrolls fully out of view does it close.
    const handleScroll = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      reposition();
    };
    const handleResize = () => reposition();

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const goPrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const goNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handlePick = (dateStr: string) => {
    const hasCompleteRange = !!startDate && !!endDate && startDate !== endDate;
    if (!startDate || hasCompleteRange) {
      // Nothing picked yet, or a full range is already sitting there — this
      // tap starts a brand new single-day selection.
      onChange(dateStr, dateStr);
    } else if (dateStr < startDate) {
      // Tapped before the current single-day start — restart there instead
      // of forming a backwards range.
      onChange(dateStr, dateStr);
    } else {
      // Completes the range from the existing start through this day.
      onChange(startDate, dateStr);
    }
  };

  const dayCount = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const s = new Date(`${startDate}T00:00:00`);
    const e = new Date(`${endDate}T00:00:00`);
    return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  }, [startDate, endDate]);

  const label = !startDate
    ? 'Select Duration'
    : startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} \u2013 ${formatDate(endDate)}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPopup())}
        className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-left focus:ring-2 focus:ring-blue-600 focus:outline-none"
      >
        <span className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <CalendarDays className="w-4 h-4 text-blue-600" />
        </span>
        <span className={`min-w-0 flex-1 text-sm truncate ${startDate ? 'font-semibold text-slate-800' : 'text-slate-400'}`}>
          {label}
        </span>
        <ChevronDown className={`w-4 h-4 text-blue-600 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-[60] bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden"
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            <div className="flex items-center justify-between px-3 py-2.5">
              <button type="button" onClick={goPrevMonth} className="p-1.5 rounded-lg hover:bg-slate-100 text-blue-600 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-bold text-slate-900">
                {MONTH_LABELS[viewMonth]} {viewYear}
              </span>
              <button type="button" onClick={goNextMonth} className="p-1.5 rounded-lg hover:bg-slate-100 text-blue-600 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 bg-slate-100">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="py-1.5 text-center text-[11px] font-semibold text-slate-500">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {cells.map((cell, i) => {
                const isStart = cell.dateStr === startDate;
                const isEnd = cell.dateStr === endDate;
                const inRange = !!startDate && !!endDate && cell.dateStr > startDate && cell.dateStr < endDate;
                const isEdge = isStart || isEnd;
                const col = i % 7;
                // Rounds the light-purple range background into a capsule: square
                // corners only get rounded where a run of highlighted days starts
                // or ends — at the actual start/end date, or at a week boundary
                // (Sun/Sat) for a range that spans multiple rows.
                const roundLeft = isStart || (inRange && col === 0);
                const roundRight = isEnd || (inRange && col === 6);

                return (
                  <button
                    key={cell.dateStr + i}
                    type="button"
                    onClick={() => handlePick(cell.dateStr)}
                    className={`relative aspect-square flex items-center justify-center text-sm transition-colors ${
                      inRange || isEdge ? 'bg-blue-50' : ''
                    } ${roundLeft ? 'rounded-l-full' : ''} ${roundRight ? 'rounded-r-full' : ''}`}
                  >
                    <span
                      className={`w-8 h-8 flex items-center justify-center rounded-full font-medium ${
                        isEdge
                          ? 'bg-blue-600 text-white font-semibold'
                          : cell.inCurrentMonth
                          ? 'text-slate-700'
                          : 'text-slate-300'
                      }`}
                    >
                      {cell.day}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-100">
              <span className="text-xs text-slate-500">
                {startDate ? `${dayCount} ${dayCount === 1 ? 'Day' : 'Days'} selected` : 'No date selected'}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
              >
                Done
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};