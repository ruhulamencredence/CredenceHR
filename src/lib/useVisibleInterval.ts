/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

// setInterval that rests while the app / tab is in the background (the phone
// app sent to Home, another browser tab in front) and, on coming back, runs
// once at once so the badge is fresh. The header badges asked the server every
// 30 s even with the app in the background — battery and data for nothing
// (live changes still arrive over the socket and push notifications).
// A WebView that never reports "hidden" just keeps the old every-N-seconds
// behaviour.
export function useVisibleInterval(fn: () => void, ms: number, runOnVisible = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const t = setInterval(() => {
      if (!hidden()) ref.current();
    }, ms);
    const onVisibility = () => {
      if (runOnVisible && !hidden()) ref.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, runOnVisible]);
}
