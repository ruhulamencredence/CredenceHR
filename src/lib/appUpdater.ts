/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The Android app's own updater (android/.../AppUpdaterPlugin.java): downloads
// the new APK inside the app and opens Android's install screen for it.
// Only in APKs built with it — an older app has no such plugin and
// AppUpdatePrompt.tsx sends it to the browser as before.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface UpdateProgress {
  loaded: number;
  total: number; // -1 when the server doesn't say
}

interface AppUpdaterPlugin {
  download(opts: { url: string }): Promise<{ size: number; versionName?: string }>;
  cancel(): Promise<void>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<{ allowed: boolean }>;
  install(): Promise<void>;
  addListener(event: 'progress', fn: (p: UpdateProgress) => void): Promise<PluginListenerHandle>;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

export const hasInAppUpdate = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AppUpdater');
