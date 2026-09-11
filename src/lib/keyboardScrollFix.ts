/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// On a phone, focusing a text input opens the on-screen keyboard, which eats
// the bottom third-or-so of the screen. If the field being typed into happens
// to sit in that bottom area, it ends up hidden BEHIND the keyboard instead of
// scrolled up above it — exactly what was happening in the New MPR Entry form.
//
// The Android WebView is supposed to handle this by resizing itself and
// re-running layout (see capacitor.config.ts's `plugins.Keyboard.resize:
// 'body'`), but the resize + the keyboard's own slide-up animation both take
// a moment, and a field that was already on-screen before the keyboard opened
// doesn't automatically get re-scrolled into the new, smaller viewport. So:
// whenever ANY input/textarea/select in the app gains focus, wait for that
// animation to finish, then explicitly scroll it back into view.
//
// This is intentionally global (attached once, here) rather than added to
// every individual input — every text field in the app benefits automatically,
// including ones added later.
export function installKeyboardScrollFix(): () => void {
  const handleFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;

    // 350ms comfortably covers the keyboard's slide-up animation on virtually
    // every Android device/version — scrolling any earlier fights the
    // still-resizing viewport and can under/over-shoot.
    window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  };

  document.addEventListener('focusin', handleFocusIn);
  return () => document.removeEventListener('focusin', handleFocusIn);
}
