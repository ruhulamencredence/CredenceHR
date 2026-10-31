// A filter button that opens a searchable checkbox list (pick several).
// Empty selection = no filter. Used by lists that narrow by Department,
// Designation, user, template… — type a few letters, tick as many as needed.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface MultiOption {
  value: string;
  label: string;
  /** How many rows it would show — 0 is greyed out. */
  count?: number;
}

export const MultiSelectFilter: React.FC<{
  label: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  width?: number;
}> = ({ label, options, selected, onChange, width = 288 }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, maxH: 256 });

  // The list floats on the page (portal), so a short or scrolling table
  // around the button can't cut it off.
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const place = () => {
      const r = box.current!.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const listH = Math.min(256, Math.max(below, above) - 96);
      if (below >= 220 || below >= above) setPos({ top: r.bottom + 6, left, maxH: Math.max(120, Math.min(256, below - 96)) });
      else setPos({ top: Math.max(8, r.top - 6 - (listH + 96)), left, maxH: Math.max(120, listH) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);
  const chosen = new Set(selected);
  const toggle = (v: string) => onChange(chosen.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const allShownOn = shown.length > 0 && shown.every((o) => chosen.has(o.value));
  const toggleShown = () => {
    if (allShownOn) onChange(selected.filter((v) => !shown.some((o) => o.value === v)));
    else onChange([...new Set([...selected, ...shown.map((o) => o.value)])]);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQ(''); }}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border ${selected.length ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
      >
        {label}
        {selected.length > 0 && <span className="px-1.5 rounded-full bg-blue-600 text-white text-[10px]">{selected.length}</span>}
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && createPortal(
        <div ref={panel} className="fixed z-[90] bg-white border border-slate-200 shadow-xl rounded-xl" style={{ width, top: pos.top, left: pos.left }}>
          <div className="p-2.5 border-b border-slate-100">
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} className="flex-1 bg-transparent text-xs outline-none" />
              {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search"><X className="w-3 h-3 text-slate-400" /></button>}
            </div>
            <div className="flex items-center justify-between mt-2 text-[11px]">
              <button type="button" onClick={toggleShown} className="font-semibold text-blue-700 hover:underline disabled:opacity-40" disabled={shown.length === 0}>
                {allShownOn ? 'Unselect all shown' : 'Select all shown'}
              </button>
              <button type="button" onClick={() => onChange([])} className="font-semibold text-slate-500 hover:underline disabled:opacity-40" disabled={selected.length === 0}>
                Clear ({selected.length})
              </button>
            </div>
          </div>
          <div className="overflow-y-auto py-1" style={{ maxHeight: pos.maxH }}>
            {shown.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 text-center">Nothing matches.</div>
            ) : (
              shown.slice(0, 300).map((o) => (
                <button key={o.value} type="button" onClick={() => toggle(o.value)} className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-slate-50">
                  <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${chosen.has(o.value) ? 'bg-blue-600 border-blue-600' : 'border-slate-300'}`}>
                    {chosen.has(o.value) && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className={`truncate ${o.count === 0 ? 'text-slate-400' : 'text-slate-800'}`}>{o.label}</span>
                  {o.count !== undefined && <span className="ml-auto pl-2 text-[11px] text-slate-400 tabular-nums">{o.count}</span>}
                </button>
              ))
            )}
            {shown.length > 300 && <div className="px-3 py-2 text-[11px] text-slate-400">Showing the first 300 — type to narrow.</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
