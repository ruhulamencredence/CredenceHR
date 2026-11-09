/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The login screen's illustration animation (AuthHeroLottie.tsx): a plain
// JSON file with a content hash in its address (Vite `?url`), kept on the
// device by assetCache.ts — downloaded once, then shown without the network
// on the website, phone browsers, "Add to Home screen" and the Android app.

import heroUrl from '../assets/office-illustration.json?url';
import { cachedJson, keepOnDevice } from './assetCache';

export const loadAuthHero = (): Promise<{ default: any }> => cachedJson(heroUrl).then((d) => ({ default: d }));

/** Signed in: fetch it once in the background, so a later sign-out's login
 *  screen shows it straight away (no-op when it is already on the device). */
export const keepAuthHeroOnDevice = (): Promise<void> => keepOnDevice(heroUrl);
