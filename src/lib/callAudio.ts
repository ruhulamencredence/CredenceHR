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
