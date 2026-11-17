/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';

// A settings card that folds away (Admin Panel -> Active Users, …): open or
// closed, remembered in this browser per card. Storage may be unavailable
// (private window) — then it simply starts open each time.
export function useCardOpen(key: string, startOpen = true): [boolean, () => void, (v: boolean) => void] {
  const storageKey = `card-open:${key}`;
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? startOpen : v === '1';
    } catch {
      return startOpen;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(storageKey, v ? '1' : '0');
    } catch {
      /* not kept — fine */
    }
  };
  return [open, () => setOpen(!open), setOpen];
}
