/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning } from 'lucide-react';

interface WeatherData {
  temperature: number;
  weatherCode: number;
  fetchedAt: number;
}

interface WeatherBadgeProps {
  // Matches Navbar's own transparentHeader — white text on the native app's
  // purple gradient header, muted gray on the plain web header.
  transparent?: boolean;
}

// Fallback point (Dhaka) when the device's own location isn't already
// available — this badge deliberately never PROMPTS for location access on
// its own (see getCoords below): it only uses a fix that's already been
// granted for something else (Remote Attendance, login capture, etc.), so a
// fresh session never gets a surprise permission dialog just for the header.
const FALLBACK_COORDS = { latitude: 23.8103, longitude: 90.4125 };

const CACHE_KEY = 'mpr_weather_cache_v1';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — plenty fresh for a header badge, keeps this to one free API call every half hour per device.

// Open-Meteo's WMO weather_code -> icon/label, grouped the way its own docs
// group them (https://open-meteo.com/en/docs -> "WMO Weather interpretation
// codes"). Every used icon is one lucide-react already ships.
function weatherIconFor(code: number): React.ComponentType<{ className?: string }> {
  if (code === 0) return Sun;
  if (code === 1) return CloudSun;
  if (code === 2 || code === 3) return Cloud;
  if (code === 45 || code === 48) return CloudFog;
  if ([51, 53, 55, 56, 57].includes(code)) return CloudDrizzle;
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return CloudRain;
  if ([71, 73, 75, 77, 85, 86].includes(code)) return CloudSnow;
  if (code === 95 || code === 96 || code === 99) return CloudLightning;
  return Cloud;
}

function weatherLabelFor(code: number): string {
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67].includes(code)) return 'Rain';
  if ([80, 81, 82].includes(code)) return 'Rain showers';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if (code === 95 || code === 96 || code === 99) return 'Thunderstorm';
  return 'Weather';
}

// Only ever resolves a REAL device fix if location access is already
// granted — never triggers the OS/browser permission prompt itself,
// unlike AttendanceCard.tsx's getCurrentCoords (which exists specifically
// to prompt, for an explicit Check In/Out tap). Falls back to
// FALLBACK_COORDS otherwise, so the badge still shows something useful
// rather than nothing.
async function getCoords(): Promise<{ latitude: number; longitude: number }> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const status = await Geolocation.checkPermissions();
      if (status.location !== 'granted') return FALLBACK_COORDS;
      const pos = await Geolocation.getCurrentPosition({ timeout: 8000 });
      return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch {
      return FALLBACK_COORDS;
    }
  }

  if (!navigator.geolocation || !navigator.permissions) return FALLBACK_COORDS;
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    if (status.state !== 'granted') return FALLBACK_COORDS;
    return await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve(FALLBACK_COORDS),
        { timeout: 8000 }
      );
    });
  } catch {
    return FALLBACK_COORDS;
  }
}

// Small "current weather" badge for the header — free, no API key: reads
// Open-Meteo (https://open-meteo.com), which needs neither. Renders nothing
// at all until a reading is actually in hand (no loading spinner/skeleton —
// this is a minor header decoration, not something worth drawing attention
// to while it loads), and nothing forever if the fetch fails (offline,
// Open-Meteo unreachable) — every other header control keeps working
// regardless.
export const WeatherBadge: React.FC<WeatherBadgeProps> = ({ transparent }) => {
  const [weather, setWeather] = useState<WeatherData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cachedRaw = localStorage.getItem(CACHE_KEY);
        if (cachedRaw) {
          const cached: WeatherData = JSON.parse(cachedRaw);
          if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            if (!cancelled) setWeather(cached);
            return;
          }
        }
      } catch {
        // Corrupt/unavailable cache — just falls through and refetches below.
      }

      try {
        const { latitude, longitude } = await getCoords();
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`
        );
        if (!res.ok) return;
        const data = await res.json();
        const temperature = Math.round(Number(data?.current?.temperature_2m));
        const weatherCode = Number(data?.current?.weather_code);
        if (!Number.isFinite(temperature)) return;
        const fresh: WeatherData = { temperature, weatherCode, fetchedAt: Date.now() };
        if (!cancelled) setWeather(fresh);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
        } catch {
          // No cache next load — harmless, just refetches.
        }
      } catch {
        // Offline or Open-Meteo unreachable — badge stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!weather) return null;

  const Icon = weatherIconFor(weather.weatherCode);

  return (
    <div
      className={`flex items-center gap-1 shrink-0 ${transparent ? 'text-white' : ''}`}
      style={transparent ? undefined : { color: 'var(--g-text-muted)' }}
      title={weatherLabelFor(weather.weatherCode)}
    >
      <Icon className="w-[18px] h-[18px]" />
      <span className="text-xs font-medium">{weather.temperature}&deg;C</span>
    </div>
  );
};
