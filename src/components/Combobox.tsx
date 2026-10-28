/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

// One field to type in and pick from a list, used across the app in two ways:
//
//   <Combobox free …>   type anything, or pick a suggestion (unit, document
//                       type, designation…). What is typed is the value.
//   <SearchSelect …>    a drop-in for <select> over a list from the database
//                       (employees, projects, vehicles…): typing only narrows
//                       the list, the value is set only by picking an option,
//                       and leaving the field without picking puts the last
//                       choice back. It takes the same <option> children,
//                       `value` and `onChange={(e) => … e.target.value}` as
//                       the <select> it replaces.
//
// The list is drawn on document.body so a scrolling popup or a table cell
// doesn't cut it off. A native <datalist> was not used: it only shows the
// options matching what is already typed, and Android WebViews hardly show
// it at all.

const SHOW_MAX = 200;

export interface ComboOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// While typing: options starting with it first, then those containing it.
function narrow(options: ComboOption[], q: string): ComboOption[] {
  const t = q.trim().toLowerCase();
  if (!t) return options;
  const starts: ComboOption[] = [];
  const has: ComboOption[] = [];
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (l.startsWith(t) || l.split(/[\s(·,/-]+/).some((w) => w.startsWith(t))) starts.push(o);
    else if (l.includes(t)) has.push(o);
  }
  return [...starts, ...has];
}

interface ListProps {
  anchor: React.RefObject<HTMLElement | null>;
  options: ComboOption[];
  active: number;
  setActive: (i: number) => void;
  selected: string | null;
  onPick: (o: ComboOption) => void;
  empty: React.ReactNode;
  label: string;
  listRef: React.RefObject<HTMLDivElement | null>;
}

function ComboList({ anchor, options, active, setActive, selected, onPick, empty, label, listRef }: ListProps) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const up = below < 240 && r.top > below;
      const width = Math.min(Math.max(r.width, 180), window.innerWidth - 16);
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: up ? r.top : r.bottom, width, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);
  useEffect(() => {
    (listRef.current?.querySelector(`[data-i="${active}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [active, listRef]);
  if (!pos) return null;
  return createPortal(
    <div
      ref={listRef}
      role="listbox"
      aria-label={`${label} options`}
      className="fixed z-[2000] max-h-60 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl py-1 text-left"
      style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}
    >
      {options.length === 0 ? (
        <div className="px-3 py-2 text-xs text-slate-500">{empty}</div>
      ) : (
        // A long list (thousands of employees) shows the first ones; typing
        // finds the rest — keeps the list quick to open on a phone.
        options.slice(0, SHOW_MAX).map((o, i) => (
          <button
            key={`${o.value}-${i}`}
            type="button"
            role="option"
            data-i={i}
            aria-selected={o.value === selected}
            aria-disabled={o.disabled || undefined}
            disabled={o.disabled}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => !o.disabled && onPick(o)}
            onMouseEnter={() => setActive(i)}
            className={`w-full text-left px-3 py-2 text-sm leading-snug ${
              o.disabled ? 'text-slate-300 cursor-not-allowed' : i === active ? 'bg-blue-50 text-blue-800' : 'text-slate-700'
            } ${o.value === selected ? 'font-semibold' : ''}`}
          >
            {o.label || ' '}
          </button>
        ))
      )}
      {options.length > SHOW_MAX && (
        <div className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">{options.length - SHOW_MAX} more — type to find them.</div>
      )}
    </div>,
    document.body
  );
}

// Close when tapping outside the field and its list.
function useOutside(open: boolean, close: () => void, ...refs: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!refs.some((r) => r.current?.contains(t))) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

const Chevron: React.FC<{ open: boolean; disabled?: boolean; onToggle: () => void; label: string }> = ({ open, disabled, onToggle, label }) => (
  <button
    type="button"
    tabIndex={-1}
    disabled={disabled}
    aria-label={`Show ${label.toLowerCase()} list`}
    onPointerDown={(e) => e.preventDefault()}
    onClick={onToggle}
    className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-40"
  >
    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
  </button>
);

// ---------------------------------------------------------------------------
// Free: type anything or pick a suggestion.
// ---------------------------------------------------------------------------
export const Combobox: React.FC<{
  free: true;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
  onFocus?: () => void;
}> = ({ value, onChange, options, className = '', placeholder, disabled, required, id, ariaLabel = 'Value', onFocus }) => {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const all = useMemo(() => [...new Set(options.filter(Boolean))].map((o) => ({ value: o, label: o })), [options]);
  const shown = typing ? narrow(all, value) : all;
  useOutside(open, () => setOpen(false), wrap, list);
  const show = () => {
    if (disabled) return;
    setTyping(false);
    setActive(Math.max(0, all.findIndex((o) => o.value.toLowerCase() === value.trim().toLowerCase())));
    setOpen(true);
  };
  const pick = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setTyping(false);
  };
  return (
    <div ref={wrap} className="relative">
      <input
        ref={input}
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setTyping(true);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          show();
          onFocus?.();
        }}
        onClick={() => !open && show()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) return show();
            const n = shown.length;
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter' && open && shown[active]) {
            e.preventDefault();
            pick(shown[active]);
          } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        required={required}
        className={`${className} !pr-7`}
      />
      <Chevron
        open={open}
        disabled={disabled}
        label={ariaLabel}
        onToggle={() => {
          if (open) setOpen(false);
          else {
            input.current?.focus();
            show();
          }
        }}
      />
      {open && (
        <ComboList
          anchor={wrap}
          listRef={list}
          options={shown}
          active={active}
          setActive={setActive}
          selected={value}
          onPick={pick}
          label={ariaLabel}
          empty={
            <>
              Use “<span className="font-semibold text-slate-700">{value.trim()}</span>”
            </>
          }
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Strict: a <select> you can search. Same children / value / onChange.
// ---------------------------------------------------------------------------
const textOf = (n: React.ReactNode): string =>
  n == null || typeof n === 'boolean'
    ? ''
    : typeof n === 'string' || typeof n === 'number'
    ? String(n)
    : Array.isArray(n)
    ? n.map(textOf).join('')
    : React.isValidElement(n)
    ? textOf((n.props as any).children)
    : '';

// Every <option> under the children, through arrays, fragments and <optgroup>s.
function optionsOf(children: React.ReactNode): ComboOption[] {
  const out: ComboOption[] = [];
  const walk = (n: React.ReactNode) =>
    React.Children.forEach(n, (c) => {
      if (!React.isValidElement(c)) return;
      const p: any = c.props;
      if (c.type === 'option') {
        const label = textOf(p.children).replace(/\s+/g, ' ').trim();
        out.push({ value: p.value === undefined ? label : String(p.value), label, disabled: !!p.disabled });
      } else walk(p.children);
    });
  walk(children);
  return out;
}

type SelectLike = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children'> & {
  value?: string | number | null | readonly string[];
  onChange?: (e: { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } }) => void;
  children?: React.ReactNode;
  // Shown when nothing in the list matches what was typed.
  emptyText?: string;
};

export const SearchSelect: React.FC<SelectLike> = ({
  value,
  onChange,
  children,
  className = '',
  disabled,
  required,
  id,
  name,
  title,
  style,
  emptyText = 'Nothing matches — pick one from the list',
  onFocus: userFocus,
  onBlur: userBlur,
  ...rest
}) => {
  // aria-* / data-* attributes go on to the text box.
  const passOn = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('aria-') || k.startsWith('data-')));
  const options = useMemo(() => optionsOf(children), [children]);
  const current = value == null ? '' : String(value);
  const chosen = options.find((o) => o.value === current) || null;
  // An empty choice that is a prompt ("— Select employee —") reads as the
  // field's placeholder; one that is a real choice ("All Projects") is shown.
  const blank = options.find((o) => o.value === '');
  const prompt = !!blank && /^[—–-]|^(select|choose|pick)\b|^none$/i.test(blank.label.trim());
  const shownText = chosen && (chosen.value !== '' || !prompt) ? chosen.label : '';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = not typing
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = query == null ? options : narrow(options, query);
  const ariaLabel = (rest as any)['aria-label'] || title || blank?.label?.replace(/^[—–-]+\s*|\s*[—–-]+$/g, '') || 'Choose';

  const close = () => {
    setOpen(false);
    setQuery(null); // what was typed but not picked is dropped
  };
  useOutside(open, close, wrap, list);
  // A required field with nothing picked can't be submitted.
  useEffect(() => {
    input.current?.setCustomValidity(required && current === '' ? 'Pick one from the list.' : '');
  }, [required, current]);

  const show = () => {
    if (disabled) return;
    setQuery(null);
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };
  const pick = (o: ComboOption) => {
    if (o.disabled) return;
    if (o.value !== current) onChange?.({ target: { value: o.value, name }, currentTarget: { value: o.value, name } });
    setOpen(false);
    setQuery(null);
  };

  return (
    <div ref={wrap} className="relative" style={style} title={title}>
      <input
        ref={input}
        id={id}
        name={name}
        value={query ?? shownText}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => {
          show();
          e.currentTarget.select();
          userFocus?.(e as any);
        }}
        onClick={() => !open && show()}
        onBlur={(e) => {
          window.setTimeout(() => setQuery(null), 150);
          userBlur?.(e as any);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) return show();
            const n = shown.length;
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter') {
            if (open && shown[active]) {
              e.preventDefault();
              pick(shown[active]);
            }
          } else if (e.key === 'Escape' || e.key === 'Tab') close();
        }}
        placeholder={prompt ? blank!.label : 'Type to search…'}
        {...passOn}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        required={required}
        className={`${className} !pr-7 text-left`}
      />
      <Chevron
        open={open}
        disabled={disabled}
        label={ariaLabel}
        onToggle={() => {
          if (open) close();
          else {
            input.current?.focus();
            show();
          }
        }}
      />
      {open && (
        <ComboList
          anchor={wrap}
          listRef={list}
          options={shown}
          active={active}
          setActive={setActive}
          selected={current}
          onPick={pick}
          label={ariaLabel}
          empty={emptyText}
        />
      )}
    </div>
  );
};
