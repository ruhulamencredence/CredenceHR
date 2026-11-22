// Shared between the app's open animation (components/BootIntroAnimation.tsx)
// and the screens under it, without pulling the animation's code into them.
//
// While the animation covers the screen, <html> carries data-boot-intro (set
// in main.tsx before the first render) and the app under it is hidden
// (index.css). When the animation starts fading out the attribute goes and
// BOOT_INTRO_DONE_EVENT fires, so a screen can hold its own animation (the
// sign-in picture) until then instead of competing with the intro for frames.
export const BOOT_INTRO_ATTR = 'data-boot-intro';
export const BOOT_INTRO_DONE_EVENT = 'chr-boot-intro-done';

export function bootIntroPlaying(): boolean {
  return document.documentElement.hasAttribute(BOOT_INTRO_ATTR);
}

export function markBootIntroPlaying() {
  document.documentElement.setAttribute(BOOT_INTRO_ATTR, '');
}

export function markBootIntroDone() {
  if (!bootIntroPlaying()) return;
  document.documentElement.removeAttribute(BOOT_INTRO_ATTR);
  window.dispatchEvent(new Event(BOOT_INTRO_DONE_EVENT));
}
