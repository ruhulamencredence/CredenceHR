/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Every date shown anywhere in the app's tables goes through this — dd-mmm-yyyy,
// no time (e.g. "18-Aug-2026"), regardless of what shape the value arrives in:
// a plain "YYYY-MM-DD" string (most API date fields), a full ISO timestamp
// (mysql2 sends DATE/TIMESTAMP columns as "2026-08-18T00:00:00.000Z" once JSON
// round-trips them, since the pool isn't using the dateStrings option), or an
// actual JS Date instance.
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';

  let year: number, month: number, day: number;

  if (value instanceof Date) {
    year = value.getFullYear();
    month = value.getMonth();
    day = value.getDate();
  } else {
    const str = String(value).trim();
    if (!str) return '';
    // Pull the "YYYY-MM-DD" out of the front of the string directly (rather than
    // going through `new Date(str)`) so a date-only value never gets shifted a day
    // by the local timezone's offset from UTC.
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return str; // not a recognizable date — show whatever we were given
    year = Number(match[1]);
    month = Number(match[2]) - 1;
    day = Number(match[3]);
  }

  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  if (month < 0 || month > 11 || Number.isNaN(year) || Number.isNaN(day)) return String(value);
  return `${String(day).padStart(2, '0')}-${MONTHS[month]}-${year}`;
}

// Today's date as "YYYY-MM-DD", read from the browser's LOCAL date components
// (getFullYear/getMonth/getDate) rather than `new Date().toISOString()` — the latter
// converts to UTC, which reads as yesterday for the first several hours of every day
// in timezones ahead of UTC (e.g. Bangladesh, UTC+6, midnight–5:59am local).
export function todayDateOnlyString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Every date (inclusive) between `from` and `to` (both "YYYY-MM-DD") — powers the
// SELECT-only Delivery Date picker used everywhere a Budget/Job has a bounded
// Delivery Date window, so an out-of-range date can't even be typed in (a plain
// text/typed date input can be made to hold an out-of-range value — the server
// always re-validates it and would reject it, but a picker that simply can't
// represent an invalid value is a better experience than a rejected submit).
// Shared by the "New Job Entry" MPR form and the "Job Edit" Add MPR form so both
// present exactly the same Delivery Date picker.
export function dateRangeOptions(from: string, to: string): string[] {
  const out: string[] = [];
  // Parsed as explicit UTC ('Z' suffix) and stepped with setUTCDate so the string
  // we push out never gets shifted by the browser's local timezone offset — without
  // this, `new Date(\`${from}T00:00:00\`)` (no 'Z') is interpreted as LOCAL midnight,
  // and toISOString() then converts that back to UTC, which for timezones ahead of
  // UTC (e.g. Bangladesh, UTC+6) rolls every date in the list back by one day.
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  // Guard against an accidentally huge range (e.g. a typo'd year) turning into an
  // unusably long dropdown.
  const MAX_DAYS = 1000;
  for (let d = new Date(start), i = 0; d <= end && i < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const formatDateLabel = (iso: string): string => formatDate(iso) || iso;