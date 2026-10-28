/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Live refresh for open pages (Ride Status, My Leave, Approve Applications…).
// The server tells an account over its socket whenever one of its requests
// changes or a new one waits for it ("records:changed", see Alerts.ts); the
// page then fetches again quietly — no page reload. As a safety net it also
// refetches when the app comes back to the front, when the network returns,
// after the socket reconnects, and every minute while it's on screen.

import { useEffect, useRef, useState } from 'react';

export const RECORDS_CHANGED_EVENT = 'credence:records-changed';

export interface RecordsChange {
  type: string | null;
  related_type: string | null;
  related_id: number | null;
}

/**
 * Calls `reload` (debounced) on every change pushed for this account, plus the
 * fallbacks above. `match` narrows it to the changes the page cares about.
 */
export function useLiveRefresh(reload: () => unknown, match?: (c: RecordsChange) => boolean, intervalMs = 60_000) {
  const reloadRef = useRef(reload);
  const matchRef = useRef(match);
  reloadRef.current = reload;
  matchRef.current = match;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          void reloadRef.current();
        } catch {
          // A failed refresh just leaves what's on screen.
        }
      }, 400);
    };
    const onChange = (e: Event) => {
      const c = (e as CustomEvent).detail as RecordsChange | undefined;
      if (!c || !matchRef.current || matchRef.current(c)) run();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener(RECORDS_CHANGED_EVENT, onChange);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', run);
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, intervalMs);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(RECORDS_CHANGED_EVENT, onChange);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', run);
      clearInterval(tick);
    };
  }, [intervalMs]);
}

/** A number that goes up on every live refresh — add it to an effect's deps. */
export function useLiveTick(match?: (c: RecordsChange) => boolean): number {
  const [n, setN] = useState(0);
  useLiveRefresh(() => setN((x) => x + 1), match);
  return n;
}
