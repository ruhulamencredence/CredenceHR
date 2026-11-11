/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Light / Dark / Dark Glass / Like this device (Profile -> Settings ->
// Appearance). Dark sets <html data-dark>, and index.css's "Dark mode"
// section turns the whole app charcoal (pages, cards, sidebar, header, phone
// bars, popups) on top of whichever background theme is picked; the accent
// colour stays. Dark Glass is Dark plus <html data-glass>: a near-black page
// with soft accent glows behind frosted, see-through cards and bars
// (index.css "Dark Glass"). "Like this device" follows the device with
// plain Dark.
// Per device, like the other Appearance choices (localStorage). index.html
// applies it before the first paint so a dark page doesn't flash light.
import { useEffect, useState } from 'react';

export type ColorMode = 'light' | 'dark' | 'glass' | 'system';
export const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'glass', label: 'Dark Glass' },
  { id: 'system', label: 'Like this device' }
];
const KEY = 'mpr_color_mode';
export const COLOR_MODE_EVENT = 'credence:color-mode';
// The page colour in dark mode — also the browser bar / status bar colour.
export const DARK_PAGE = '#25282c';

export function getSavedColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'glass' || v === 'system') return v;
  } catch {
    // storage unavailable — light
  }
  return 'light';
}

const systemDark = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

export const isDarkNow = () => document.documentElement.hasAttribute('data-dark');

let lightThemeColor: string | null = null;
function paint(dark: boolean, glass = false) {
  const root = document.documentElement;
  const was = root.hasAttribute('data-dark');
  if (dark) root.setAttribute('data-dark', '');
  else root.removeAttribute('data-dark');
  if (dark && glass) root.setAttribute('data-glass', '');
  else root.removeAttribute('data-glass');
  // The browser's own bar (Android Chrome, iPhone Safari / Home Screen app).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    if (lightThemeColor === null) lightThemeColor = meta.getAttribute('content') || '#6300C6';
    meta.setAttribute('content', dark ? DARK_PAGE : lightThemeColor);
  }
  if (was !== dark) window.dispatchEvent(new CustomEvent(COLOR_MODE_EVENT, { detail: dark }));
}

let mql: MediaQueryList | null = null;
const onSystemChange = () => paint(systemDark());

/** Applies the mode now (and follows the device while it is "system"). */
export function applyColorMode(mode: ColorMode, remember = false): void {
  try {
    mql?.removeEventListener('change', onSystemChange);
  } catch {
    // old browser
  }
  mql = null;
  if (mode === 'system') {
    try {
      mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', onSystemChange);
    } catch {
      mql = null;
    }
  }
  paint(mode === 'dark' || mode === 'glass' || (mode === 'system' && systemDark()), mode === 'glass');
  if (!remember) return;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // the choice just won't survive a reload
  }
}

/** True while the app is dark; re-renders when it changes. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(isDarkNow);
  useEffect(() => {
    const on = (e: Event) => setDark(!!(e as CustomEvent).detail);
    window.addEventListener(COLOR_MODE_EVENT, on);
    setDark(isDarkNow());
    return () => window.removeEventListener(COLOR_MODE_EVENT, on);
  }, []);
  return dark;
}
