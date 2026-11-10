/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel pages on a phone (≤ 767 px), the way the Self Service pages
// already are (docs/plans/admin-panel-mobile.md):
//
//   - the blended app header — round Back, the module's name in the middle,
//     a ⋮ on the right — in place of the orange logo bar (Navbar.tsx reads
//     the title set here, and treats it as blended while <html
//     data-admin-phone> is set);
//   - no breadcrumb, no big white box around the page, sub-tabs as a row of
//     round chips, buttons at least 40 px (index.css, html[data-admin-phone]).
//
// Desktop is untouched: nothing here runs above 767 px, and the CSS is
// scoped to the attribute, which is only set on a phone.

import { useEffect, useState } from 'react';
import { useIsPhone } from './useScrolling';
import { setHeaderPageTitle } from './headerPageTitle';

export const ADMIN_PHONE_ATTR = 'adminPhone';

// One flag the header reads; the hook below flips it.
let adminPhoneOn = false;
const listeners = new Set<() => void>();
const setFlag = (v: boolean) => {
  if (adminPhoneOn === v) return;
  adminPhoneOn = v;
  listeners.forEach((l) => l());
};

/** Whether an Admin page is open in phone layout right now (Navbar.tsx). */
export function useAdminPhoneFlag(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return adminPhoneOn;
}

/**
 * Step 2: on a phone every list table inside the page becomes a stack of
 * cards — each row a card, each cell "Column name: value" (index.css,
 * table[data-phone-card]). Nothing in the table changes: only the cells get
 * a data-label copied from their column heading, and the table a flag; both
 * are taken off again when the phone layout ends.
 *
 * Real grids are left as tables (step 4 gives them a fixed name column):
 * a table with more than 9 columns, a calendar of day numbers, or one
 * marked data-grid-table. Tables in popups keep their own layout.
 */
const isGrid = (table: HTMLTableElement, heads: string[]) => {
  if (table.hasAttribute('data-grid-table')) return true;
  if (heads.length > 20) return true;
  return heads.filter((h) => /^\s*\d{1,2}\s*$/.test(h) || /^\s*(Su|Mo|Tu|We|Th|Fr|Sa)\s*\d{1,2}\s*$/i.test(h)).length >= 5;
};
function headsOf(table: HTMLTableElement): string[] {
  // A head can have a second row of filter boxes: take the row with the
  // most written headings.
  const rows = Array.from(table.tHead?.rows || []);
  let best: string[] = [];
  let bestFilled = -1;
  for (const row of rows) {
    const out: string[] = [];
    for (const th of Array.from(row.cells)) {
      const n = Math.max(1, Number(th.getAttribute('colspan')) || 1);
      const text = (th.textContent || '').replace(/\s+/g, ' ').trim();
      for (let i = 0; i < n; i++) out.push(text);
    }
    const filled = out.filter(Boolean).length;
    if (filled > bestFilled) {
      best = out;
      bestFilled = filled;
    }
  }
  return best;
}
function stackTable(table: HTMLTableElement) {
  if (table.closest('[role="dialog"], .fixed')) return;
  const heads = headsOf(table);
  if (!heads.length) return;
  if (isGrid(table, heads)) {
    // Step 4: a real grid keeps its name column in place, narrower.
    if (!table.hasAttribute('data-phone-grid')) table.setAttribute('data-phone-grid', '');
    return;
  }
  table.setAttribute('data-phone-card', '');
  for (const body of Array.from(table.tBodies)) {
    for (const tr of Array.from(body.rows)) {
      let col = 0;
      for (const td of Array.from(tr.cells)) {
        const span = Math.max(1, Number(td.getAttribute('colspan')) || 1);
        const label = span > 1 ? '' : heads[col] || '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        col += span;
      }
    }
  }
}
function unstackAll(root: ParentNode) {
  root.querySelectorAll('table[data-phone-card]').forEach((t) => t.removeAttribute('data-phone-card'));
  root.querySelectorAll('table[data-phone-grid]').forEach((t) => t.removeAttribute('data-phone-grid'));
  root.querySelectorAll('td[data-label], th[data-label]').forEach((c) => c.removeAttribute('data-label'));
}

export function usePhoneTableCards(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.querySelector('main');
    if (!root) return;
    let queued = false;
    const run = () => {
      queued = false;
      root.querySelectorAll('table').forEach((t) => stackTable(t as HTMLTableElement));
      // Long explanations (a grey paragraph of more than ~160 characters)
      // show two lines and "More"; a tap opens the rest. The text is not touched.
      root.querySelectorAll('p').forEach((el) => {
        const p = el as HTMLElement;
        if (p.hasAttribute('data-phone-fold') || p.closest('table, form, [role="dialog"], .fixed, label, button')) return;
        const cls = p.className || '';
        if (!/text-(slate|gray|stone)-(4|5|6)00/.test(cls) && !/text-\[1[01]px\]|text-xs/.test(cls)) return;
        if ((p.textContent || '').trim().length < 160) return;
        p.setAttribute('data-phone-fold', '');
      });
    };
    const onTap = (e: Event) => {
      const p = (e.target as HTMLElement).closest('[data-phone-fold]');
      if (!p || (e.target as HTMLElement).closest('a, button, input, select')) return;
      if (p.hasAttribute('data-open')) p.removeAttribute('data-open');
      else p.setAttribute('data-open', '');
    };
    root.addEventListener('click', onTap);
    run();
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(run);
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      root.removeEventListener('click', onTap);
      unstackAll(root);
      root.querySelectorAll('[data-phone-fold]').forEach((p) => {
        p.removeAttribute('data-phone-fold');
        p.removeAttribute('data-open');
      });
    };
  }, [active]);
}

/**
 * Call once from an Admin page's root component with the module's name. On
 * a phone it shows that name in the app header and switches the phone
 * layout on; it takes both back off when the page closes.
 */
export function useAdminPhonePage(title: string | null | undefined, active = true): boolean {
  const phone = useIsPhone();
  const on = phone && active && !!title;
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.dataset[ADMIN_PHONE_ATTR] = '';
    setFlag(true);
    setHeaderPageTitle(title!);
    return () => {
      delete root.dataset[ADMIN_PHONE_ATTR];
      setFlag(false);
      setHeaderPageTitle(null);
    };
  }, [on, title]);
  usePhoneTableCards(on);
  return on;
}
