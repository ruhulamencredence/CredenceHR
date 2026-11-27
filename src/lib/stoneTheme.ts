/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, type RefObject } from 'react';

// Stone & Olive (backgroundTheme.ts 'stone'): a few touches CSS can't do on
// its own. The rest of the theme is stoneOlive.css, keyed on
// <html data-bg="stone"> (light modes only).

export const THEME_CHANGE_EVENT = 'credence:theme-change';

export const isStoneTheme = (): boolean => {
  const root = document.documentElement;
  return root.dataset.bg === 'stone' && !root.hasAttribute('data-dark');
};

// Leave Summary: the olive head is cut out around the leave card that
// overlaps it, following the card's own rounded shape with a thin gap — so
// the card sits in a notch instead of on top of the colour.
export function useStoneCarve(headRef: RefObject<HTMLElement | null>, cardRef: RefObject<HTMLElement | null>, gap = 8): void {
  useEffect(() => {
    const head = headRef.current;
    const card = cardRef.current;
    if (!head || !card) return;
    const clear = () => {
      head.style.removeProperty('mask-image');
      head.style.removeProperty('-webkit-mask-image');
    };
    const carve = () => {
      if (!isStoneTheme()) return clear();
      const h = head.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (!h.width || !c.width || c.top >= h.bottom) return clear();
      const r = (parseFloat(getComputedStyle(card).borderTopLeftRadius) || 24) + gap;
      const x = c.left - h.left - gap;
      const y = c.top - h.top - gap;
      const w = c.width + gap * 2;
      const hh = c.height + gap * 2;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${h.width}" height="${h.height}"><path fill-rule="evenodd" fill="#000" d="M0 0H${h.width}V${h.height}H0Z ` +
        `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + hh - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + hh}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + hh - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z"/></svg>`;
      const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
      head.style.setProperty('mask-image', url);
      head.style.setProperty('-webkit-mask-image', url);
      head.style.setProperty('mask-size', '100% 100%');
      head.style.setProperty('-webkit-mask-size', '100% 100%');
    };
    carve();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(carve) : null;
    ro?.observe(head);
    ro?.observe(card);
    window.addEventListener(THEME_CHANGE_EVENT, carve);
    window.addEventListener('resize', carve);
    return () => {
      ro?.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, carve);
      window.removeEventListener('resize', carve);
      clear();
    };
  }, [headRef, cardRef, gap]);
}
