# Employee Tracking — live location of the mobile app's users

Adds a new "Employee Tracking" Admin Panel module: an always-on background
location feed from the Android APK, a live map showing every reporting user's
current position (green pulsing dot, greys out after 20 min of silence), and
per-user path playback for a chosen date range.

Follows the exact same permission model as everything else in this app:

- **Who can VIEW the tracking board** — gated by a new `"tracking"`
  AdminModuleKey. A Superadmin always has it; grantable to specific Admins via
  the existing "Module Access" control (Admin Panel -> Users -> Manage
  Modules) — no new UI needed there, the modal already loops generically over
  `ADMIN_MODULES`.
- **Whose PHONE reports location** — gated by a new per-user
  `can_use_tracking` flag (Admin Panel -> Users -> new "Employee Tracking"
  toggle column, right next to "Remote Attendance"). OFF by default; a
  Superadmin always has it implicitly.

These are deliberately separate, same as `attendance` (module) vs.
`can_use_attendance` (per-account) already were.

## How "live" it is

Per your answers: tracking keeps running even while the app is minimized or
fully closed (not just while it's open), pinging roughly every 5-10 minutes.
That requires a **background service**, which the previous
`@capacitor/geolocation` plugin (still used for the one-off reads at
login/Attendance/Claims — untouched) cannot do; it stops the moment the app
leaves the foreground. This uses
`@capacitor-community/background-geolocation` instead, which keeps an Android
foreground service alive with a persistent "Employee Tracking active"
notification (Android requires this be visible — it cannot be hidden).

## How to apply

Drop these files into the matching paths in the project root (they replace
the originals 1:1). Syntax-checked each file individually with `esbuild`
(clean parse); **not** verified end-to-end with `npx tsc --noEmit` / `npx
vite build` against the full project's dependencies (no network access to
Google's Maven repo in this sandbox to actually run a Gradle build) — please
run those yourself before deploying, and see "Rebuild steps" below.

### New files
- `src/components/EmployeeTrackingPanel.tsx` — the Admin Panel tab: Leaflet
  map + live user list on the left/right, click a user to switch into path
  playback for a date range.
- `src/lib/backgroundTracking.ts` — the APK-side watcher: starts/stops the
  native background location service based on `user.can_use_tracking`, and
  throttles actual network pings to once every ~7 minutes regardless of how
  often the OS delivers a GPS fix (keeps battery/data usage sane).

### Modified files
- `schema.sql` — new `location_pings` table; `can_use_tracking` column on
  `users`.
- `server.ts` — same self-healing `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`
  migration pattern as every other feature here (no manual migration step);
  `"tracking"` added to `ADMIN_MODULE_KEYS`; three new routes:
  - `POST /api/tracking/ping` — device -> server (gated by `can_use_tracking`)
  - `GET /api/tracking/live` — latest ping per user (gated by the `tracking`
    module)
  - `GET /api/tracking/history?user_id=&from=&to=` — one user's full path
  - `can_use_tracking` threaded through `/api/auth/login`, `/api/auth/me`,
    `/api/users`, and `PUT /api/users/:id/feature-permissions`, plus the
    in-memory dev-mode DB fallback (for testing without MySQL running).
- `src/types.ts` — `tracking` added to `AdminModuleKey`/`ADMIN_MODULES`/
  `AdminNavRequest`; new `LocationPing` interface; `can_use_tracking` added to
  `User`.
- `src/components/AdminPanel.tsx` — new tab button + tab body (mobile nav
  list), new "Employee Tracking" toggle column in the Users table.
- `src/components/Navbar.tsx` — "Employee Tracking" added to the desktop
  "Workforce" header menu, next to "Remote Attendance".
- `src/App.tsx` — starts/stops the background watcher whenever
  `user.can_use_tracking` changes (on login, and whenever `/api/auth/me`
  picks up a change), independent of which panel (User/Admin) is on screen.
- `package.json` — added `@capacitor-community/background-geolocation@^1.2.26`.
- `capacitor.config.ts` — `android.useLegacyBridge: true` (required by the new
  plugin so updates don't stop after ~5 min backgrounded — see its README).
- `android/app/src/main/AndroidManifest.xml` — added
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.
- `android/app/src/main/res/values/strings.xml` — text/icon/color for the
  required "still tracking" notification.

## Rebuild steps (you'll need to run these yourself)

```
npm install
npm run build
npx cap sync android
```

Then open `android/` in Android Studio and build/sign the APK as usual. The
web build (`npm run build && npm start`) needs no extra steps — Employee
Tracking simply won't activate there (`Capacitor.isNativePlatform()` is
`false` on web), same as every other Capacitor-only feature in this app.

## After deploying

1. Import the updated `schema.sql` (or just restart the server against an
   existing DB — the self-healing migrations add `location_pings` and
   `can_use_tracking` automatically).
2. Grant the `tracking` module to whichever Admins should see the board
   (Admin Panel -> Users -> Manage Modules).
3. Turn on the "Employee Tracking" toggle for whichever users' phones should
   report (Admin Panel -> Users). It's OFF for everyone by default.
4. On first launch after that, the device will prompt for location
   permission — the user must choose **"Allow all the time"**, not "While
   using the app", or background pings won't work. On Android 13+ it'll also
   ask for notification permission (needed to show the required "still
   tracking" notice).
