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

## Vehicle: Start Ride window, and no Reject without a reason

Server: `VehicleManagementRoutes.ts` (`start_early_minutes` in Ride settings, default 30; `too_early` answer with
`can_override`; `early_start_reason`), `server.ts` `performApprovalAction` (a ride request needs a reason to reject).
UI: `promptDialog` (src/lib/confirmDialog.tsx, same liquid-glass card with a text box), Start Ride in
`VehicleManagement.tsx` / `VehicleManagementAdmin.tsx`, Remarks hint + check in `ApproveApplications.tsx`,
`ApprovalManager.tsx`, `PendingApprovalsCard.tsx`.

- `scripts/vehicle-start-reject-api.mjs`: **19/19** — reject with no reason / only spaces refused and still pending, with a
  reason rejected, the Vehicle Maintainer Layer too, Approve needs nothing; Ride settings default 30, an older page keeps
  it, only the Superadmin, range checked; tomorrow's ride: the driver can't start it (not even with a reason), Vehicle
  Management is asked why and then starts it, reason + who kept, completed and car freed; a ride 20 min away: the driver
  starts it with no reason recorded; window 0: refused until the start time.
- `scripts/vehicle-start-reject-ui.cjs`: **12/12** — driver on a phone presses Start Ride a day early and is told when it
  opens (ride not started); Vehicle Management: "Start this ride early?" popup, Start now off until a reason is typed,
  started with the reason kept; Approve Application: Remarks says a reason is needed, Reject with none stopped with a
  message and still pending, with one rejected; no page errors.

