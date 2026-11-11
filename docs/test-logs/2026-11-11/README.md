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
