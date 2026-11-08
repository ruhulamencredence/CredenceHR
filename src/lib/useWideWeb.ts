/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

const QUERY = '(min-width: 1024px)';

// True only in a desktop-width web browser — never in the native app, even on
// a tablet. For layouts that are meant for the web version only.
export function useWideWeb(): boolean {
  const native = Capacitor.isNativePlatform();
  const [wide, setWide] = useState(() => !native && typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    if (native) return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setWide(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [native]);
  return wide;
}
