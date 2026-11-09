/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';

// The on-screen keyboard's height in the mobile app (0 on the web and while
// it's closed). Some Android WebViews never shrink the page when the keyboard
// opens, so a focused field near the bottom of a popup stays hidden under it;
// reserving this much space at the bottom (padding) gives the popup room to
// scroll the field up. Same approach as AuthScreen.tsx / ChatPanel.tsx.
export function useKeyboardInset(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let show: { remove: () => void } | undefined;
    let hide: { remove: () => void } | undefined;
    (async () => {
      try {
        const { Keyboard } = await import('@capacitor/keyboard');
        show = await Keyboard.addListener('keyboardWillShow', (info) => setHeight(info.keyboardHeight));
        hide = await Keyboard.addListener('keyboardWillHide', () => setHeight(0));
      } catch {
        // Plugin unavailable — the scroll-into-view below still helps.
      }
    })();
    return () => {
      show?.remove();
      hide?.remove();
    };
  }, []);
  return height;
}

// How much of the screen's bottom the on-screen keyboard covers that the page
// (a popup or full-screen view) doesn't already avoid. The app: the keyboard's height,
// minus whatever the WebView shrank by itself (some Android WebViews shrink,
// some don't). A phone browser: what the visual viewport lost at the bottom.
export function useKeyboardGap(): { gap: number; open: boolean } {
  const kb = useKeyboardInset();
  const [, redraw] = useState(0);
  const base = useRef(typeof window !== 'undefined' ? window.innerHeight : 0);
  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => redraw((n) => n + 1);
    window.addEventListener('resize', on);
    vv?.addEventListener('resize', on);
    vv?.addEventListener('scroll', on);
    return () => {
      window.removeEventListener('resize', on);
      vv?.removeEventListener('resize', on);
      vv?.removeEventListener('scroll', on);
    };
  }, []);
  if (Capacitor.isNativePlatform()) {
    if (!kb) {
      base.current = window.innerHeight;
      return { gap: 0, open: false };
    }
    return { gap: Math.max(0, kb - Math.max(0, base.current - window.innerHeight)), open: kb > 80 };
  }
  const vv = window.visualViewport;
  const gap = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  return { gap, open: gap > 80 };
}

// Brings a just-focused field into the middle of its scroll area once the
// keyboard has finished opening (the browser's own attempt isn't reliable in
// every WebView). Use as onFocusCapture on a popup's scrolling body.
export const scrollFocusedFieldIntoView = (e: React.FocusEvent) => {
  const el = e.target as HTMLElement;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'file') return;
  setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
};
