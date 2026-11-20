# Test log — 20 November 2026

## HR Operations → Service Book: more history, More activity, Login & Access

HR's Service Book only (My Service Book and the Service Book PDF are unchanged). Server: `UserAccessLog.ts` (one
middleware before the `/api/users/:id/...` routes: picture of the login before, picture after a 2xx answer, writes only
the difference to `user_access_log`; `logUserAccess` for the Transfer and HR Action block), `EmployeeActivityRoutes.ts`
(`/activity`, `/more`, `/access-log`), layer `hr_operations → p360_access` (explicit only). UI: `HrOpsActivity.tsx`.

- `scripts/service-book-activity-api.mjs`: **26/26**
  - New login → "Login created", tied to the Employee; Mobile App Off → On with who did it; Project Access given then taken
    away, by project name; a refused Block (no reason, 400) writes nothing; Block with reason and Unblock both written;
    password reset written as "Reset" and no hash anywhere in the log; Module Access and a Self Service switch written;
    saving with nothing changed writes nothing.
  - Timeline gets Login created, PEPM given / taken away, Login blocked, Password reset; Superadmin may see Login &
    Access; the access log lists every row with who and since when.
  - Older Users → Activity rows (`user_access_audit`) shown as "older record", project ids as names, nothing twice; an
    older block shows in the timeline.
  - More activity: all six boxes for the Superadmin; an anonymous grievance is never tied to the person.
  - The official service history (and its PDF) is the same before and after.
  - A plain account with HR Operations only: timeline yes, `can_access_log` false, access-log API 403, no More activity
    boxes; with "Service Book — Login & Access log" ticked it opens.
- `scripts/service-book-activity-ui.cjs`: **12/12** — Service Book (360°) → the Transfer test's employee: filters All /
  Service / Onboarding / PEPM & Check-in / Login, PEPM events in the timeline, PEPM & Check-in hides the service events;
  More activity boxes; Login & Access table with the Transfer row; phone width with no sideways scroll; no page errors.
- Transfer log: `transfer-access-api` (2026-11-19) re-run **18/18** and its effective date wrote `source = transfer` rows
  (PEPM + / −, Check-in ended / from, Department team).
- Re-run, nothing broken: user-delete-guard 7/7, add-user-rule 10/10, first-day 9/9, joiner-letter 24/24,
  project-names 13/13, entry-sharing 38/38.
