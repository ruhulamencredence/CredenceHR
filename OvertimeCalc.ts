/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Overtime — the arithmetic only (no database), so it can be tested on its
// own. OvertimeRoutes.ts gathers each person's day (roster shift, relief duty,
// office device punches, app check-in / out, Site Attendance muster) and asks
// otForDay() how much of it is overtime and how much of that is already
// approved; otRateFor() turns hours into money.
//
// Times are "wall minutes": minutes since 1970-01-01 00:00 of the clock on the
// wall in Dhaka (the database keeps local times as text — dateStrings).

export type OtRateType = "labour_law" | "fixed" | "gross";
export type OtApproverMode = "supervisor" | "roster_manager" | "either" | "both";

export interface OtRules {
  rate_type: OtRateType;
  divisor: number; // hours a month the salary pays for (208 = 8 h x 26 days)
  multiplier: number; // working day
  off_multiplier: number; // Off day / Weekend / Holiday
  fixed_rate: number; // ৳ an hour (rate_type "fixed")
  fixed_off_rate: number; // ৳ an hour on an Off day (0 = fixed_rate)
  min_minutes: number; // less than this after the shift is not overtime
  round_minutes: number; // rounded down to this (0 = no rounding)
  daily_max_minutes: number; // more than this on a working day is flagged (0 = no limit)
  monthly_max_minutes: number; // payable a month at most (0 = no limit)
  only_approved: boolean; // false = everything worked out is paid without approval
  planned_counts_approved: boolean; // OT built into a shift / set in the roster is approved by itself
  approver_mode: OtApproverMode;
  office_start: string; // "HH:MM" — a working day with no roster shift
  office_end: string;
}

export const DEFAULT_OT_RULES: OtRules = {
  rate_type: "labour_law",
  divisor: 208,
  multiplier: 2,
  off_multiplier: 2,
  fixed_rate: 0,
  fixed_off_rate: 0,
  min_minutes: 30,
  round_minutes: 30,
  daily_max_minutes: 120,
  monthly_max_minutes: 0,
  only_approved: true,
  planned_counts_approved: true,
  approver_mode: "supervisor",
  office_start: "09:00",
  office_end: "18:00"
};

export interface OtShift {
  start_time: string; // "HH:MM[:SS]"
  end_time: string;
  // Hours the salary pays for; the rest of the shift is overtime when
  // extra_mode is "ot", part of the salary when "salary". null = the whole
  // shift is normal time.
  normal_minutes: number | null;
  extra_mode: "ot" | "salary";
}

export const hm = (t: string) => {
  const [h, m] = String(t || "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
// "YYYY-MM-DD" -> wall minutes at its midnight.
export const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`) / 60000;
// "YYYY-MM-DD HH:MM[:SS]" (or an ISO string) -> wall minutes.
export const wallMinutes = (v: any): number | null => {
  if (!v) return null;
  const s = String(v).trim().replace(" ", "T").replace(/Z$|[+-]\d{2}:\d{2}$/, "");
  const t = Date.parse(`${s.length === 16 ? `${s}:00` : s}Z`);
  return Number.isFinite(t) ? Math.round(t / 60000) : null;
};
export const wallText = (m: number | null) => {
  if (m == null) return null;
  const d = new Date(m * 60000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}:00`;
};

// [start, end] of a shift on `date`, in wall minutes (a night shift ends the
// next morning).
export function shiftSpan(date: string, s: { start_time: string; end_time: string }) {
  const base = dayStart(date);
  const a = base + hm(s.start_time);
  let b = base + hm(s.end_time);
  if (b <= a) b += 1440;
  return [a, b] as const;
}

// The part of a day's duty window that is that day's: from 4 h before the
// duty starts to 6 h after it ends — but never reaching into the day before's
// or the day after's duty, so a night shift's morning check-out isn't read as
// the next day's work.
export const EARLY_MIN = 240;
export const LATE_MIN = 360;

export interface OtDayInput {
  date: string;
  // "normal": a working day; "off": a rostered Off day, or a Weekend /
  // Holiday with no shift rostered.
  kind: "normal" | "off";
  shift: OtShift | null; // the roster's shift; null on a working day = office hours
  relief: OtShift | null; // an extra relief duty this date (Duty Roster -> Posts)
  planned_minutes: number; // OT set in the roster for this day
  stamps: number[]; // every In / Out / punch around this day, wall minutes
  prev_duty_end: number | null; // wall minutes the day before's duty ended
  next_duty_start: number | null; // wall minutes the day after's duty starts
}

export interface OtDayResult {
  in_at: number | null;
  out_at: number | null;
  worked_minutes: number;
  missing_out: boolean;
  built_in_minutes: number; // earned from a shift's built-in OT
  after_minutes: number; // after the shift's end (rounded), or the whole Off day
  calc_minutes: number; // built_in + after
  auto_minutes: number; // already approved (planned)
  over_limit_minutes: number;
}

const roundDown = (m: number, step: number) => (step > 0 ? Math.floor(m / step) * step : m);
const counted = (m: number, r: OtRules) => (m >= Math.max(0, r.min_minutes) && m > 0 ? roundDown(m, r.round_minutes) : 0);

export function dutyWindow(d: Pick<OtDayInput, "date" | "kind" | "shift" | "relief" | "prev_duty_end" | "next_duty_start">, r: OtRules) {
  const spans: (readonly [number, number])[] = [];
  if (d.kind === "normal") spans.push(shiftSpan(d.date, d.shift || { start_time: r.office_start, end_time: r.office_end }));
  if (d.relief) spans.push(shiftSpan(d.date, d.relief));
  let from: number;
  let to: number;
  if (spans.length) {
    from = Math.min(...spans.map((s) => s[0])) - EARLY_MIN;
    to = Math.max(...spans.map((s) => s[1])) + LATE_MIN;
  } else {
    // An Off day with nothing rostered: the calendar day, and the early hours
    // of the next.
    from = dayStart(d.date);
    to = dayStart(d.date) + 1440 + EARLY_MIN;
  }
  if (d.prev_duty_end != null) from = Math.max(from, d.prev_duty_end + LATE_MIN);
  if (d.next_duty_start != null) to = Math.min(to, d.next_duty_start - EARLY_MIN);
  return { from, to, spans };
}

export function otForDay(d: OtDayInput, r: OtRules): OtDayResult {
  const { from, to } = dutyWindow(d, r);
  const inside = d.stamps.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const inAt = inside.length ? inside[0] : null;
  const outAt = inside.length > 1 && inside[inside.length - 1] > inside[0] ? inside[inside.length - 1] : null;
  const zero: OtDayResult = { in_at: inAt, out_at: outAt, worked_minutes: 0, missing_out: inAt != null && outAt == null, built_in_minutes: 0, after_minutes: 0, calc_minutes: 0, auto_minutes: 0, over_limit_minutes: 0 };
  if (inAt == null || outAt == null) return zero;
  const worked = outAt - inAt;
  let builtIn = 0;
  let after = 0;
  let overLimit = 0;
  if (d.kind === "off") {
    after = counted(worked, r);
  } else {
    const shift = d.shift || { start_time: r.office_start, end_time: r.office_end, normal_minutes: null, extra_mode: "ot" as const };
    const [s, e] = shiftSpan(d.date, shift);
    const len = e - s;
    const normal = shift.normal_minutes != null && shift.normal_minutes > 0 ? Math.min(shift.normal_minutes, len) : len;
    const builtInMax = shift.extra_mode === "ot" ? len - normal : 0;
    if (builtInMax > 0) {
      const overlap = Math.max(0, Math.min(outAt, e) - Math.max(inAt, s));
      builtIn = Math.max(0, Math.min(builtInMax, overlap - normal));
    }
    after = counted(Math.max(0, outAt - e), r);
    if (r.daily_max_minutes > 0 && after > r.daily_max_minutes) overLimit = after - r.daily_max_minutes;
  }
  const calc = builtIn + after;
  let auto = (r.planned_counts_approved ? builtIn : 0) + Math.min(after, Math.max(0, d.planned_minutes || 0));
  if (!r.only_approved) auto = calc;
  return { in_at: inAt, out_at: outAt, worked_minutes: worked, missing_out: false, built_in_minutes: builtIn, after_minutes: after, calc_minutes: calc, auto_minutes: Math.min(auto, calc), over_limit_minutes: overLimit };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
export interface OtRateOverride {
  rate_type: OtRateType;
  rate: number | null; // ৳ an hour, for "fixed"
  off_rate: number | null;
}

// ৳ an hour on a working day and on an Off day. An Employee's own rate wins
// over their designation's, which wins over the rules.
export function otRateFor(rules: OtRules, salary: { basic: number; gross: number }, override: OtRateOverride | null) {
  const type = override?.rate_type || rules.rate_type;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // normal / off are shown (2 decimals); exact_* are what amounts are
  // worked out from, so 18 h x 115.3846 = 2,076.92 (not 18 x 115.38).
  if (type === "fixed") {
    const normal = override ? Number(override.rate) || 0 : rules.fixed_rate;
    const off = override ? Number(override.off_rate) || normal : rules.fixed_off_rate || rules.fixed_rate;
    return { type, normal: r2(normal), off: r2(off), exact_normal: normal, exact_off: off };
  }
  const base = type === "gross" ? salary.gross : salary.basic;
  const perHour = rules.divisor > 0 ? (Number(base) || 0) / rules.divisor : 0;
  return { type, normal: r2(perHour * rules.multiplier), off: r2(perHour * rules.off_multiplier), exact_normal: perHour * rules.multiplier, exact_off: perHour * rules.off_multiplier };
}

// The month's payable minutes (normal / off) cut to the monthly limit — the
// working-day minutes go first.
export function capMonthly(normal: number, off: number, maxMinutes: number) {
  if (!(maxMinutes > 0) || normal + off <= maxMinutes) return { normal, off };
  const n = Math.min(normal, maxMinutes);
  return { normal: n, off: Math.max(0, maxMinutes - n) };
}
