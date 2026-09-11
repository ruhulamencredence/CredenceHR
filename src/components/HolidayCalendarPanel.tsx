/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { CalendarDays, Plus, Trash2, Edit2, X, Sun, CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { HolidayEntry, HolidayDayType } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

interface HolidayCalendarPanelProps {
  token: string;
}

interface FormState {
  entry_date: string;
  day_type: HolidayDayType;
  title: string;
}

const emptyForm: FormState = { entry_date: '', day_type: 'holiday', title: '' };

const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' }
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

// Builds a fixed 6-row (42 cell) grid — leading days from the previous month,
// every day of the shown month, then trailing days from the next month — so
// the grid height never jumps around while navigating between months. Same
// approach as LeaveDurationCalendar's own buildGrid().
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


// Admin Panel -> Holidays: one shared calendar of "Weekend" and "Holiday"
// dates, gated behind the 'holidays' Admin Panel module (only accounts the
// Superadmin grants this to can see/use this tab at all). Any date added here
// is picked up automatically by the Monthly/Date-Wise Attendance Report and by
// every account's own Timesheet — those never mark an employee Absent on a
// date that shows up here.
export const HolidayCalendarPanel: React.FC<HolidayCalendarPanelProps> = ({ token }) => {
  const [entries, setEntries] = useState<HolidayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // The month grid below — shows every Weekend/Holiday date at a glance,
  // colored on the calendar itself, instead of only as a text list.
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const todayStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // "Mark every Friday as Weekend" quick-add.
  const [showBulk, setShowBulk] = useState(false);
  const [bulkFrom, setBulkFrom] = useState('');
  const [bulkTo, setBulkTo] = useState('');
  const [bulkWeekday, setBulkWeekday] = useState(5); // Friday, most common regional weekend day
  const [bulkTitle, setBulkTitle] = useState('Weekend');
  const [bulkSaving, setBulkSaving] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/holidays'), { headers: authHeaders });
      if (res.ok) setEntries(await res.json());
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const openAddForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEditForm = (e: HolidayEntry) => {
    setEditingId(e.id);
    setForm({ entry_date: e.entry_date, day_type: e.day_type, title: e.title });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.entry_date) {
      setMessage({ type: 'error', text: 'Please choose a date.' });
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? apiUrl(`/api/holidays/${editingId}`) : apiUrl('/api/holidays');
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Could not save this entry.' });
        return;
      }
      setMessage({ type: 'success', text: editingId ? 'Entry updated.' : 'Added to the calendar.' });
      setShowForm(false);
      setForm(emptyForm);
      setEditingId(null);
      fetchAll();
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Remove this date from the calendar?')) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/holidays/${id}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error || 'Could not remove this entry.' });
        return;
      }
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setMessage({ type: 'success', text: 'Removed from the calendar.' });
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkSave = async () => {
    if (!bulkFrom || !bulkTo) {
      setMessage({ type: 'error', text: 'Please choose a from/to date range.' });
      return;
    }
    setBulkSaving(true);
    try {
      const res = await fetch(apiUrl('/api/holidays/bulk-weekly'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: bulkFrom, to: bulkTo, weekday: bulkWeekday, title: bulkTitle })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Could not add these dates.' });
        return;
      }
      setMessage({ type: 'success', text: `Added ${data.inserted} date${data.inserted === 1 ? '' : 's'} to the calendar.` });
      setShowBulk(false);
      fetchAll();
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setBulkSaving(false);
    }
  };

  // Only future-or-today entries surface first, past entries trail below —
  // makes the upcoming Holidays/Weekends the first thing an Admin sees.
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = entries.filter((e) => e.entry_date >= today);
  const past = entries.filter((e) => e.entry_date < today).slice().reverse();

  // "YYYY-MM-DD" -> its calendar entry, for O(1) lookup while painting the grid.
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

  // Clicking a day on the grid: an already-marked date opens it for editing;
  // an empty date opens the Add form pre-filled with that date, so the
  // calendar itself is the fastest way to add a new entry too.
  const handleCellClick = (cell: GridCell) => {
    const existing = entryByDate.get(cell.dateStr);
    if (existing) {
      openEditForm(existing);
    } else {
      setEditingId(null);
      setForm({ ...emptyForm, entry_date: cell.dateStr });
      setShowForm(true);
    }
  };

  const Row: React.FC<{ e: HolidayEntry }> = ({ e }) => (
    <div className="flex items-center justify-between gap-3 border border-slate-200 rounded-xl p-3.5 hover:bg-slate-50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            e.day_type === 'weekend' ? 'bg-sky-50 text-sky-600' : 'bg-amber-50 text-amber-600'
          }`}
        >
          {e.day_type === 'weekend' ? <CalendarClock className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{e.title}</p>
          <p className="text-xs text-slate-500">
            {formatDate(e.entry_date)} •{' '}
            <span className={e.day_type === 'weekend' ? 'text-sky-600' : 'text-amber-600'}>
              {e.day_type === 'weekend' ? 'Weekend' : 'Holiday'}
            </span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => openEditForm(e)}
          className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          title="Edit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => handleDelete(e.id)}
          disabled={deletingId === e.id}
          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
          title="Remove"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-blue-600" /> Global Calendar
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Dates set here are excluded from Absent in Attendance Reports and everyone's Timesheet — for
            everyone, automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowBulk(true)}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5"
          >
            <CalendarClock className="w-3.5 h-3.5" /> Mark a Weekday
          </button>
          <button
            type="button"
            onClick={openAddForm}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Add Date
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 px-4 py-3 rounded-xl text-xs font-medium ${
            message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Month grid — every Weekend/Holiday date shown right on the calendar
          (amber = Holiday, sky blue = Weekend), not just as a text list below.
          Click an empty day to add it; click a marked day to edit/remove it. */}
      <div className="border border-slate-200 rounded-2xl overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
          <button
            type="button"
            onClick={goPrevMonth}
            className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-white rounded-lg transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <p className="text-sm font-bold text-slate-900">
            {MONTH_LABELS[calMonth]} {calYear}
          </p>
          <button
            type="button"
            onClick={goNextMonth}
            className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-white rounded-lg transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 bg-slate-100">
          {WEEKDAY_LABELS.map((w) => (
            <div key={w} className="py-2 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {gridCells.map((cell) => {
            const entry = entryByDate.get(cell.dateStr);
            const isToday = cell.dateStr === todayStr;
            return (
              <button
                type="button"
                key={cell.dateStr}
                onClick={() => cell.inCurrentMonth && handleCellClick(cell)}
                disabled={!cell.inCurrentMonth}
                title={entry ? `${entry.title} (${entry.day_type === 'weekend' ? 'Weekend' : 'Holiday'})` : cell.inCurrentMonth ? 'Click to add' : undefined}
                className={`relative h-14 sm:h-16 flex flex-col items-center justify-center gap-0.5 border-b border-r border-slate-100 text-xs transition-colors ${
                  !cell.inCurrentMonth
                    ? 'text-slate-200 bg-slate-50/50 cursor-default'
                    : entry
                      ? entry.day_type === 'weekend'
                        ? 'bg-sky-50 hover:bg-sky-100 text-sky-700'
                        : 'bg-amber-50 hover:bg-amber-100 text-amber-700'
                      : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className={`font-semibold ${isToday && cell.inCurrentMonth ? 'w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center' : ''}`}>
                  {cell.day}
                </span>
                {entry && cell.inCurrentMonth && (
                  <span className="text-[9px] font-bold uppercase tracking-wide truncate max-w-[90%]">
                    {entry.day_type === 'weekend' ? 'Weekend' : 'Holiday'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CalendarDays className="w-10 h-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No Weekend or Holiday dates set yet.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {upcoming.length > 0 && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-2">Upcoming</p>
              <div className="space-y-2">
                {upcoming.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-2">Past</p>
              <div className="space-y-2">
                {past.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add / Edit single date */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !saving && setShowForm(false)}
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-900">{editingId ? 'Edit Date' : 'Add Date'}</h3>
              <button
                onClick={() => setShowForm(false)}
                disabled={saving}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Date</label>
                <input
                  type="date"
                  value={form.entry_date}
                  disabled={!!editingId}
                  onChange={(e) => setForm((f) => ({ ...f, entry_date: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Type</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, day_type: 'holiday' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                      form.day_type === 'holiday' ? 'bg-amber-50 border-amber-300 text-amber-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    Holiday
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, day_type: 'weekend' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                      form.day_type === 'weekend' ? 'bg-sky-50 border-sky-300 text-sky-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    Weekend
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder={form.day_type === 'weekend' ? 'Weekend' : 'e.g. Independence Day'}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setShowForm(false)}
                disabled={saving}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk "mark every X-day as Weekend" */}
      {showBulk && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !bulkSaving && setShowBulk(false)}
        >
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-900">Mark a Weekday as Weekend</h3>
              <button
                onClick={() => setShowBulk(false)}
                disabled={bulkSaving}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Marks every occurrence of one weekday as "Weekend" across a date range, instead of adding each date
                one by one. Dates already on the calendar are left untouched.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">From</label>
                  <input
                    type="date"
                    value={bulkFrom}
                    onChange={(e) => setBulkFrom(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">To</label>
                  <input
                    type="date"
                    value={bulkTo}
                    onChange={(e) => setBulkTo(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Weekday</label>
                <select
                  value={bulkWeekday}
                  onChange={(e) => setBulkWeekday(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Title</label>
                <input
                  type="text"
                  value={bulkTitle}
                  onChange={(e) => setBulkTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setShowBulk(false)}
                disabled={bulkSaving}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkSave}
                disabled={bulkSaving}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {bulkSaving ? 'Adding...' : 'Add Dates'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
