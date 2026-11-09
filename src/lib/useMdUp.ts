/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

// md and up (768px) = the desktop layout. A page that has a phone copy and a
// desktop copy renders only the one on screen, so the hidden copy doesn't
// load its data too.
export function useMdUp(): boolean {
  const q = '(min-width: 768px)';
  const [on, setOn] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true));
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener?.('change', f);
    return () => m.removeEventListener?.('change', f);
  }, []);
  return on;
}
