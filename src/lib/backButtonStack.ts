/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// This app has no router/URL history — every modal, drill-down view, and popup
// is just a bit of component state (e.g. `editingProject !== null`). So the
// hardware back button on Android has nothing to "go back" through by default,
// and Capacitor just closes the whole app immediately from any screen.
//
// Fix: every dismissible modal/drill-down registers itself here (via the
// useBackButtonClose hook in useBackButtonClose.ts) while it's open. The single
// global back-button listener in App.tsx always closes whichever one opened
// most recently, instead of exiting — and only exits when nothing is open, and
// only on a second press within 2 seconds (see App.tsx).

type CloseHandler = () => void;

const stack: { id: string; close: CloseHandler }[] = [];

export function pushBackHandler(id: string, close: CloseHandler): void {
  stack.push({ id, close });
}

export function popBackHandler(id: string): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index !== -1) stack.splice(index, 1);
}

// Closes the most-recently-opened modal/drill-down, if any are open. Returns
// true if it handled the back press (so the caller shouldn't also try to exit
// the app), false if the stack was empty (nothing to close — we're at a "root"
// screen, e.g. the main Admin/User dashboard with nothing open over it).
export function closeTopmostOrReturnFalse(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
