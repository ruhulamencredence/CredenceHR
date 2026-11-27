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

## Vehicles booked by time (not held from assign to the ride's end)

Server: `VehicleManagementRoutes.ts` — `rideWindow`, `bookingsOf`, `claimVehicle(vehicleId, ride, driverUserId)` (car +
driver overlap with `ride_gap_minutes`, 15 s in-process hold), `releaseVehicle` (syncs `on_ride` / `available`), Start Ride
sets `on_ride` and refuses while the car is on another ride, `/api/vehicles/available` + `/driver-picker` with bookings,
`/api/vehicles/day-board`. UI: `src/lib/vehicleSlots.ts`, `driverPicker.ts` (time-aware labels / sort / busy),
`VehicleDayBoard.tsx`, pickers in `ApproveApplications.tsx`, `PendingApprovalsCard.tsx`, `VehicleManagement.tsx`,
`VehicleManagementAdmin.tsx`, `RideTrip.tsx` (pick-up).

- `scripts/vehicle-slots-api.mjs`: **22/22** — gap setting (and range); ride A 10:00–13:00 gets V1 and V1 stays
  "available"; ride B at 13:15 refused on V1 (inside the gap, names ride A) and with driver 1, gets V2 + driver 2; ride C
  at 14:00 gets V1 + driver 1; 08:00–09:45 refused (gap 30) then fits with gap 0; maintenance car refused; available list /
  driver picker / day board carry the bookings; two overlapping rides given V2 at the same instant → only one; a ride 20
  min away gets V1, Start Ride → V1 "on_ride", another V1 ride can't start meanwhile, Completed → "available"; cancelling
  ride A frees its time.
- `scripts/vehicle-slots-ui.cjs`: **10/10** — Approve Application: for an 11:00 ride the car booked 10:00–13:00 shows
  "Busy 10:00–13:00" and can't be picked, the other "Free at this time"; the driver on the 10:00 ride is Busy; the ride is
  given the free car and driver; Vehicle Management: Day board shows both rides on their cars for that day, the Ride
  deadline text explains the gap; phone width with no sideways scroll; no page errors.
- Re-run: vehicle-start-reject-api 19/19, vehicle-start-reject-ui 12/12 (both now retire the cars they make).

