/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Stone & Olive (backgroundTheme.ts 'stone'): a few touches CSS can't do on
// its own. The rest of the theme is stoneOlive.css, keyed on
// <html data-bg="stone"> (light modes only).

export const THEME_CHANGE_EVENT = 'credence:theme-change';

export const isStoneTheme = (): boolean => {
  const root = document.documentElement;
  return root.dataset.bg === 'stone' && !root.hasAttribute('data-dark');
};

// The Leave Summary cut-out around the leave card is in every theme now
// (src/lib/leaveCarve.ts).
