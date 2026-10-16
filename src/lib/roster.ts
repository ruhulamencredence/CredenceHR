/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Duty Roster (RosterRoutes.ts) — the shift shape and time labels shared by
// Admin Panel -> Duty Roster and Self Service -> My Duty Roster.

export interface Shift {
  id: number;
  name: string;
  code: string;
  start_time: string;
  end_time: string;
  grace_minutes: number | null;
  extreme_grace_minutes: number | null;
  color: string;
  crosses_midnight: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
};
export const shiftTime = (s: Pick<Shift, 'start_time' | 'end_time'>) => `${hhmm(s.start_time)} – ${hhmm(s.end_time)}`;
