/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where call sound plays in the Android app: the ear speaker (earpiece) or
// the loudspeaker (CallAudioPlugin.java). The website and an app built
// before this plugin can't choose — the browser decides — so `available`
// is false there and the Speaker button is hidden.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface CallAudioPlugin {
  start(o: { speaker: boolean }): Promise<{ active: boolean; speaker: boolean }>;
  setSpeaker(o: { on: boolean }): Promise<{ active: boolean; speaker: boolean }>;
  stop(): Promise<{ active: boolean; speaker: boolean }>;
  takePendingCall(): Promise<{ callId?: string; action?: 'accept' | 'open' }>;
  cancelIncoming(o: { callId: string }): Promise<void>;
  addListener(event: 'callAction', cb: (d: { callId: string; action: 'accept' | 'open' }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callHangup', cb: () => void): Promise<{ remove: () => void }>;
  addListener(event: 'pictureInPicture', cb: (d: { on: boolean }) => void): Promise<{ remove: () => void }>;
}

const CallAudio = registerPlugin<CallAudioPlugin>('CallAudio');

export const callAudioAvailable = (): boolean => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('CallAudio');

/** "In a call" mode: earpiece for an audio call, loudspeaker for video. */
export async function startCallAudio(speaker: boolean): Promise<boolean> {
  if (!callAudioAvailable()) return false;
  try {
    await CallAudio.start({ speaker });
    return true;
  } catch {
    return false;
  }
}

export async function setCallSpeaker(on: boolean): Promise<boolean> {
  if (!callAudioAvailable()) return false;
  try {
    await CallAudio.setSpeaker({ on });
    return true;
  } catch {
    return false;
  }
}

export async function stopCallAudio(): Promise<void> {
  if (!callAudioAvailable()) return;
  await CallAudio.stop().catch(() => undefined);
}

// ---- the phone's incoming-call screen (IncomingCall.java) ----------------
// A call answered (or opened) from the notification while the app was
// closed / in the background, waiting for the page: once, or null.
export async function takePendingCall(): Promise<{ callId: string; action: 'accept' | 'open' } | null> {
  if (!callAudioAvailable()) return null;
  try {
    const r = await CallAudio.takePendingCall();
    return r?.callId ? { callId: r.callId, action: r.action === 'accept' ? 'accept' : 'open' } : null;
  } catch {
    return null; // an older APK without it
  }
}

/** The app opened from the call screen while already running. */
export function onCallAction(cb: (d: { callId: string; action: 'accept' | 'open' }) => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('callAction', cb)
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}

/** Hang up tapped on the "Call in progress" notification (CallService.java,
 *  which keeps a call going while the app is left): end the call. */
export function onCallHangup(cb: () => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('callHangup', cb)
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}

/** The app went into / came out of the phone's picture-in-picture window
 *  (MainActivity: leaving the app during a video call). */
export function onPictureInPicture(cb: (on: boolean) => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('pictureInPicture', (d) => cb(!!d?.on))
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}

/** The page rings / answered / ended it: take the phone's call screen away. */
export function cancelIncomingCallScreen(callId: string | null): void {
  if (!callId || !callAudioAvailable()) return;
  CallAudio.cancelIncoming({ callId }).catch(() => undefined);
}
