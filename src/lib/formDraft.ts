/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Unsent form drafts kept on this device, so a form survives the app being
// reloaded or restarted mid-way (Android closing the app while the camera /
// file picker is open, a network-change reload, a pull-to-refresh) instead
// of starting again from blank. Per account (another login on the same phone
// never sees it), dropped once the form is sent, and wiped at sign-out
// (App.tsx). Storage missing / full: the form just works without a draft.

const PREFIX = 'chr_draft:';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function key(name: string): string | null {
  try {
    const u = JSON.parse(localStorage.getItem('mpr_user') || 'null');
    return u?.id ? `${PREFIX}${u.id}:${name}` : null;
  } catch {
    return null;
  }
}

export function readDraft<T>(name: string): T | null {
  const k = key(name);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (!t || Date.now() - t > MAX_AGE_MS) {
      localStorage.removeItem(k);
      return null;
    }
    return v as T;
  } catch {
    return null;
  }
}

export function saveDraft(name: string, value: unknown): void {
  const k = key(name);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // full / unavailable — no draft this time
  }
}

export function clearDraft(name: string): void {
  const k = key(name);
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch {
    // unavailable
  }
}

export function clearAllDrafts(): void {
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
