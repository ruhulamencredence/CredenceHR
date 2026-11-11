/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// How tall the phone's own navigation bar (3 buttons / gesture line) or the
// iPhone's home indicator is where the page is drawn behind it — the
// --nav-room of index.css: the older Android APKs and the iPhone; 0 on the
// newer APK (the page ends above the bar) and on a computer. Dropdowns and
// floating cards placed by script use usableHeight() instead of
// window.innerHeight so they never open under that bar.
export function navRoomPx(): number {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:var(--nav-room, 0px)';
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  } catch {
    return 0;
  }
}

export const usableHeight = (): number => window.innerHeight - navRoomPx();
