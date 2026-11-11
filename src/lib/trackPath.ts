/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> a person's path: which recorded points are drawn as
// the route and which are left out of it. Nothing is deleted — left-out points
// can still be shown ("Show rough points") and stay in the table / report.
//
//   mock     the phone said the fix came from a mock-location ("fake GPS")
//            app — always shown, in red, never part of the route.
//   accuracy the phone's own error estimate is worse than MAX_ACCURACY_M
//            (Wi-Fi / mobile-tower guesses when GPS can't be had, often
//            hundreds of metres off — the long straight jumps on the map).
//   jump     a single point out of line: getting there and back would mean
//            moving faster than MAX_SPEED_KMH, or it sits SPIKE_M+ away while
//            the points just before and after it are close together (an
//            out-and-back spike a few minutes long). A real trip keeps going
//            the same way, or leaves several points, so it is kept.

export const MAX_ACCURACY_M = 100;
export const MAX_SPEED_KMH = 120;
export const SPIKE_M = 250;
const SPIKE_WINDOW_MS = 10 * 60 * 1000;

export type RoughReason = 'mock' | 'accuracy' | 'jump';

export interface TrackPoint {
  lat: number | string;
  lng: number | string;
  recorded_at: string;
  accuracy_m?: number | null;
  is_mock?: number | boolean | null;
}

export interface CleanedPath<P extends TrackPoint> {
  // In time order.
  route: P[];
  rough: (P & { rough: RoughReason })[];
}

const toRad = (d: number) => (d * Math.PI) / 180;
export function metersBetween(a: TrackPoint, b: TrackPoint): number {
  const lat1 = Number(a.lat);
  const lat2 = Number(b.lat);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const ms = (p: TrackPoint) => new Date(p.recorded_at).getTime();

// km/h between two points; at least 5 s apart so two fixes in the same
// second don't read as infinite speed.
function kmh(a: TrackPoint, b: TrackPoint): number {
  const sec = Math.max(5, Math.abs(ms(b) - ms(a)) / 1000);
  return (metersBetween(a, b) / sec) * 3.6;
}

export function cleanPath<P extends TrackPoint>(points: P[], maxAccuracyM = MAX_ACCURACY_M, maxSpeedKmh = MAX_SPEED_KMH): CleanedPath<P> {
  const sorted = [...points].sort((a, b) => ms(a) - ms(b));
  const rough: (P & { rough: RoughReason })[] = [];
  const good: P[] = [];
  for (const p of sorted) {
    if (p.is_mock === true || Number(p.is_mock) === 1) rough.push({ ...p, rough: 'mock' });
    else if (p.accuracy_m != null && Number(p.accuracy_m) > maxAccuracyM) rough.push({ ...p, rough: 'accuracy' });
    else good.push(p);
  }
  // Out-and-back spikes among what is left.
  const route: P[] = [];
  for (let i = 0; i < good.length; i++) {
    const p = good[i];
    const prev = route[route.length - 1];
    const next = good[i + 1];
    if (prev && next) {
      const fast = kmh(prev, p) > maxSpeedKmh && kmh(p, next) > maxSpeedKmh && kmh(prev, next) <= maxSpeedKmh;
      const out = Math.min(metersBetween(prev, p), metersBetween(p, next));
      const spike = out > SPIKE_M && metersBetween(prev, next) < out * 0.3 && ms(next) - ms(prev) <= SPIKE_WINDOW_MS;
      if (fast || spike) {
        rough.push({ ...p, rough: 'jump' });
        continue;
      }
    }
    route.push(p);
  }
  rough.sort((a, b) => ms(a) - ms(b));
  return { route, rough };
}

export const ROUGH_LABEL: Record<RoughReason, string> = {
  mock: 'Fake GPS (mock location)',
  accuracy: 'Rough fix — not GPS',
  jump: 'Jump — out of line'
};
