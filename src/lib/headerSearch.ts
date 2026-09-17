/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

// A tiny module-level pub/sub (not a React Context) so a page like Employee
// Directory can hand its own search box to Navbar.tsx without threading a
// provider through App.tsx's tree. Only one page's search can be "docked"
// into the header at a time, which matches how the app is used — the header
// itself is a single global singleton.
//
// Flow: the page registers its {value, onChange} on mount and tells us via
// setHeaderSearchBarHidden(true/false) whenever its own on-page search bar
// scrolls out of view (see its IntersectionObserver). Navbar.tsx subscribes
// with useHeaderSearchState() and, while a page is registered AND its bar is
// hidden, swaps its logo for a search icon on mobile — tapping it opens an
// inline input wired straight back to the same onChange, so results update
// without the user needing to scroll back up to the page's own search box.

interface HeaderSearchRegistration {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

type Listener = () => void;

let registration: HeaderSearchRegistration | null = null;
let barHidden = false;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function registerHeaderSearch(reg: HeaderSearchRegistration) {
  registration = reg;
  emit();
}

export function unregisterHeaderSearch() {
  registration = null;
  barHidden = false;
  emit();
}

export function setHeaderSearchBarHidden(hidden: boolean) {
  if (barHidden !== hidden) {
    barHidden = hidden;
    emit();
  }
}

export function useHeaderSearchState() {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const listener = () => forceRerender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { registration, barHidden };
}
