/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Free, no-API-key reverse geocoding via OpenStreetMap's Nominatim — the same
// service LocationMapPicker's forward place-name search already calls — used
// to turn a Movement Claim's raw Check In/Out lat/lng into a short, readable
// place name for the "My Claims" list instead of a bare coordinate pair.
//
// Nominatim's public usage policy caps requests at ~1/second, so every call
// funnels through a single queue with a minimum gap between them, and
// results are cached by rounded coordinate so the same spot (e.g. an office
// gate used as a Check In point on many claims) is only ever looked up once.

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<void> = Promise.resolve();
const MIN_GAP_MS = 1100;

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// Nominatim's `display_name` is a full postal address (e.g. "12, Road 4,
// Zafrabad, Mohammadpur, Dhaka District, Dhaka Division, 1207, Bangladesh")
// — keep only the first few comma-separated parts so it reads like a place
// name rather than a full mailing address.
function shorten(displayName: string, parts = 3, dropPostcodeAndCountry = false): string {
  return displayName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !dropPostcodeAndCountry || !(/^\d{3,6}$/.test(p) || /^bangladesh$/i.test(p)))
    .slice(0, parts)
    .join(', ');
}

// `lang` (e.g. 'en') asks for the address in that language — the PDF reports'
// font can't draw Bangla script, so they ask for English. `full` keeps up to
// six parts (house, road, area, city…) without the postcode and country,
// for reports where the area matters.
export function reverseGeocode(lat: number, lng: number, lang?: string, full = false): Promise<string | null> {
  // Defensive: callers occasionally pass through a DB-sourced DECIMAL field that
  // arrived over JSON as a numeric string (see MyClaimsCard.tsx) — coerce here too
  // so a slip at a call site degrades to "no address found" instead of crashing
  // the caller's render (a bare NaN.toFixed()/fetch with lat=NaN would throw/404).
  lat = Number(lat);
  lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Promise.resolve(null);

  const key = `${coordKey(lat, lng)}${lang ? `|${lang}` : ''}${full ? '|full' : ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const result = queue.then(async () => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18${lang ? `&accept-language=${encodeURIComponent(lang)}` : ''}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data?.display_name === 'string' ? (full ? shorten(data.display_name, 6, true) : shorten(data.display_name)) : null;
    } catch {
      return null;
    }
  });

  // Chained after the lookup itself (not just its scheduling) so the next
  // queued call always waits the full gap from when this one actually
  // finished, not from when it merely started.
  queue = result.then(() => new Promise((resolve) => setTimeout(resolve, MIN_GAP_MS)));
  cache.set(key, result);
  return result;
}
