/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel on a phone, step 3 (docs/plans/admin-panel-mobile.md): a
// block that takes the screen before the list — an "Add …" form or a row
// of filters — becomes one button; tapping it shows the very same block in
// a liquid-glass sheet from the bottom.
//
// Desktop (and any page not in the Admin phone layout) renders the
// children exactly where they were, untouched. On a phone the children stay
// mounted inside the sheet even while it is closed, so whatever was typed
// or picked is kept and every handler is the page's own.
//
//   label       the button's text ("Add Department", "Filters")
//   editing     an item is being edited (the page's pencil): open the sheet
//   onCancelEdit closing the sheet while editing — the page's own Cancel
//   doneKey     changes when the form has saved (e.g. the list's length): close
//   closeOnApply close after a tap on an "Apply" / "Search" button inside

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, SlidersHorizontal, X } from 'lucide-react';
import { useAdminPhoneFlag } from '../lib/adminPhone';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface PhoneSheetProps {
  label: string;
  title?: string;
  kind?: 'add' | 'filter';
  editing?: boolean;
  onCancelEdit?: () => void;
  doneKey?: unknown;
  closeOnApply?: boolean;
  activeCount?: number;
  children: React.ReactNode;
}

export const PhoneSheet: React.FC<PhoneSheetProps> = ({ label, title, kind = 'add', editing, onCancelEdit, doneKey, closeOnApply, activeCount, children }) => {
  const phone = useAdminPhoneFlag();
  const [open, setOpen] = useState(false);
  const isOpen = open || !!editing;
  const firstDone = useRef(true);

  useEffect(() => {
    if (firstDone.current) {
      firstDone.current = false;
      return;
    }
    setOpen(false);
  }, [doneKey]);

  const close = () => {
    setOpen(false);
    if (editing) onCancelEdit?.();
  };
  useBackButtonClose(phone && isOpen, close);

  if (!phone) return <>{children}</>;

  const onClickCapture = (e: React.MouseEvent) => {
    if (!closeOnApply) return;
    const btn = (e.target as HTMLElement).closest('button');
    if (btn && /^\s*(apply|search|show)\b/i.test(btn.textContent || '')) setTimeout(() => setOpen(false), 50);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          kind === 'add'
            ? 'w-full h-12 mb-3 rounded-full text-white text-sm font-bold flex items-center justify-center gap-2 shadow-[0_12px_24px_-12px_rgba(244,121,32,0.8)]'
            : 'h-11 px-4 mb-3 rounded-full bg-white text-sm font-bold text-slate-700 flex items-center gap-2 shadow-[0_2px_8px_rgba(60,30,10,0.1)]'
        }
        style={kind === 'add' ? { background: 'var(--g-accent, #f47920)' } : undefined}
      >
        {kind === 'add' ? <Plus className="w-4 h-4" /> : <SlidersHorizontal className="w-4 h-4" />}
        {label}
        {kind === 'filter' && !!activeCount && (
          <span className="min-w-[20px] h-5 px-1.5 rounded-full text-[11px] text-white flex items-center justify-center" style={{ background: 'var(--g-accent, #f47920)' }}>
            {activeCount}
          </span>
        )}
      </button>
      {createPortal(
        <div className="fixed inset-0 z-[80]" style={{ display: isOpen ? 'block' : 'none' }} role="dialog" aria-modal="true" aria-label={title || label}>
          <div className="absolute inset-0 liquid-glass-backdrop" onClick={close} />
          <div className="absolute inset-x-2 bottom-2 pointer-events-none">
            <div className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] p-4 max-h-[88vh] overflow-y-auto phone-sheet-body" onClickCapture={onClickCapture}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-base font-bold text-slate-900">{title || label}</span>
                <button type="button" onClick={close} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {children}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
