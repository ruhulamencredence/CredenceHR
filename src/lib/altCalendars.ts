/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Bengali (Bangabda) and Hijri dates for a Gregorian date — used by the
// Dashboard calendar's English / বাংলা / Hijri switch (HolidayCalendarWidget).

export type CalendarSystem = 'english' | 'bengali' | 'hijri';

export interface AltDate {
  day: number;
  month: number; // 0-indexed
  year: number;
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export const toBengaliDigits = (v: number | string) => String(v).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

export const BENGALI_MONTHS = [
  'বৈশাখ', 'জ্যৈষ্ঠ', 'আষাঢ়', 'শ্রাবণ', 'ভাদ্র', 'আশ্বিন',
  'কার্তিক', 'অগ্রহায়ণ', 'পৌষ', 'মাঘ', 'ফাল্গুন', 'চৈত্র'
];
export const BENGALI_WEEKDAYS_SHORT = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
export const BENGALI_GREGORIAN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'
];

export const HIJRI_MONTHS = [
  'Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Ula', 'Jumada al-Akhirah',
  'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qi'dah", 'Dhu al-Hijjah'
];

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 86400000;

// Bangladesh's revised Bangla calendar (Bangla Academy, in use since 1426 /
// 2019): 1 Boishakh is always 14 April; Boishakh–Ashwin have 31 days,
// Kartik–Magh and Chaitra 30, Falgun 29 — 30 when that Falgun falls in a
// Gregorian leap year.
export function toBengaliDate(y: number, m: number, d: number): AltDate {
  const startYear = m > 3 || (m === 3 && d >= 14) ? y : y - 1;
  let offset = utcDay(y, m, d) - utcDay(startYear, 3, 14);
  const lengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, isLeap(startYear + 1) ? 30 : 29, 30];
  let month = 0;
  while (month < 11 && offset >= lengths[month]) {
    offset -= lengths[month];
    month++;
  }
  return { day: offset + 1, month, year: startYear - 593 };
}

// Hijri (Umm al-Qura) from the browser's own Islamic calendar. Bangladesh
// fixes its months by local moon sighting, so a date here can be a day off
// the local announcement.
let hijriFormat: Intl.DateTimeFormat | null | undefined;
function getHijriFormat(): Intl.DateTimeFormat | null {
  if (hijriFormat !== undefined) return hijriFormat;
  for (const ca of ['islamic-umalqura', 'islamic']) {
    try {
      const f = new Intl.DateTimeFormat(`en-u-ca-${ca}`, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
      if (f.resolvedOptions().calendar.startsWith('islamic')) return (hijriFormat = f);
    } catch {
      /* try the next one */
    }
  }
  return (hijriFormat = null);
}

export function toHijriDate(y: number, m: number, d: number): AltDate | null {
  const f = getHijriFormat();
  if (!f) return null;
  const parts = f.formatToParts(new Date(Date.UTC(y, m, d)));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value?.replace(/\D/g, '') || NaN);
  const day = get('day');
  const month = get('month');
  const year = get('year');
  if (!day || !month || !year) return null;
  return { day, month: month - 1, year };
}

// "আশ্বিন – কার্তিক ১৪৩৩" / "Rabi' al-Thani – Jumada al-Ula 1448 AH": the
// alternate-calendar months a Gregorian month spans.
export function altMonthTitle(system: CalendarSystem, year: number, month: number): string {
  if (system === 'english') return '';
  const last = new Date(year, month + 1, 0).getDate();
  const conv = system === 'bengali' ? toBengaliDate : toHijriDate;
  const a = conv(year, month, 1);
  const b = conv(year, month, last);
  if (!a || !b) return '';
  const names = system === 'bengali' ? BENGALI_MONTHS : HIJRI_MONTHS;
  const yr = (v: number) => (system === 'bengali' ? toBengaliDigits(v) : `${v} AH`);
  if (a.month === b.month && a.year === b.year) return `${names[a.month]} ${yr(a.year)}`;
  if (a.year === b.year) return `${names[a.month]} – ${names[b.month]} ${yr(b.year)}`;
  return `${names[a.month]} ${yr(a.year)} – ${names[b.month]} ${yr(b.year)}`;
}
