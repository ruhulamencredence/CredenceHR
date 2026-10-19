/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
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

// Brings a just-focused field into the middle of its scroll area once the
// keyboard has finished opening (the browser's own attempt isn't reliable in
// every WebView). Use as onFocusCapture on a popup's scrolling body.
export const scrollFocusedFieldIntoView = (e: React.FocusEvent) => {
  const el = e.target as HTMLElement;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'file') return;
  setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
};
