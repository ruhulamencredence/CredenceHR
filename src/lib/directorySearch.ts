/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Open the Employee Directory already searched for one person — the
// Dashboard's "Search a person, page or request" (DashboardGreeting.tsx)
// hands over who was picked. The Directory may already be mounted (it stays
// alive, hidden, between visits), so the search arrives both as a pending
// value it reads when it mounts and as an event it listens for.

const EVENT = 'chr:directory-search';
let pending: string | null = null;

export function searchDirectoryFor(text: string) {
  pending = text;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: text }));
}

// The search waiting for the Directory, taken once.
export function takeDirectorySearch(): string | null {
  const t = pending;
  pending = null;
  return t;
}

export function onDirectorySearch(fn: (text: string) => void): () => void {
  const h = (e: Event) => {
    pending = null;
    fn(String((e as CustomEvent).detail || ''));
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
