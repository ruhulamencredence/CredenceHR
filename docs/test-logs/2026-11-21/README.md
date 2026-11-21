# Test log — 21 November 2026

## 360 ERP sign-in: an email even when the login has none

`Erp360SsoRoutes.ts`: the email sent to 360 ERP is the login's own email read fresh from the database, else the office
email on the Employee record; with neither, a clear message and 360 ERP isn't called. (Employee-ID logins have no email,
so 360 ERP answered "The email field is required.")

- `scripts/erp360-sso-email-api.mjs` (server started with `ERP360_BASE_URL=http://127.0.0.1:3299`, a fake 360 ERP in the
  script): **3/3** — login with no email → the Employee's office email is sent; a login email set after sign-in → that one
  (not the token's); no email anywhere → "no email address … ask HR" (400) and 360 ERP not called.
