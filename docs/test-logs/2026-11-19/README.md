# Test log — 19 November 2026

## PEPM Entry sharing (Team / Own entries only / By home project)

Each Project has an Entry sharing (Admin Panel → Projects → Edit): Team (default, everyone on the Project shares every
entry, as before), Own entries only, or By home project — each entry is For one of its maker's own Projects and only
that Project's team (and the maker) sees it; e.g. Central Inventory, which everyone is given. Teams are made where they
always were: Users → a user → Access → Projects (Budget / Jobs / MPR), whose popup now lists the ticked Projects first,
with the rest of each team and what the person will see there. Server: `PepmTeam.ts` (`teamScopeSql`, `onTeam`, share
keys on `budget_project_locks`), `EntriesRoutes.ts`, `BudgetImportRoutes.ts`, `ProjectRoutes.ts`.

- `scripts/entry-sharing-api.mjs`: **38/38** — QA Anamika (Rahim, Karim), QA Rupayan (Suman, Jamil), QA Central
  Inventory (all of them + Nasima, no other project).
  - Team: Suman sees Rahim's Central Inventory entry (as before).
  - Switching to By home project fills For of old entries from the maker's only project; an unknown value → 400.
  - for-options; Karim's entry gets For Anamika by itself; Jamil can't enter For Anamika (400); Nasima's entry has no For.
  - Rahim sees Anamika's two, not Rupayan's or Nasima's; Suman only Rupayan's; Nasima only her own; Reports sees all four with For names.
  - Suman can't edit (403) or delete (403) other teams' entries; Karim can edit Rahim's.
  - Rupayan can't reuse Anamika's MPR No; Anamika can. Suman can't add a row to Anamika's Job (403); Karim's added row is For Anamika.
  - Rahim's Final Submit locks `f:Anamika` and his own share only; Karim can't add, Jamil still can; lock flags per team.
  - Own entries only: Karim sees only his rows.
  - Nasima on two projects must choose For; her For-Rupayan entry is Rupayan's only; for-gaps lists her old entry; for-fill sets it For Anamika; plain user → 403 on for-gaps and on changing Entry sharing.
  - Transfer: Karim moved to Rupayan keeps his own rows, loses Rahim's, gains Rupayan's; Rahim still sees Karim's old Anamika row.
- `scripts/entry-sharing-ui.cjs`: **20/20** — Edit project → Entry sharing radio, save as By home project with the count of
  filled entries, "Old entries with no For" list → pick QA Rupayan → Set For (saved), list chip; Users → Access → Project
  Access popup: "Given · 2" first, "Team: QA nasima", "Sees the entries made for QA Anamika", chip, unticking changes the
  line, Cancel saves nothing; phone entry form: "For (your project)" offers Nasima's two projects; no page errors.
