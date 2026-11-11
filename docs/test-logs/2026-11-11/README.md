# 2026-11-11 — Data Import: re-linking a login only for ordinary accounts

`scripts/relink-probe.mjs` (dry-run imports against a test server on :3200,
Superadmin admin@credence.test; first add a `user` login `relink01`,
"Rahim Uddin", with no employee record):

| Row | Before the fix | After |
|---|---|---|
| relink01, "Md. Rahim Uddin" | linked (right) | linked |
| relink01, "Karim Hossain" | refused (right) | refused |
| Superadmin's Login ID, own name | **linked to the Superadmin login** | refused |
| an Admin's Login ID, own name | **linked to the Admin login** | refused |

2/4 before, 4/4 after. Fix: `DataImportRoutes.ts` only offers logins with
`role = 'user'` in the active group for re-linking.

# Admin Dashboard — pending attendance, approve several at once

Test server :3200 (Superadmin admin@credence.test; Admin roster.hr@credence.test
= approver of the one-step global chain; relink01 = Attendance + Admin
Dashboard modules, not an approver). Data made through the app's own APIs:
three test employees checked out off the chain (pending), two corrections
(workflow "timesheet — HR then Director", 2 layers).

| Check | Result |
|---|---|
| Per-row permission (`bulk-approve-flags.mjs`): Superadmin all; approver only the check-outs; module holder none | as expected |
| Non-approver calls `/api/my-approvals/:id/act` directly (`bulk-approve-direct-api.mjs`) | 403, nothing changed |
| Approver: Approval tile → popup, 3 tick boxes, Select all, Approve selected → "3 approved", list empty; Recon tile → same popup, no tick boxes (`bulk-approve-ui.mjs`) | 8/8 |
| Superadmin: 2 corrections → "1 approved, 1 passed to the next approver", then the last one → "1 approved" | 4/4, both corrections approved in the database |
| Correction outside the workflow: module holder may approve, decision endpoint approves (`bulk-approve-correction.mjs`) | 3/3 |

# Payroll — "See salary amounts" permission

Test server :3200. payB = Payroll before the change, no ticked layers (the
one-time grant gave it read, approval_sheet, month_compare, top_sheet,
salary_amounts); payC = Payroll after it, read + approval_sheet + top_sheet +
month_compare, no salary_amounts; Superadmin for comparison.

| Check | Result |
|---|---|
| Masking rules (`salary-amounts-mask-unit.ts`): money hidden, ids / days / counts / status kept, `late_deduction`, `leave_encashment` hidden | 21/21 keys |
| API (`salary-amounts-api.mjs`): payC sees ***** for amounts, the same people / months / ids; no salary-sized number from Superadmin's 11 Payroll answers appears in payC's; payC's changes 403; approval-access says salary_amounts / edit false | 10/10 |
| HR Ops reports (`salary-amounts-hrops.mjs`): Gross Salary column offered and filled for payB only | 4/4 |
| Screen (`salary-amounts-ui.mjs`): payC Dashboard and Payroll List (September) all *****, no ৳ figure, no edit buttons; payB real amounts | 9/9 |
| Full QA suite (`tests/qa/run-all.sh`) | all green after `qa-group-hr.mjs` ticks Payroll's layers incl. salary_amounts for its Group HR (in both companies) — before that GH-05..07 were refused with "needs See salary amounts", i.e. the new rule working |
