/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Lets each account pick their own app-wide background gradient (mobile +
// web both) instead of the one fixed default — see ProfilePage.tsx's
// "Appearance" section for the picker UI. Purely a per-device visual
// preference (localStorage, same pattern as every other client-only
// preference in this app — no server round-trip, nothing to sync across
// devices), applied by overriding index.css's --g-bg-gradient custom
// property directly on the root element.
//
// Percentage-based radial-gradient stops (not fixed pixel ellipses) so the
// glow scales consistently whether it's sitting behind a single short
// screen (Login) or a long scrollable one (Dashboard, Admin Panel tables) —
// background-attachment: fixed (already set on body in index.css) keeps it
// anchored to the viewport either way, rather than scrolling with content.

export type BackgroundThemeId = 'violet' | 'deep-violet' | 'sunset';

export interface BackgroundTheme {
  id: BackgroundThemeId;
  label: string;
  // Small flat swatch color for the picker UI — not the actual gradient,
  // just a quick visual reference the account taps.
  swatch: string;
  gradient: string;
}

export const BACKGROUND_THEMES: BackgroundTheme[] = [
  {
    id: 'violet',
    label: 'Violet',
    swatch: '#B36AFF',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #EFE0FF 0%, #D2A8FF 32%, #7F00FF 68%, #47008E 100%)'
  },
  {
    id: 'deep-violet',
    label: 'Deep Violet',
    swatch: '#6300C6',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #F3E8FF 0%, #B36AFF 30%, #6300C6 62%, #380071 100%)'
  },
  {
    id: 'sunset',
    label: 'Sunset',
    swatch: '#EA4B1E',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #FFE9DE 0%, #FFB38F 28%, #7F00FF 66%, #380071 100%)'
  }
];

const STORAGE_KEY = 'mpr_bg_theme';
const DEFAULT_THEME: BackgroundThemeId = 'violet';

export function getSavedBackgroundTheme(): BackgroundThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (BACKGROUND_THEMES.some((t) => t.id === saved)) return saved as BackgroundThemeId;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return DEFAULT_THEME;
}

// Applies the theme's gradient to the document root and remembers the
// choice. Called once at boot (see main.tsx, before the first paint so
// there's no flash of the old default) and again whenever the account
// picks a different one from ProfilePage.tsx.
export function applyBackgroundTheme(id: BackgroundThemeId): void {
  const theme = BACKGROUND_THEMES.find((t) => t.id === id) || BACKGROUND_THEMES[0];
  document.documentElement.style.setProperty('--g-bg-gradient', theme.gradient);
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // Offline/private-mode localStorage — the choice just won't survive a reload.
  }
}
