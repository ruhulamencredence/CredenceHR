/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Dashboard quick access cards -> the page they open, on a chosen tab. The
// request is a one-shot sessionStorage key the target page reads (and
// clears) when it mounts, so the sidebar/menu entry points stay unaffected.

export type BookRideTarget = 'book' | 'status';
export type MyAssetTarget = 'my-assets' | 'status' | 'new';

const KEYS = { bookRide: 'credence.bookRideTab', myAsset: 'credence.myAssetTab' } as const;

export function requestQuickAccessTab(page: keyof typeof KEYS, target: string) {
  try {
    sessionStorage.setItem(KEYS[page], target);
  } catch {
    // Storage blocked — the page just opens on its default tab.
  }
}

export function takeQuickAccessTab(page: keyof typeof KEYS): string | null {
  try {
    const value = sessionStorage.getItem(KEYS[page]);
    sessionStorage.removeItem(KEYS[page]);
    return value;
  } catch {
    return null;
  }
}
