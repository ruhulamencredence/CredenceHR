/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Phone: drag from the left edge of the screen to the right and the side
// menu (GlobalSidebar's overlay drawer) follows the finger out; drag it back
// to the left (on the menu or the dim area beside it) and it goes away.
// Let go past a third of the way (or with a quick flick) and it finishes
// opening / closing, otherwise it springs back.
//
// Only below the md breakpoint (the computer has the menu as a column). Not
// started when a popup is open, or on a map / anything marked
// data-no-edge-swipe, so it doesn't fight their own dragging. A mostly
// up-and-down move is left to scrolling.

import { useEffect, useRef, useState } from 'react';

// How far in from the left edge a drag may start. Android's own Back
// gesture uses the outermost strip, so this reaches a little past it.
const EDGE = 32;
// Before deciding what a move is.
const SLOP = 10;

const blocked = (target: EventTarget | null) => {
  const el = target as Element | null;
  if (!el || !el.closest) return false;
  if (el.closest('.leaflet-container, [data-no-edge-swipe]')) return true;
  // A popup is open (house-style backdrop, or any dialog).
  return !!document.querySelector('.liquid-glass-backdrop, [role="dialog"][aria-modal="true"]');
};

/**
 * Returns how far the drawer is dragged out right now, in px (0 = shut,
 * width = fully out), or null while no drag is going on. `drawerRef` is
 * the drawer itself (its width is the full travel).
 */
export function useEdgeSwipeDrawer(opts: {
  enabled: boolean;
  open: boolean;
  onOpen?: () => void;
  onClose: () => void;
  drawerRef: React.RefObject<HTMLElement | null>;
}): number | null {
  const { enabled, open, onOpen, onClose, drawerRef } = opts;
  const [dragX, setDragX] = useState<number | null>(null);
  // Kept in a ref so the listeners (added once) see the latest values.
  const live = useRef({ open, onOpen, onClose });
  live.current = { open, onOpen, onClose };

  useEffect(() => {
    if (!enabled || !onOpen) return;
    const wide = () => window.matchMedia('(min-width: 768px)').matches;
    let start: { x: number; y: number; t: number; open: boolean; width: number } | null = null;
    let mode: 'pending' | 'drag' | 'off' = 'off';
    let lastX = 0;
    let lastT = 0;
    let prevX = 0;
    let prevT = 0;
    let current: number | null = null;

    const set = (v: number | null) => {
      current = v;
      setDragX(v);
    };

    const onStart = (e: TouchEvent) => {
      mode = 'off';
      start = null;
      if (wide() || e.touches.length !== 1) return;
      const t = e.touches[0];
      const isOpen = live.current.open;
      if (!isOpen) {
        if (t.clientX > EDGE || blocked(e.target)) return;
      } else {
        // Open: a drag on the drawer or the dim area beside it may close it.
        const el = e.target as Element | null;
        const onDrawer = !!(el && drawerRef.current?.contains(el));
        const onBackdrop = !!(el && el.closest?.('[data-gsidebar-backdrop]'));
        if (!onDrawer && !onBackdrop) return;
      }
      const width = drawerRef.current?.getBoundingClientRect().width || 264;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, open: isOpen, width };
      lastX = prevX = t.clientX;
      lastT = prevT = e.timeStamp;
      mode = 'pending';
    };

    const onMove = (e: TouchEvent) => {
      if (!start || mode === 'off') return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (mode === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Up / down, or the wrong way: leave it to the page.
        if (Math.abs(dy) > Math.abs(dx) || (start.open ? dx > 0 : dx < 0)) {
          mode = 'off';
          return;
        }
        mode = 'drag';
      }
      if (e.cancelable) e.preventDefault();
      prevX = lastX;
      prevT = lastT;
      lastX = t.clientX;
      lastT = e.timeStamp;
      const base = start.open ? start.width : 0;
      set(Math.max(0, Math.min(start.width, base + dx)));
    };

    const onEnd = () => {
      if (!start) return;
      const s = start;
      start = null;
      if (mode !== 'drag' || current == null) {
        mode = 'off';
        return;
      }
      mode = 'off';
      const v = lastT > prevT ? (lastX - prevX) / (lastT - prevT) : 0; // px per ms
      const flick = Math.abs(v) > 0.4;
      const shouldOpen = flick ? v > 0 : current > s.width / 3 && (s.open ? current > (s.width * 2) / 3 : true);
      set(null);
      if (shouldOpen && !s.open) live.current.onOpen?.();
      if (!shouldOpen && s.open) live.current.onClose();
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a drag that moves the menu must not also scroll the page.
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, !!onOpen, drawerRef]);

  return dragX;
}
