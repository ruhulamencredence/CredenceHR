/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A ride's estimated duration is stored in hours (vehicle_requisitions.
// estimated_duration_hours, DECIMAL(5,2)); people pick it as minutes, hours,
// a half day or a full day (DurationPicker.tsx), and read it back the same way.

export const HALF_DAY_HOURS = 4;
export const FULL_DAY_HOURS = 8;
export const MIN_RIDE_MINUTES = 5;
export const MAX_RIDE_HOURS = 240;

export const DURATION_PRESETS: { hours: number; label: string }[] = [
  { hours: 0.25, label: '15 min' },
  { hours: 0.5, label: '30 min' },
  { hours: 0.75, label: '45 min' },
  { hours: 1, label: '1 hr' },
  { hours: 1.5, label: '1 hr 30 min' },
  { hours: 2, label: '2 hrs' },
  { hours: 3, label: '3 hrs' },
  { hours: HALF_DAY_HOURS, label: `Half day (${HALF_DAY_HOURS} hrs)` },
  { hours: 5, label: '5 hrs' },
  { hours: 6, label: '6 hrs' },
  { hours: FULL_DAY_HOURS, label: `Full day (${FULL_DAY_HOURS} hrs)` }
];

// "45 min", "1 hr 30 min", "Half day (4 hrs)", "10 hrs".
export function formatDuration(hours: number | string | null | undefined): string {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '—';
  const minutes = Math.round(h * 60);
  if (minutes === HALF_DAY_HOURS * 60) return `Half day (${HALF_DAY_HOURS} hrs)`;
  if (minutes === FULL_DAY_HOURS * 60) return `Full day (${FULL_DAY_HOURS} hrs)`;
  if (minutes < 60) return `${minutes} min`;
  const hr = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hr} hr${hr === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`;
}
