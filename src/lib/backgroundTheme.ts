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

export type BackgroundThemeId = 'default' | 'violet' | 'deep-violet' | 'sunset';

export interface BackgroundTheme {
  id: BackgroundThemeId;
  label: string;
  // Small flat swatch color for the picker UI — not the actual gradient,
  // just a quick visual reference the account taps.
  swatch: string;
  gradient: string;
}

// Color-stop percentages pushed further out again (light stop's own share
// now most of the glow) so the pale center dominates the screen, with the
// deep tone only showing right at the corners/edges.
export const BACKGROUND_THEMES: BackgroundTheme[] = [
  {
    // The app's original background (index.css's own --g-bg-gradient
    // default, before this picker existed) — kept as its own selectable
    // option, and the one every account starts on, rather than switching
    // everyone over to one of the 3 new looks by default.
    id: 'default',
    label: 'Default',
    swatch: '#DBEEFF',
    gradient: 'linear-gradient(160deg, #eaf6ff 0%, #dbeeff 30%, #e7dcff 65%, #ede0ff 100%)'
  },
  {
    id: 'violet',
    label: 'Violet',
    swatch: '#B36AFF',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #EFE0FF 0%, #D2A8FF 65%, #7F00FF 90%, #47008E 100%)'
  },
  {
    id: 'deep-violet',
    label: 'Deep Violet',
    swatch: '#6300C6',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #F3E8FF 0%, #B36AFF 62%, #6300C6 88%, #380071 100%)'
  },
  {
    id: 'sunset',
    label: 'Sunset',
    swatch: '#EA4B1E',
    gradient:
      'radial-gradient(ellipse 90% 60% at 50% 20%, #FFE9DE 0%, #FFB38F 60%, #7F00FF 88%, #380071 100%)'
  }
];

const STORAGE_KEY = 'mpr_bg_theme';
const DEFAULT_THEME: BackgroundThemeId = 'default';

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
