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
  takePendingCall(o?: { group?: boolean }): Promise<{ callId?: string; action?: 'accept' | 'open'; group?: PendingGroup }>;
  cancelIncoming(o: { callId: string; ringingHere?: boolean }): Promise<void>;
  startRinging(): Promise<void>;
  stopRinging(): Promise<void>;
  getCallSetup(): Promise<CallSetup>;
  openCallSetting(o: { which: keyof CallSetup }): Promise<void>;
  addListener(event: 'callAction', cb: (d: { callId: string; action: 'accept' | 'open'; group?: PendingGroup }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callHangup', cb: () => void): Promise<{ remove: () => void }>;
  addListener(event: 'ringHandover', cb: () => void): Promise<{ remove: () => void }>;
  addListener(event: 'pictureInPicture', cb: (d: { on: boolean }) => void): Promise<{ remove: () => void }>;
}

/** A group call answered from the phone's call screen (what GroupCallLayer needs to join it). */
export interface PendingGroup {
  roomId?: string;
  title?: string;
  kind?: string;
  fromName?: string;
}

/** What this phone allows for calls with the app closed (CallAudioPlugin.getCallSetup). */
export interface CallSetup {
  notifications: boolean;
  fullScreen: boolean;
  overlay: boolean;
  battery: boolean;
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

/** The app opened from the call screen while already running (one-to-one calls). */
export function onCallAction(cb: (d: { callId: string; action: 'accept' | 'open' }) => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('callAction', (d) => {
    if (!d?.group) cb(d);
  })
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}

export interface PendingGroupCall {
  callId: string;
  action: 'accept' | 'open';
  roomId: number;
  title: string;
  kind: 'audio' | 'video';
  fromName: string;
}
const toGroup = (d: { callId?: string; action?: string; group?: PendingGroup } | null | undefined): PendingGroupCall | null =>
  d?.callId && d.group
    ? { callId: d.callId, action: d.action === 'accept' ? 'accept' : 'open', roomId: Number(d.group.roomId) || 0, title: d.group.title || 'Group', kind: d.group.kind === 'video' ? 'video' : 'audio', fromName: d.group.fromName || '' }
    : null;

/** A group call answered (or opened) from the phone's call screen, once, or null. */
export async function takePendingGroupCall(): Promise<PendingGroupCall | null> {
  if (!callAudioAvailable()) return null;
  try {
    return toGroup(await CallAudio.takePendingCall({ group: true }));
  } catch {
    return null;
  }
}

export function onGroupCallAction(cb: (d: PendingGroupCall) => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('callAction', (d) => {
    const g = toGroup(d);
    if (g) cb(g);
  })
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}

// ---- ringing with the phone's own ringtone --------------------------------
// On the Android app an incoming call rings with the ringtone set in the
// phone's Sound settings, looping, with vibration (CallRinger.java — follows
// Silent / Vibrate / Do Not Disturb). The website and older APKs keep the
// page's own beeps: `web` is used when the phone can't.
export function phoneRingFirst(web: { start(): void; stop(): void }): { start(): void; stop(): void } {
  let native = false;
  let usingWeb = false;
  return {
    start() {
      this.stop();
      if (!callAudioAvailable()) {
        usingWeb = true;
        return web.start();
      }
      native = true;
      CallAudio.startRinging().catch(() => {
        // an APK without it
        if (native) {
          native = false;
          usingWeb = true;
          web.start();
        }
      });
    },
    stop() {
      if (native) CallAudio.stopRinging().catch(() => undefined);
      native = false;
      if (usingWeb) web.stop();
      usingWeb = false;
    }
  };
}

/** null on the website / an older APK. */
export async function getCallSetup(): Promise<CallSetup | null> {
  if (!callAudioAvailable()) return null;
  try {
    const r = await CallAudio.getCallSetup();
    return { notifications: !!r.notifications, fullScreen: !!r.fullScreen, overlay: !!r.overlay, battery: !!r.battery };
  } catch {
    return null;
  }
}

export async function openCallSetting(which: keyof CallSetup): Promise<void> {
  if (!callAudioAvailable()) return;
  await CallAudio.openCallSetting({ which }).catch(() => undefined);
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

/** The page answered / ended it: take the phone's call screen away.
 *  ringingHere: the page got the call and rings it — the phone's call screen
 *  goes only while the app is on screen (a page left in the background keeps
 *  its connection; the call screen and ringtone stay). */
export function cancelIncomingCallScreen(callId: string | null, ringingHere = false): void {
  if (!callId || !callAudioAvailable()) return;
  CallAudio.cancelIncoming({ callId, ringingHere }).catch(() => undefined);
}

/** The app came on screen while the phone's call screen rang: ring in the page now. */
export function onRingHandover(cb: () => void): () => void {
  if (!callAudioAvailable()) return () => undefined;
  let handle: { remove: () => void } | null = null;
  let gone = false;
  CallAudio.addListener('ringHandover', cb)
    .then((h) => (gone ? h.remove() : (handle = h)))
    .catch(() => undefined);
  return () => {
    gone = true;
    handle?.remove();
  };
}
