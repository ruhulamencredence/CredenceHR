/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// True while the page (or any scrolling panel inside it) is being scrolled,
// and for `idleMs` after it stops. Floating buttons on phones step aside
// while it's true, so they don't sit on top of the rows scrolling under them
// (AiAssistant.tsx, BottomNav.tsx).

import { useEffect, useState } from 'react';

export function useScrolling(enabled = true, idleMs = 900): boolean {
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      setScrolling(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), idleMs);
    };
    // capture: also hears scrolling inside panels (scroll events don't bubble)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as any);
      if (timer) clearTimeout(timer);
    };
  }, [enabled, idleMs]);
  return enabled && scrolling;
}

export function useIsPhone(maxWidth = 767): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return phone;
}
