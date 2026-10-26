/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

// Unit of an asset requisition / fulfilment line: type any unit, or pick one
// from the list that opens under the field (every unit when the field is
// opened, the matching ones while typing). Replaces an <input list> whose
// datalist only ever offered "pcs" — a datalist shows the options matching
// what is already typed, the field started as "pcs", and Android WebViews
// hardly show datalists at all. The list is drawn on document.body so a
// scrolling popup or a table cell doesn't cut it off.

export const ASSET_UNITS = ['pcs', 'box', 'set', 'pair', 'dozen', 'packet', 'ream', 'roll', 'sheet', 'bottle', 'carton', 'bag', 'kg', 'gram', 'litre', 'metre', 'feet', 'unit'];

export const UnitPicker: React.FC<{
  value: string;
  onChange: (unit: string) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, className = '', disabled, required, ariaLabel = 'Unit' }) => {
  const [open, setOpen] = useState(false);
  // Typed since the list opened: then it shows only the matching units.
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  // While typing: units starting with it first, then those containing it.
  const options =
    typing && q ? [...ASSET_UNITS.filter((u) => u.startsWith(q)), ...ASSET_UNITS.filter((u) => !u.startsWith(q) && u.includes(q))] : ASSET_UNITS;

  const place = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 220 && r.top > below;
    setPos({ left: r.left, top: up ? r.top : r.bottom, width: Math.max(r.width, 140), up });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);
  // Close on a tap outside the field and the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useEffect(() => {
    if (!open || !list.current) return;
    (list.current.querySelector(`[data-i="${active}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const show = () => {
    if (disabled) return;
    setTyping(false);
    setActive(Math.max(0, ASSET_UNITS.indexOf(q)));
    setOpen(true);
  };
  const pick = (u: string) => {
    onChange(u);
    setOpen(false);
    setTyping(false);
  };

  return (
    <div ref={wrap} className="relative">
      <input
        ref={input}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setTyping(true);
          setActive(0);
          setOpen(true);
        }}
        onFocus={show}
        onClick={() => !open && show()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) return show();
            const n = options.length;
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter' && open && options[active]) {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
        }}
        placeholder="pcs, box, kg…"
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        required={required}
        className={`${className} !pr-7`}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Show units"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else {
            input.current?.focus();
            show();
          }
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-40"
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            className="fixed z-[200] max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl py-1"
            style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}
          >
            {options.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-500">
                Use “<span className="font-semibold text-slate-700">{value.trim()}</span>” as the unit
              </div>
            ) : (
              options.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  role="option"
                  data-i={i}
                  aria-selected={u === q}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(u)}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full text-left px-3 py-2 text-sm ${i === active ? 'bg-blue-50 text-blue-800' : 'text-slate-700'} ${u === q ? 'font-semibold' : ''}`}
                >
                  {u}
                </button>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  );
};
