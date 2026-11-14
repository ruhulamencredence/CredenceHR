/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which kind of device a request comes from, for two rules:
//
//  1. Attendance (Check In / Check Out) from a browser is only taken on an
//     iPhone or iPad — there is no app for them. Android must use the app
//     (APK), where the location is read properly and tracking works; a
//     computer can't give attendance at all.
//  2. The iPhone / iPad "Add to Home Screen" app gets its own, longer sign-in
//     (SessionSecurity.ts "pwa") instead of the website's.
//
// It is read from the browser's User-Agent. iPad Safari calls itself a Mac
// ("Macintosh"), so the page also says when it is on a touch screen
// (touch_device in the body, or the X-Touch-Device header): a Mac with a
// touch screen is an iPad. Someone who deliberately changes their browser's
// User-Agent could get past this; an ordinary user can't. The app (APK) is
// recognised by its own sign-in, which the server issued.

import { isAppSession } from "./SessionSecurity";

const uaOf = (req: any) => String(req?.headers?.["user-agent"] || "");

// The page says it is on a touch screen (only matters for "Macintosh").
export const saysTouch = (req: any) => req?.body?.touch_device === true || String(req?.headers?.["x-touch-device"] || "") === "1";

export function isAppleMobile(req: any): boolean {
  const ua = uaOf(req);
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPad Safari asks for desktop pages and calls itself a Mac.
  return /Macintosh/i.test(ua) && saysTouch(req);
}

export const isAndroidBrowser = (req: any) => /Android/i.test(uaOf(req));

export const ATTENDANCE_ANDROID_MESSAGE = "On Android, attendance is given from the app only. Install the app (APK) and give your attendance there.";
export const ATTENDANCE_COMPUTER_MESSAGE = "Attendance can't be given from a computer. Use the app on your phone, or an iPhone / iPad.";

// null = this device may give attendance.
export function attendanceDeviceProblem(req: any): { code: string; error: string; device: "android" | "computer" } | null {
  if (isAppSession(req.user, req)) return null;
  if (isAppleMobile(req)) return null;
  if (isAndroidBrowser(req)) return { code: "ATTENDANCE_APP_ONLY", error: ATTENDANCE_ANDROID_MESSAGE, device: "android" };
  return { code: "ATTENDANCE_NOT_ON_COMPUTER", error: ATTENDANCE_COMPUTER_MESSAGE, device: "computer" };
}

// Express guard for the attendance routes.
export const requireAttendanceDevice = (req: any, res: any, next: any) => {
  const problem = attendanceDeviceProblem(req);
  if (!problem) return next();
  res.status(403).json({ error: problem.error, code: problem.code });
};
