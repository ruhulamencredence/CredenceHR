/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The one popup shell every Credence Mail tool uses (Settings, Rules,
// Templates, Contacts, Tasks & Calendar, Analytics) — the house liquid-glass
// card (CLAUDE.md -> Popup style), a sheet from the bottom on a phone.

import React from 'react';
import { X } from 'lucide-react';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { useKeyboardInset, scrollFocusedFieldIntoView } from '../../lib/useKeyboardInset';

export const MailPopup: React.FC<{
  title: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  size?: 'md' | 'lg' | 'xl';
  // Shown under the title, outside the scrolling body (tabs).
  head?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, onClose, size = 'lg', head, footer, children }) => {
  const keyboardInset = useKeyboardInset();
  useBackButtonClose(true, onClose);
  const width = size === 'md' ? 'sm:max-w-md' : size === 'xl' ? 'sm:max-w-4xl' : 'sm:max-w-2xl';
  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-0 sm:p-4" style={keyboardInset ? { paddingBottom: keyboardInset } : undefined} onClick={onClose}>
      <div className={`w-full ${width} max-h-[92dvh] sm:max-h-[90vh] flex`} onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-t-[32px] sm:rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 min-w-0 truncate">
              {icon}
              {title}
            </h3>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {head}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 pb-4" onFocusCapture={scrollFocusedFieldIntoView}>
            {children}
          </div>
          {footer && (
            <div className="px-4 sm:px-5 py-3 flex items-center justify-end gap-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const inputCls = 'w-full text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-200 focus:outline-none';
export const labelCls = 'block text-xs font-medium text-slate-600 mb-1';
export const primaryBtn = 'liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-2';
export const ghostBtn = 'px-4 py-2 rounded-full text-sm text-slate-600 hover:bg-black/5 disabled:opacity-50';

export const Tabs: React.FC<{ tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }> = ({ tabs, value, onChange }) => (
  <div className="px-4 sm:px-5 pb-3">
    <div className="liquid-glass-inset rounded-full p-1 flex gap-1 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`flex-1 shrink-0 whitespace-nowrap text-xs font-semibold px-3 py-1.5 rounded-full ${value === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  </div>
);

export const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: React.ReactNode }> = ({ checked, onChange, label, hint }) => (
  <label className="flex items-start gap-3 cursor-pointer select-none">
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 w-9 h-5 rounded-full shrink-0 relative transition-colors ${checked ? 'bg-sky-600' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
    <span className="min-w-0">
      <span className="block text-sm text-slate-800">{label}</span>
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </span>
  </label>
);

export const EmptyNote: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => (
  <div className="py-10 flex flex-col items-center text-center">
    <div className="w-12 h-12 rounded-full bg-white/70 flex items-center justify-center text-slate-300">{icon}</div>
    <p className="mt-3 text-sm text-slate-500">{text}</p>
  </div>
);

export const RowsSkeleton: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60" style={{ animation: 'skeleton-in .25s ease .15s both' }}>
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-4 py-3 space-y-2">
        <div className={`h-3 rounded bg-slate-200/80 ${i % 2 ? 'w-1/3' : 'w-1/2'}`} />
        <div className="h-2.5 w-2/3 rounded bg-slate-100" />
      </div>
    ))}
  </div>
);
