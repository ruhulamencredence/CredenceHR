/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Check for new Notices now" — NoticePopup listens for it. Fired when the
// server says a Notice was published (Socket.IO 'notices:changed', see
// chatSocket.ts), when the socket reconnects, and when a notice push
// notification is tapped.
export const NOTICES_CHANGED_EVENT = 'credence:notices-changed';

export function refreshNotices(): void {
  window.dispatchEvent(new Event(NOTICES_CHANGED_EVENT));
}
