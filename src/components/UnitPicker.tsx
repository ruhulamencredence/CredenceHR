/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';

// Unit of an asset requisition / fulfilment line. A plain dropdown of the
// usual units plus "Other…" for anything else (typed). It replaces an
// <input list> whose datalist only ever offered "pcs": a datalist shows the
// options matching what is already typed, and the field started as "pcs";
// Android WebViews barely show datalists at all.

export const ASSET_UNITS = ['pcs', 'box', 'set', 'pair', 'dozen', 'packet', 'ream', 'roll', 'sheet', 'bottle', 'carton', 'bag', 'kg', 'gram', 'litre', 'metre', 'feet', 'unit'];
const OTHER = '__other__';

export const UnitPicker: React.FC<{
  value: string;
  onChange: (unit: string) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, className = '', disabled, required, ariaLabel = 'Unit' }) => {
  const known = ASSET_UNITS.includes(value.trim().toLowerCase());
  // "Other…" picked (or a unit saved earlier that isn't in the list).
  const [custom, setCustom] = useState(!!value.trim() && !known);
  if (custom) {
    return (
      <div className="relative">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type the unit"
          aria-label={ariaLabel}
          disabled={disabled}
          required={required}
          autoFocus={!value}
          className={`${className} !pr-7`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setCustom(false);
            onChange('pcs');
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          title="Pick from the list instead"
          aria-label="Pick from the list instead"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <select
      value={known ? value.trim().toLowerCase() : 'pcs'}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setCustom(true);
          onChange('');
        } else onChange(e.target.value);
      }}
      aria-label={ariaLabel}
      disabled={disabled}
      required={required}
      className={className}
    >
      {ASSET_UNITS.map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
      <option value={OTHER}>Other…</option>
    </select>
  );
};
