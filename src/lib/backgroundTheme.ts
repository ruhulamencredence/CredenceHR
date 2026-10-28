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
// index.css's body::before (a position: fixed, window-sized layer) keeps it
// anchored to the viewport either way, rather than scrolling with content.

export type BackgroundThemeId = 'default' | 'frosted-glass' | 'apple-glow' | 'mono';

export interface BackgroundTheme {
  id: BackgroundThemeId;
  label: string;
  // Small flat swatch color for the picker UI — not the actual gradient,
  // just a quick visual reference the account taps.
  swatch: string;
  gradient: string;
  // A theme that restyles the whole app, not just the background: sets
  // <html data-ui="..."> and index.css does the rest (colours, sidebar).
  ui?: 'mono';
}

// Color-stop percentages pushed further out again (light stop's own share
// now most of the glow) so the pale center dominates the screen, with the
// deep tone only showing right at the corners/edges.
// Frosted Glass: the office's frosted window film — rows of rounded white
// strips of uneven height on pale grey glass, lit from above. The strips are
// one SVG tile repeated across the width and faded out toward the bottom.
const FROSTED_GLASS_STRIPS =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='312' height='760' viewBox='0 0 312 760'%3E%3Cdefs%3E%3ClinearGradient id='f' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23fff'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.9'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/linearGradient%3E%3Cmask id='m'%3E%3Crect width='312' height='760' fill='url(%23f)'/%3E%3C/mask%3E%3C/defs%3E%3Cg mask='url(%23m)'%3E%3Crect x='3.5' y='109' width='6' height='390' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='16.5' y='220' width='6' height='322' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='29.5' y='162' width='6' height='414' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='42.5' y='220' width='6' height='333' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='55.5' y='162' width='6' height='479' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='68.5' y='241' width='6' height='404' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='81.5' y='195' width='6' height='483' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='94.5' y='245' width='6' height='450' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='107.5' y='197' width='6' height='556' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='120.5' y='251' width='6' height='367' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='133.5' y='189' width='6' height='424' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='146.5' y='232' width='6' height='367' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='159.5' y='99' width='6' height='398' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='172.5' y='158' width='6' height='451' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='185.5' y='61' width='6' height='534' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='198.5' y='142' width='6' height='399' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='211.5' y='54' width='6' height='554' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='224.5' y='86' width='6' height='569' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='237.5' y='51' width='6' height='592' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='250.5' y='102' width='6' height='626' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='263.5' y='48' width='6' height='646' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='276.5' y='151' width='6' height='495' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3Crect x='289.5' y='65' width='6' height='595' rx='3' fill='%23fff' fill-opacity='0.85'/%3E%3Crect x='302.5' y='171' width='6' height='481' rx='3' fill='%23fff' fill-opacity='0.62'/%3E%3C/g%3E%3C/svg%3E\")";

export const BACKGROUND_THEMES: BackgroundTheme[] = [
  {
    // The app's original background (index.css's own --g-bg-gradient
    // default, before this picker existed) — still selectable as "Classic".
    // Accounts that never picked one now start on Apple Glow.
    id: 'default',
    label: 'Classic',
    swatch: '#DBEEFF',
    gradient: 'linear-gradient(160deg, #eaf6ff 0%, #dbeeff 30%, #e7dcff 65%, #ede0ff 100%)'
  },
  {
    id: 'frosted-glass',
    label: 'Frosted Glass',
    swatch: '#C4C9C7',
    gradient: [
      'radial-gradient(ellipse 70% 30% at 50% 0%, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0) 70%)',
      `${FROSTED_GLASS_STRIPS} center top / 312px 760px repeat-x`,
      'linear-gradient(180deg, #e8eae9 0%, #cdd1cf 45%, #b6bbb9 100%)'
    ].join(', ')
  },
  {
    // Apple-style light glow: an almost white page with soft lavender and
    // violet light pooling at the corners and a bright white bloom in the
    // middle, so cards read cleanly on top.
    id: 'apple-glow',
    label: 'Apple Glow (Default)',
    swatch: '#EFE7FF',
    gradient: [
      'radial-gradient(ellipse 55% 45% at 50% 38%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 70%)',
      'radial-gradient(ellipse 60% 50% at 0% 0%, rgba(196,170,255,0.55) 0%, rgba(196,170,255,0) 65%)',
      'radial-gradient(ellipse 55% 45% at 100% 8%, rgba(232,206,255,0.7) 0%, rgba(232,206,255,0) 65%)',
      'radial-gradient(ellipse 70% 45% at 85% 100%, rgba(170,140,255,0.4) 0%, rgba(170,140,255,0) 70%)',
      'radial-gradient(ellipse 60% 40% at 10% 95%, rgba(240,220,255,0.75) 0%, rgba(240,220,255,0) 70%)',
      'linear-gradient(180deg, #fdfcff 0%, #f7f3ff 55%, #f2ecff 100%)'
    ].join(', ')
  },
  {
    // Minimal Mono: a quiet light-grey workspace with white cards and a
    // white sidebar, black for the main actions and neutral greys in place
    // of violet; status colours (green / amber / red) stay. Whole-app theme —
    // see html[data-ui="mono"] in index.css.
    id: 'mono',
    label: 'Minimal Mono',
    swatch: '#18181B',
    gradient: 'linear-gradient(180deg, #f6f6f7 0%, #f1f1f2 100%)',
    ui: 'mono'
  }
];

// Chat conversations always show Frosted Glass behind the messages,
// whatever app background the account picked.
export const CHAT_CONVERSATION_BACKGROUND = BACKGROUND_THEMES.find((t) => t.id === 'frosted-glass')!.gradient;

// Only a background the account picked in Profile -> Appearance is
// remembered (mpr_bg_theme_v2). The old key was also written at every start,
// so a stored "Default" there was never a real choice and is ignored; any
// other value there was picked, and is kept.
const STORAGE_KEY = 'mpr_bg_theme_v2';
const OLD_STORAGE_KEY = 'mpr_bg_theme';
const DEFAULT_THEME: BackgroundThemeId = 'apple-glow';
// A saved theme that no longer exists (Violet, Deep Violet and Sunset were
// removed) falls back to the default.
const isTheme = (v: string | null): v is BackgroundThemeId => BACKGROUND_THEMES.some((t) => t.id === v);

export function getSavedBackgroundTheme(): BackgroundThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (isTheme(old) && old !== 'default') return old;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return DEFAULT_THEME;
}

// Minimal Mono's colour touch: the pale shades (light backgrounds, chips,
// the open sidebar item, dashboard icon wells, a faint glow on the page)
// take a soft colour; text and main buttons stay black. "None" is pure mono.
// Per device, like the background (<html data-accent="...">, index.css).
export type MonoAccentId = 'none' | 'sky' | 'teal' | 'violet' | 'rose';
export const MONO_ACCENTS: { id: MonoAccentId; label: string; swatch: string; glow: string }[] = [
  { id: 'none', label: 'None', swatch: '#d4d4d8', glow: '' },
  { id: 'sky', label: 'Sky', swatch: '#7dd3fc', glow: '186,230,253' },
  { id: 'teal', label: 'Teal', swatch: '#5eead4', glow: '153,246,228' },
  { id: 'violet', label: 'Violet', swatch: '#c4b5fd', glow: '221,214,254' },
  { id: 'rose', label: 'Rose', swatch: '#fda4af', glow: '254,205,211' }
];
const ACCENT_KEY = 'mpr_mono_accent';
// Rose until the account picks another colour touch.
const DEFAULT_ACCENT: MonoAccentId = 'rose';
export function getSavedMonoAccent(): MonoAccentId {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (MONO_ACCENTS.some((a) => a.id === v)) return v as MonoAccentId;
  } catch {
    // localStorage unavailable — the default.
  }
  return DEFAULT_ACCENT;
}
// Mono's page background, with the touch's faint glow in two corners.
const monoGradient = (accent: MonoAccentId) => {
  const glow = MONO_ACCENTS.find((a) => a.id === accent)?.glow;
  const base = BACKGROUND_THEMES.find((t) => t.id === 'mono')!.gradient;
  return glow
    ? [`radial-gradient(ellipse 60% 45% at 0% 0%, rgba(${glow},0.35) 0%, rgba(${glow},0) 70%)`, `radial-gradient(ellipse 55% 40% at 100% 100%, rgba(${glow},0.28) 0%, rgba(${glow},0) 70%)`, base].join(', ')
    : base;
};
export function applyMonoAccent(id: MonoAccentId, remember = false): void {
  if (id === 'none') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = id;
  if (document.documentElement.dataset.ui === 'mono') document.documentElement.style.setProperty('--g-bg-gradient', monoGradient(id));
  if (!remember) return;
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {
    // The choice just won't survive a reload.
  }
}

// Applies the theme's gradient to the document root. Called once at boot
// (see main.tsx, before the first paint so there's no flash of the old
// default) and again — with remember — whenever the account picks a
// different one from ProfilePage.tsx.
export function applyBackgroundTheme(id: BackgroundThemeId, remember = false): void {
  const theme = BACKGROUND_THEMES.find((t) => t.id === id) || BACKGROUND_THEMES[0];
  if (theme.ui) document.documentElement.dataset.ui = theme.ui;
  else delete document.documentElement.dataset.ui;
  document.documentElement.style.setProperty('--g-bg-gradient', theme.ui === 'mono' ? monoGradient(getSavedMonoAccent()) : theme.gradient);
  if (theme.ui === 'mono') applyMonoAccent(getSavedMonoAccent());
  if (!remember) return;
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // Offline/private-mode localStorage — the choice just won't survive a reload.
  }
}
