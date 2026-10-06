# PEPM update — Active Users, Employee Tracking updates, report column menus

Copy these files over the live project (same paths), then on the server:

    npm run build        # rebuilds the website (dist)
    pm2 restart all      # or however the server is restarted

No new npm packages are needed. New database tables are created on start
(`user_sessions`, `tracking_notice_recipients`, ...); nothing to run by hand.

## What is in it
- **Active Users** (Admin Panel -> Active Users, Superadmin only): who is signed
  in now / today / last 7 days, with IP address, browser/phone and last use.
  If the IP shows 127.0.0.1 the web server in front is not passing the visitor's
  address on (Nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
- **Employee Tracking**: Under Tracking / Not Tracked counts with department lists
  (Dashboard card / tile), notice to Not Tracked employees + monthly notice
  report, history report with addresses, Stay Report (new "Stay Report" layer),
  Live Follow (new "Live Follow" layer, off unless ticked in Users -> Module
  Access), location set-up card, background-location disclosure and a public
  /privacy page.
- **PEPM -> Reports -> All MPR Entries Report**: column menu on every header
  (Sort A->Z / Z->A, tick-to-hide unique values with x/y selected, Select all /
  Clear), "Columns" button for Duration / Logged By / Budget / Sub-1/2/3,
  Delivery Date in Excel as dd-mmm-yyyy (every column is still in the Excel).
- **Job Entry Details**: the parts of one split item are listed together.

The Android app (APK) changes for tracking live in the main repository's
`android/` folder; rebuild the APK from there to get them.
