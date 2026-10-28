# Update 5: the live server catches up with the test branch (whole app)

Goes on top of update 4 (`DEPLOY_NOTES_pepm_update_4.md`). From here the
live code is the same as `claude/nice-fermi-0tale9` at commit 4cc6115, with
two deliberate differences for this deployment:

- Audio / video calls stay off in Chat (no call button).
- Voice notes in Chat use the app's own recorder only when the installed
  app has it; an older app records through the WebView, as before.

Up to update 4 only PEPM, Chat and a few security fixes went live; HR
(Payroll, Conveyance, Approvals, Leave, Attendance, Assets, Grievance,
Exit, Holidays…) and the sidebar were still the 1 Oct code. They now carry
every fix and change made since.

## Before you start

1. **Back up the database.** The first start adds many tables and columns
   (multi-company, payroll approval, loans, roster, mail, e-sign, tracking,
   requisitions, onboarding, feedback…). Nothing existing is deleted or
   rewritten, but take the backup anyway.
2. Back up the current project folder too, so you can go back.

## Steps on the server

    # copy the zip's files over the project, then delete the old files below
    npm install          # many new and updated packages, see below
    npm run build
    pm2 restart all      # or however the server is restarted

Copying files over does not delete old ones. Delete these (no longer used):

    ServerProfileRoutes.ts
    UserAccessExtras.ts
    src/components/ServerProfilesPanel.tsx
    src/components/ServerSwitcherModal.tsx
    src/components/LeaveApplication.tsx
    src/components/LeaveApprovals.tsx
    src/components/LeaveManagement.tsx
    src/components/MyConveyanceBillClaimPanel.tsx
    src/components/MyLeave.tsx
    src/components/uiKit.tsx
    src/assets/auth-hero.json
    src/assets/warehouse-delivery.json
    src/assets/icon.png
    src/assets/icon-background.png
    src/assets/icon-foreground.png
    src/assets/icon-source.png

## .env

Nothing new is required. Worth setting:

- `JWT_SECRET` — a long random value (`openssl rand -hex 48`). If it is
  missing or short the server makes its own key in `.jwt-secret` (see update
  4); everyone then signs in again once.
- `CORS_ORIGINS` — the site's own address(es), e.g.
  `https://hr.credencehousinglimited.com`. Unset, the server works as now
  and only warns in the log.
- Optional, only for the features that use them: `SMTP_*` (password reset
  emails, emailed reports), `MAIL_ENCRYPTION_KEY` (Credence Mail),
  `FIREBASE_SERVICE_ACCOUNT_JSON` (app push), `ESIGN_*` (e-signature seal),
  `PUBLIC_APP_URL`, `REDIS_URL` (PM2 cluster mode).

## Packages

New or upgraded in package.json (installed by `npm install`): Capacitor 8
(was 6), firebase-admin 14, nodemailer 10, xlsx 0.20.3 (from the SheetJS
CDN), web-push, imapflow, mailparser, pdf-lib, @pdf-lib/fontkit, @signpdf/*,
node-forge, qrcode, @simplewebauthn/*, @capgo/capacitor-native-biometric,
capacitor-voice-recorder 7. Removed: motion, dxf-parser,
@mlightcad/libredwg-web.

The Android app: the website keeps working in the installed app. Features
that need the app itself (fingerprint sign-in, the newer voice recorder,
Android 15 edge-to-edge) need an APK built from this code (GitHub ->
Actions -> Android).

## What people will notice

- **Sidebar**: the new grouped menu (Work & Approvals, PEPM Operation,
  Leave & Attendance, Requests & Claims, Others; Admin Panel groups by area)
  with search and favourites. Everyone sees only what they have access to.
- **New modules** (Requisitions, Mail, Duty Roster, Loans, Targets, Tasks,
  E-sign, Break Time, Mobile Bill, Onboarding / Exit, HR Operations…) are
  off for everyone until given in Users -> Module Access. A Superadmin sees
  all of them.
- **Approvals**: a request from someone with no Supervisor and no Approval
  Template no longer approves itself; it waits as "No approver set yet"
  and Superadmins are alerted.
- **Payroll**: approved Leave Without Pay is cut from the pay; attendance
  can't add up to more than the working days; the salary month can start on
  any day (Payroll -> Salary Month, e.g. 26th — set its first month to the
  month before the one you want to change).
- **Leave**: no second application for the same days; weekend / holiday
  counting per leave type; leave rules (accrual, carry-forward,
  eligibility).
- **Conveyance**: one claim a day, edit until the first approver acts, an
  approver can cut an amount but not raise it; a bill can't be paid twice.
- **Sign-in**: the Login ID can be the Employee ID; sessions end on
  logout, long idle time or a password change; "Forgot password?" on the
  login page.
- **Removed**: the "Set Server" switcher (Server Profiles) — it was unused.

## Checked before release

On a copy of a live-like database (built with the 1 Oct live code, then
update 4, then this): the server started with no errors and kept every
user, employee, attendance row, leave, claim, budget and payroll; 367 API
reads as Superadmin and every write with bad input gave no server error;
121 pages (Superadmin and an employee, desktop and phone) opened with no
problems; the October payroll test (50 employees, 26 Sep – 25 Oct) passed
144 / 144.
