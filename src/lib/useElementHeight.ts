/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';

// A sticky search / filter bar's height, so the table's column titles can
// stick right under it (Admin Panel -> Users, Monthly Leave Application…).
// Use the returned callback as the bar's ref.
export function useElementHeight(fallback = 56): [(el: HTMLElement | null) => void, number] {
  const [h, setH] = useState(fallback);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setH(el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    ro.current = new ResizeObserver(() => setH(el.offsetHeight));
    ro.current.observe(el);
  }, []);
  return [ref, h];
}
