/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office machine (ZKTeco) double punch.
//
// The machine has no In / Out button: the app takes a day's first punch as
// the In and the last one as the Out. Someone who taps twice on arrival (the
// sensor didn't beep, a retry) used to get an Out a few seconds after the In
// — the day read "checked out", and the real Out could no longer be given
// from the app.
//
// The rule: a machine punch counts as the day's Out only if it is at least
// N minutes after the day's In (the earliest In, from the machine or the
// app). Earlier punches are still kept and shown as punches — nothing is
// deleted — they just aren't the Out.
//
// It changes nothing before it was turned on: every rule has an
// "effective from" date, a day uses the rule in force on that day, and a day
// before the first rule uses the old behaviour (any later punch is the Out).
// A change only ever starts today, so a past day — a closed month, a report
// already sent — reads the same as it always did.
//
// Only the Out is affected. The In, Present / Absent, late marks and the
// salary (which counts present days and the first In) stay exactly as they
// were.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// What is put in place the first time, from that day on.
export const DEFAULT_DOUBLE_PUNCH_MINUTES = 5;
export const MAX_DOUBLE_PUNCH_MINUTES = 120;

export async function ensurePunchRuleSchema(dbPool: any, today: string): Promise<void> {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS zk_punch_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        double_punch_minutes INT NOT NULL,
        effective_from DATE NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_zk_punch_rules_from (effective_from)
      )
    `);
    const [rows]: any = await dbPool.query("SELECT COUNT(*) AS n FROM zk_punch_rules");
    if (!Number(rows?.[0]?.n)) {
      await dbPool.query("INSERT INTO zk_punch_rules (double_punch_minutes, effective_from) VALUES (?, ?)", [DEFAULT_DOUBLE_PUNCH_MINUTES, today]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not ensure zk_punch_rules: " + err.message);
  }
}

export type PunchRuleRow = { id: number; double_punch_minutes: number; effective_from: string; created_by: number | null; created_at: any };

// A "YYYY-MM-DD" from a DATE column / Date / string, the way the rest of the
// attendance code reads dates (server-local for a Date object).
export const dayOf = (v: any): string => (v instanceof Date ? v.toLocaleDateString("en-CA") : String(v ?? "").slice(0, 10));
const ms = (v: any): number => (v instanceof Date ? v.getTime() : v ? new Date(v).getTime() : NaN);

let cache: { at: number; rows: PunchRuleRow[] } | null = null;
const CACHE_MS = 30 * 1000;
export function forgetPunchRules() {
  cache = null;
}

export async function loadPunchRuleRows(queryDB: QueryDB): Promise<PunchRuleRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows: any[] = (await queryDB("/*unscoped*/ SELECT * FROM zk_punch_rules ORDER BY effective_from ASC, id ASC").catch(() => [])) || [];
  const clean = rows.map((r: any) => ({
    id: Number(r.id),
    double_punch_minutes: Math.max(0, Number(r.double_punch_minutes) || 0),
    effective_from: dayOf(r.effective_from),
    created_by: r.created_by != null ? Number(r.created_by) : null,
    created_at: r.created_at
  }));
  cache = { at: Date.now(), rows: clean };
  return clean;
}

export type PunchGap = (day: any) => number;

// The rule as a function: a day -> the minimum gap in milliseconds between
// the In and a machine punch that may be the Out (0 = the old behaviour).
export async function loadPunchGap(queryDB: QueryDB): Promise<PunchGap> {
  const rows = await loadPunchRuleRows(queryDB);
  return (day: any) => {
    const d = dayOf(day);
    let minutes = 0;
    // Rows are oldest first; the last one in force on that day wins.
    for (const r of rows) if (r.effective_from <= d) minutes = r.double_punch_minutes;
    return minutes * 60 * 1000;
  };
}

// May this machine punch be the Out of a day whose In was `inAt`? Only the
// extra condition: each caller keeps its own "after the In" test, so with
// a gap of 0 nothing changes at all.
export function farEnoughFromIn(gapMs: number, inAt: any, punchAt: any): boolean {
  if (!(gapMs > 0)) return true;
  const a = ms(inAt);
  const b = ms(punchAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return b - a >= gapMs;
}

// The same for "HH:MM" times of one day (Site Attendance works in those).
export function farEnoughHHMM(gapMs: number, inHHMM: string, punchHHMM: string): boolean {
  if (!(gapMs > 0)) return true;
  const m = (s: string) => {
    const [h, mi] = String(s).split(":").map(Number);
    return h * 60 + mi;
  };
  const a = m(inHHMM);
  const b = m(punchHHMM);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  // Whole minutes only: a punch counts once it is at least the gap later.
  return (b - a) * 60 * 1000 >= gapMs;
}
