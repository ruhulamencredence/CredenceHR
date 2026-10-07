/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Spreadsheet-style column menu for a table header, like Google Sheets' filter:
//   - Sort A → Z / Z → A (and Clear sort)
//   - a list of the column's unique values with a tick each, "Select all" and
//     "Clear", a search box and an "x/y selected" count; unticking a value hides
//     the rows that have it.
// The caller decides which values to offer (usually: the values still showing
// after every OTHER column's filter) via getValues(), called when the menu opens.
// The tick state is returned as the list of UNticked values, so a value that
// shows up later is visible by default.
//
// Also exports ColumnToggleMenu — the "Columns" button that shows/hides columns.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownAZ, ArrowDownZA, ArrowUpDown, Check, Columns3, Filter, Search, X } from 'lucide-react';

export type SortDir = 'asc' | 'desc';
export const BLANK_LABEL = '(Blank)';

// Anchors a floating card under a button, flipped/clamped so it stays on screen.
function useAnchoredPosition(open: boolean, anchor: React.RefObject<HTMLElement | null>, width: number) {
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number }>({ top: 0, left: 0, maxH: 400 });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
      const top = r.bottom + 6;
      setPos({ top, left, maxH: Math.max(240, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, width]);
  return pos;
}

interface ColumnFilterMenuProps {
  label: string;
  getValues: () => string[];
  excluded: string[];
  sortDir: SortDir | null;
  onSort: (dir: SortDir | null) => void;
  onChange: (excluded: string[]) => void;
  /** Ordinary white dropdown (no blurred backdrop) instead of the liquid-glass popup. */
  plain?: boolean;
}

const SHOW_LIMIT = 300;

export const ColumnFilterMenu: React.FC<ColumnFilterMenuProps> = ({ label, getValues, excluded, sortDir, onSort, onChange, plain }) => {
  const cBackdrop = plain ? '' : 'liquid-glass-backdrop';
  const cCard = plain ? 'bg-white border border-slate-200 shadow-xl rounded-xl' : 'liquid-glass liquid-glass-in rounded-[24px]';
  const cInset = plain ? 'bg-slate-50 border border-slate-200' : 'liquid-glass-inset';
  const cChip = plain ? 'bg-slate-100 hover:bg-slate-200' : 'liquid-glass-chip';
  const cOk = plain ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'liquid-glass-button';
  const cHover = plain ? 'hover:bg-slate-100' : 'hover:bg-white/60';
  const cRule = plain ? 'border-slate-200' : 'border-white/50';
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const pos = useAnchoredPosition(open, btnRef, 288);
  const active = excluded.length > 0 || sortDir !== null;

  const openMenu = () => {
    const v = getValues();
    const ex = new Set(excluded);
    setValues(v);
    setChecked(new Set(v.filter((x) => !ex.has(x))));
    setQuery('');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? values.filter((v) => (v === '' ? BLANK_LABEL : v).toLowerCase().includes(q)) : values;
  }, [values, query]);
  const allShownChecked = shown.length > 0 && shown.every((v) => checked.has(v));

  const toggle = (v: string) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  // Select all / Clear act on what the search box currently lists (like Sheets).
  const setShown = (on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      for (const v of shown) {
        if (on) n.add(v);
        else n.delete(v);
      }
      return n;
    });

  const apply = () => {
    onChange(values.filter((v) => !checked.has(v)));
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-label={`Sort and filter ${label}`}
        title={`Sort & filter — ${label}`}
        className={`shrink-0 p-0.5 rounded transition-colors ${active ? 'text-blue-700 bg-blue-100' : 'text-slate-400 hover:text-slate-700 hover:bg-white/70'}`}
      >
        {sortDir === 'asc' ? <ArrowDownAZ className="w-3 h-3" /> : sortDir === 'desc' ? <ArrowDownZA className="w-3 h-3" /> : excluded.length > 0 ? <Filter className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
      </button>
      {open &&
        createPortal(
          <div className={`${cBackdrop} fixed inset-0 z-[1200]`} onMouseDown={() => setOpen(false)} role="presentation">
            <div style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className={`${cCard} flex flex-col overflow-hidden text-slate-800 normal-case font-normal`} style={{ maxHeight: pos.maxH }} role="dialog" aria-label={`${label} menu`}>
                <div className="px-3.5 pt-3 pb-1 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 truncate">{label}</span>
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className={`${cChip} p-1 rounded-full text-slate-600`}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="px-2 pb-1 space-y-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSort('asc');
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-xs font-semibold text-left ${cHover} ${sortDir === 'asc' ? 'text-blue-700' : ''}`}
                  >
                    <ArrowDownAZ className="w-3.5 h-3.5" /> Sort A → Z {sortDir === 'asc' && <Check className="w-3 h-3 ml-auto" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSort('desc');
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-xs font-semibold text-left ${cHover} ${sortDir === 'desc' ? 'text-blue-700' : ''}`}
                  >
                    <ArrowDownZA className="w-3.5 h-3.5" /> Sort Z → A {sortDir === 'desc' && <Check className="w-3 h-3 ml-auto" />}
                  </button>
                  {sortDir && (
                    <button
                      type="button"
                      onClick={() => {
                        onSort(null);
                        setOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-xs text-slate-600 text-left ${cHover}`}
                    >
                      <X className="w-3.5 h-3.5" /> Clear sort
                    </button>
                  )}
                </div>
                <div className={`mx-3 border-t ${cRule}`} />
                <div className="px-3 pt-2">
                  <div className={`${cInset} rounded-xl flex items-center gap-1.5 px-2 py-1.5`}>
                    <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search values"
                      className="w-full bg-transparent text-xs outline-none placeholder-slate-400"
                    />
                  </div>
                  <div className="flex items-center justify-between mt-2 text-[11px]">
                    <button type="button" onClick={() => setShown(!allShownChecked)} className="inline-flex items-center gap-1.5 font-semibold text-blue-700 hover:underline">
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${allShownChecked ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-400 bg-white/70'}`}>
                        {allShownChecked && <Check className="w-2.5 h-2.5" />}
                      </span>
                      Select all
                    </button>
                    <span className="text-slate-600 tabular-nums">
                      {checked.size}/{values.length} selected
                    </span>
                    <button type="button" onClick={() => setShown(false)} className="font-semibold text-slate-600 hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className={`${cInset} rounded-xl mx-3 mt-2 overflow-y-auto min-h-[60px] flex-1`}>
                  {shown.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-slate-500">No values.</p>
                  ) : (
                    shown.slice(0, SHOW_LIMIT).map((v) => (
                      <label key={v === '' ? '\u0000blank' : v} className={`flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer ${cHover}`}>
                        <input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} className="accent-blue-600 shrink-0" />
                        <span className={`truncate ${v === '' ? 'text-slate-400 italic' : ''}`} title={v || BLANK_LABEL}>
                          {v === '' ? BLANK_LABEL : v}
                        </span>
                      </label>
                    ))
                  )}
                  {shown.length > SHOW_LIMIT && <p className="px-3 py-2 text-[10px] text-slate-500">Showing the first {SHOW_LIMIT} of {shown.length} — search to narrow.</p>}
                </div>
                <div className="px-3 py-3 flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} className={`${cChip} rounded-full px-3.5 py-1.5 text-xs font-semibold text-slate-700`}>
                    Cancel
                  </button>
                  <button type="button" onClick={apply} className={`${cOk} rounded-full px-4 py-1.5 text-xs font-semibold`}>
                    OK
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

// "Columns" button: tick the optional columns you want on the table.
export const ColumnToggleMenu: React.FC<{
  options: { key: string; label: string }[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
  plain?: boolean;
}> = ({ options, hidden, onChange, plain }) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pos = useAnchoredPosition(open, btnRef, 224);
  const hiddenSet = new Set(hidden);
  const toggle = (k: string) => onChange(hiddenSet.has(k) ? hidden.filter((h) => h !== k) : [...hidden, k]);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-colors"
      >
        <Columns3 className="w-3.5 h-3.5" /> Columns
        {hidden.length > 0 && <span className="px-1.5 rounded-full bg-slate-200 text-[10px]">{options.length - hidden.length}/{options.length}</span>}
      </button>
      {open &&
        createPortal(
          <div className={`${plain ? '' : 'liquid-glass-backdrop'} fixed inset-0 z-[1200]`} onMouseDown={() => setOpen(false)} role="presentation">
            <div style={{ position: 'fixed', top: pos.top, left: pos.left, width: 224 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className={`${plain ? 'bg-white border border-slate-200 shadow-xl rounded-xl' : 'liquid-glass liquid-glass-in rounded-[24px]'} p-3 text-slate-800`} role="dialog" aria-label="Columns">
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <span className="text-xs font-bold text-slate-900">Show columns</span>
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className={`${plain ? 'bg-slate-100 hover:bg-slate-200' : 'liquid-glass-chip'} p-1 rounded-full text-slate-600`}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className={`${plain ? 'bg-slate-50 border border-slate-200' : 'liquid-glass-inset'} rounded-xl py-1`}>
                  {options.map((o) => (
                    <label key={o.key} className={`flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer ${plain ? 'hover:bg-slate-100' : 'hover:bg-white/60'}`}>
                      <input type="checkbox" checked={!hiddenSet.has(o.key)} onChange={() => toggle(o.key)} className="accent-blue-600" />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
