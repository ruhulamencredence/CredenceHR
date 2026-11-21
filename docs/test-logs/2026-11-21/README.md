# Test log — 21 November 2026

## 360 ERP sign-in: an email even when the login has none

`Erp360SsoRoutes.ts`: the email sent to 360 ERP is the login's own email read fresh from the database, else the office
email on the Employee record; with neither, a clear message and 360 ERP isn't called. (Employee-ID logins have no email,
so 360 ERP answered "The email field is required.")

- `scripts/erp360-sso-email-api.mjs` (server started with `ERP360_BASE_URL=http://127.0.0.1:3299`, a fake 360 ERP in the
  script): **3/3** — login with no email → the Employee's office email is sent; a login email set after sign-in → that one
  (not the token's); no email anywhere → "no email address … ask HR" (400) and 360 ERP not called.

## Check In / Out popup squeezed to one line while typing Remarks (phone app)

`src/lib/useKeyboardInset.ts` (`useKeyboardGap`, shared by the Check In/Out, Bill Claim and Mail popups): the full height
is the largest seen with the keyboard closed (a WebView that shrank before the keyboard event no longer lowers it, which
made the gap count the keyboard twice); a WebView that already made room by itself adds nothing; whatever the measure, at
least 240px of the screen stays for the popup; turning the phone measures again. `AttendanceMapConfirm.tsx`: the box is
`overflow-clip`, so moving the cursor into Remarks scrolls only its body, never the header away.

- Phone emulation (390×844, then the page shrunk to 390×420 as a resizing WebView does, Remarks focused): header, the
  in-area line, Remarks and Confirm all on screen (screenshot checked). The Android keyboard itself can't be driven here —
  to be checked on a phone after the APK / live update.

## APK opening: one logo, not two

Android 12+ draws its own launch splash with the launcher icon cropped to a circle and scaled up (soft), before the
app's own sharp logo (`index.html` `#mpr-boot-spinner`) and the open animation — the logo showed twice. `styles.xml`
(`AppTheme.NoActionBarLaunch`): `windowSplashScreenAnimatedIcon` (and the `android:` one, API 31+) is now
`drawable/splash_blank.xml`, a see-through 1dp shape, on the same orange `#F47920`. Older Android keeps
`@drawable/splash` (the same sharp logo). Checked by the Android build workflow (no Android SDK in this container);
to see on a phone, install the new APK.

