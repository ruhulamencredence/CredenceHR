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
  return on;
}
