/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The on-screen keyboard's height, for every popup and sheet at once.
//
// The app (capacitor.config.ts: Keyboard.resize 'body') shrinks only the
// page body when the keyboard opens; a phone browser shrinks only its
// visual viewport. Either way a `position: fixed` popup still spans the
// whole screen, so its lower fields end up behind the keyboard — and most
// popups (65 files) never handled that themselves. This sets
//   <html class="kb-open" style="--kb: 312px">
// while the keyboard is up, and index.css lifts the bottom of every fixed
// popup / bottom sheet above it (html.kb-open … in index.css). A popup that
// already keeps itself above the keyboard is marked data-kb-self and left
// alone. keyboardScrollFix.ts then scrolls the
// focused field into the space that is left.
import { Capacitor } from '@capacitor/core';

export function installKeyboardInsetVar(): () => void {
  const root = document.documentElement;
  const apply = (px: number) => {
    const h = Math.max(0, Math.round(px));
    if (h > 80) {
      root.style.setProperty('--kb', `${h}px`);
      root.classList.add('kb-open');
    } else {
      root.style.removeProperty('--kb');
      root.classList.remove('kb-open');
    }
  };
  const cleanups: (() => void)[] = [];

  if (Capacitor.isNativePlatform()) {
    let alive = true;
    (async () => {
      try {
        const { Keyboard } = await import('@capacitor/keyboard');
        const show = await Keyboard.addListener('keyboardWillShow', (info) => apply(info.keyboardHeight));
        const hide = await Keyboard.addListener('keyboardWillHide', () => apply(0));
        if (!alive) {
          show.remove();
          hide.remove();
          return;
        }
        cleanups.push(() => show.remove(), () => hide.remove());
      } catch {
        // plugin unavailable — popups behave as before
      }
    })();
    cleanups.push(() => {
      alive = false;
    });
  } else {
    const vv = window.visualViewport;
    if (vv) {
      const on = () => apply(window.innerHeight - vv.height - vv.offsetTop);
      vv.addEventListener('resize', on);
      vv.addEventListener('scroll', on);
      cleanups.push(() => {
        vv.removeEventListener('resize', on);
        vv.removeEventListener('scroll', on);
      });
    }
  }
  // For checks in a desktop browser (no on-screen keyboard there).
  if (import.meta.env.DEV) (window as any).__credenceKeyboard = apply;

  return () => {
    cleanups.forEach((f) => f());
    apply(0);
  };
}
