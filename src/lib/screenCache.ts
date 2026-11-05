/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Open with no loading": the Dashboard's cards keep the last data they
// showed on this device and show it at once next time, while the fresh data
// loads quietly behind it (then it replaces what's on screen).
//
// - Kept per account AND per company, so nobody ever sees another login's
//   numbers on a shared phone, and switching company never mixes them.
// - Only what this account was already shown by the server — every fresh load
//   still goes through the same API, with the same permission checks; a card
//   whose access was removed disappears on that fresh load.
// - Everything is wiped on sign-out (clearScreenCache, App.tsx) and data
//   older than MAX_AGE is ignored.
// - Storage can be missing (private window) or full: every read / write is
//   wrapped, and the page simply loads the normal way then.

import { useCallback, useState } from 'react';
import { getActiveCompanyId } from './company';

const PREFIX = 'chr_sc:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function owner(): string | null {
  try {
    const u = JSON.parse(localStorage.getItem('mpr_user') || 'null');
    if (!u?.id || !localStorage.getItem('mpr_token')) return null;
    return `${u.id}:${getActiveCompanyId() ?? 0}`;
  } catch {
    return null;
  }
}

const fullKey = (key: string) => {
  const o = owner();
  return o ? `${PREFIX}${o}:${key}` : null;
};

export function readScreenCache<T>(key: string): T | undefined {
  const k = fullKey(key);
  if (!k) return undefined;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return undefined;
    const { t, v } = JSON.parse(raw);
    if (!t || Date.now() - t > MAX_AGE_MS) return undefined;
    return v as T;
  } catch {
    return undefined;
  }
}

export function writeScreenCache(key: string, value: unknown): void {
  const k = fullKey(key);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // full or unavailable — next open just loads normally
  }
}

export function clearScreenCache(): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch {
    // unavailable
  }
}

// useState that starts from the saved copy (if any) and saves every new value.
// `cached` is true while what's shown came from the device, not yet refreshed.
export function useCachedState<T>(key: string, initial: T): [T, (v: T) => void, boolean] {
  const [state, setState] = useState<{ v: T; cached: boolean }>(() => {
    const saved = readScreenCache<T>(key);
    return saved === undefined ? { v: initial, cached: false } : { v: saved, cached: true };
  });
  const set = useCallback(
    (v: T) => {
      writeScreenCache(key, v);
      setState({ v, cached: false });
    },
    [key]
  );
  return [state.v, set, state.cached];
}
