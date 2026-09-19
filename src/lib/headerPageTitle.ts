/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

// A tiny module-level pub/sub (same pattern as headerSearch.ts, not a React
// Context) so a mobile sub-page like "Select a Budget" can tell Navbar.tsx
// to show its own title in place of the company logo while it's the active
// section — mirroring how EmployeeDirectory swaps the logo for a search
// icon, but for a plain page title instead. Only one page can own this at a
// time, matching the header being a single global singleton.

type Listener = () => void;

let title: string | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function setHeaderPageTitle(next: string | null) {
  if (title !== next) {
    title = next;
    emit();
  }
}

export function useHeaderPageTitle(): string | null {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const listener = () => forceRerender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return title;
}
