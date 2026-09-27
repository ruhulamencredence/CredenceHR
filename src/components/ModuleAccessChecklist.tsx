/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> Module Access: the multi-tick lists inside a module
// (Department access for Monthly Attendance Report / Monthly Leave
// Application / Conveyance Bill Claim, and Permission Layers) with a
// "Select all" box and, for longer lists, a search box. "Select all" acts on
// what the search currently shows.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export interface ChecklistItem {
  key: string;
  label: string;
  badge?: string;
}

interface ModuleAccessChecklistProps {
  items: ChecklistItem[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  onSetMany: (keys: string[], checked: boolean) => void;
  tone: 'amber' | 'violet';
  // Lists at least this long get a search box.
  searchFrom?: number;
  searchPlaceholder?: string;
  layout?: 'list' | 'grid';
}

const TONE = {
  amber: { item: 'border-amber-100 hover:bg-amber-100/40', box: 'text-amber-600 focus:ring-amber-600', badge: 'text-amber-700' },
  violet: { item: 'border-violet-100 hover:bg-violet-100/40', box: 'text-violet-600 focus:ring-violet-600', badge: 'text-violet-700' }
};

export function ModuleAccessChecklist({
  items,
  selected,
  onToggle,
  onSetMany,
  tone,
  searchFrom = 7,
  searchPlaceholder = 'Search…',
  layout = 'list'
}: ModuleAccessChecklistProps) {
  const [query, setQuery] = useState('');
  const t = TONE[tone];
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items), [items, q]);
  const checkedVisible = visible.filter((i) => selected.has(i.key)).length;
  const allChecked = visible.length > 0 && checkedVisible === visible.length;
  const someChecked = checkedVisible > 0 && !allChecked;
  const allRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someChecked;
  }, [someChecked]);
  const showSearch = items.length >= searchFrom;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <label className="flex items-center gap-2 px-2 py-1 bg-white border border-slate-200 rounded-lg cursor-pointer select-none">
          <input
            ref={allRef}
            type="checkbox"
            checked={allChecked}
            disabled={visible.length === 0}
            onChange={() => onSetMany(visible.map((i) => i.key), !allChecked)}
            className={`w-3.5 h-3.5 rounded border-slate-300 cursor-pointer ${t.box}`}
          />
          <span className="text-[11px] font-semibold text-slate-700">{q ? 'Select all shown' : 'Select all'}</span>
        </label>
        {showSearch && (
          <div className="relative flex-1 min-w-[140px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-7 pr-7 py-1 text-xs bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
        <span className="ml-auto text-[11px] text-slate-500">
          {items.filter((i) => selected.has(i.key)).length} of {items.length} selected
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="text-[11px] text-slate-400 px-1 py-1.5">Nothing matches “{query}”.</p>
      ) : (
        <div className={layout === 'grid' ? 'grid grid-cols-2 xl:grid-cols-3 gap-2' : 'space-y-1 max-h-48 overflow-y-auto pr-1'}>
          {visible.map((i) => (
            <label
              key={i.key}
              className={`flex items-center gap-2 bg-white border rounded-lg cursor-pointer ${layout === 'grid' ? 'px-2.5 py-1.5' : 'px-2 py-1.5'} ${t.item}`}
            >
              <input
                type="checkbox"
                checked={selected.has(i.key)}
                onChange={() => onToggle(i.key)}
                className={`w-3.5 h-3.5 rounded border-slate-300 cursor-pointer ${t.box}`}
              />
              <span className="text-xs text-slate-800">{i.label}</span>
              {i.badge && <span className={`text-[10px] font-semibold ${t.badge}`}>{i.badge}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
