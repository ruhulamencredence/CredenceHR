/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Est. Duration for a ride: 15/30/45 min, 1–6 hrs, Half day, Full day, or
// Custom (a number of minutes or hours). value / onChange are in hours, the
// unit the server stores (src/lib/rideDuration.ts).

import React, { useEffect, useState } from 'react';
import { DURATION_PRESETS, MAX_RIDE_HOURS, MIN_RIDE_MINUTES } from '../lib/rideDuration';

const CUSTOM = 'custom';
const isPreset = (h: number) => DURATION_PRESETS.some((p) => Math.abs(p.hours - h) < 1e-6);

export function DurationPicker({
  value,
  onChange,
  className,
  id
}: {
  value: number;
  onChange: (hours: number) => void;
  className: string;
  id?: string;
}) {
  const [custom, setCustom] = useState(() => !isPreset(Number(value)));
  const [unit, setUnit] = useState<'min' | 'hr'>(() => (Number(value) < 1 ? 'min' : 'hr'));
  const [amount, setAmount] = useState(() => (Number(value) < 1 ? String(Math.round(Number(value) * 60)) : String(Number(value) || '')));

  // A form reset (value back to a preset) leaves Custom.
  useEffect(() => {
    if (!custom) return;
    const shown = unit === 'min' ? Number(amount) / 60 : Number(amount);
    if (Math.abs(shown - Number(value)) > 1e-6 && isPreset(Number(value))) setCustom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fromCustom = (a: string, u: 'min' | 'hr') => {
    setAmount(a);
    setUnit(u);
    const n = Number(a);
    onChange(Number.isFinite(n) && n > 0 ? (u === 'min' ? n / 60 : n) : 0);
  };

  return (
    <div className="space-y-2">
      <select
        id={id}
        aria-label="Est. Duration"
        value={custom ? CUSTOM : String(value)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            const v = Number(value) || 1;
            setUnit(v < 1 ? 'min' : 'hr');
            setAmount(v < 1 ? String(Math.round(v * 60)) : String(v));
            return;
          }
          setCustom(false);
          onChange(Number(e.target.value));
        }}
        className={`${className} w-full`}
      >
        {DURATION_PRESETS.map((p) => (
          <option key={p.hours} value={String(p.hours)}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
          <input
            type="number"
            required
            aria-label="Duration amount"
            min={unit === 'min' ? MIN_RIDE_MINUTES : 0.25}
            max={unit === 'min' ? MAX_RIDE_HOURS * 60 : MAX_RIDE_HOURS}
            step={unit === 'min' ? 1 : 0.25}
            value={amount}
            onChange={(e) => fromCustom(e.target.value, unit)}
            className={`${className} w-full min-w-0`}
          />
          <select aria-label="Duration unit" value={unit} onChange={(e) => fromCustom(amount, e.target.value as 'min' | 'hr')} className={`${className} w-full`}>
            <option value="min">minutes</option>
            <option value="hr">hours</option>
          </select>
        </div>
      )}
    </div>
  );
}
