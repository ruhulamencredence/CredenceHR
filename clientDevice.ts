/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which kind of device a request comes from: the iPhone / iPad "Add to Home
// Screen" app gets its own, longer sign-in (SessionSecurity.ts "pwa")
// instead of the website's.
//
// It is read from the browser's User-Agent. iPad Safari calls itself a Mac
// ("Macintosh"), so the page also says when it is on a touch screen
// (touch_device in the body, or the X-Touch-Device header): a Mac with a
// touch screen is an iPad. Someone who deliberately changes their browser's
// User-Agent could get past this; an ordinary user can't. The app (APK) is
// recognised by its own sign-in, which the server issued.

const uaOf = (req: any) => String(req?.headers?.["user-agent"] || "");

// The page says it is on a touch screen (only matters for "Macintosh").
export const saysTouch = (req: any) => req?.body?.touch_device === true || String(req?.headers?.["x-touch-device"] || "") === "1";

export function isAppleMobile(req: any): boolean {
  const ua = uaOf(req);
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPad Safari asks for desktop pages and calls itself a Mac.
  return /Macintosh/i.test(ua) && saysTouch(req);
}
