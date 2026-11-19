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

## Appointment Letter at Hire (New Joiner Onboarding)

HR issues the Appointment Letter for a joiner as soon as they are hired — before they are an Employee — from HR Operations →
Onboarding → New Joiners (`JoinerLetterPopup.tsx`): salary, probation, date → filled from the Appointment Letter template →
edit → issue. The joiner reads it in My Onboarding, signs it and uploads the signed copy (required once the letter exists);
on approval the letter moves onto the new Employee, acknowledged.

- `scripts/joiner-letter-api.mjs`: **24/24** — open a joiner; no letter yet; preview fills name / designation / 55,000 /
  3 months with an APT ref; before the letter nothing to sign is required; issue (HR's edit kept), a second one → 409;
  stored with onboarding_id and no Employee; joiner alerted; My Onboarding shows it with the company block; now the
  signed copy is required; Letters register lists it "(joiner)"; cancel → gone for the joiner; issue again; plain user →
  403 (prepare and read); joiner uploads + submits; HR review sees letter and signed copy; approve → reports the letter
  already issued; letter now the Employee's and acknowledged; the cancelled one kept with the Employee; signed copy in the
  Employee's documents.
- `scripts/joiner-letter-ui.cjs`: **10/10** — joiner row → "Issue appointment letter" → popup asks for the gross salary,
  prepares the letter (name, 55,000), issues it; confirmation and the ref on the row; phone My Onboarding shows "Your
  Appointment Letter" with "Signed copy not uploaded yet"; open the PDF; no page errors.

## First day steps in the Onboarding Checklist

Three new checklist items (PEPM projects given, Mobile App turned on, Added to their department team) that tick
themselves, plus "Signed copy of Appointment Letter received" now ticks itself when the letter is acknowledged. Pending
items get a button (`FirstDayActions.tsx`): Give projects (the Project Access popup), Turn on Mobile App, Give a SIM,
ID card requests, Department teams — each only for an account allowed to do it.

- `scripts/first-day-api.mjs`: **9/9** — the items exist on an approved joiner's checklist; first-day says no projects /
  app off; Superadmin may do every step; Give projects and Turn on Mobile App save through their own APIs; both items then
  tick themselves (with the project name); a plain user → 403.
- `scripts/first-day-ui.cjs`: **6/6** — Checklist → Open Checklist: "Give projects" and "Turn on Mobile App" shown;
  turning the app on shows the message; Give projects opens the Project Access popup, saving shows the message and the
  item ticks (button gone); no page errors.
- Not covered by a test: the department team item ticking (no team in the test data) — same lookup as the
  Department teams feature.

## Users → Add New User: a login is an Employee's (or a non-employee with a reason)

- `scripts/add-user-rule-api.mjs`: **10/10** — no employee and no reason → 400 pointing to Onboarding; a too-short reason
  → 400; a non-employee login with a reason is made and the reason kept; employees-without-login lists the record with ID,
  designation, department; a login for that employee takes its name, Login ID = Employee ID, links it, signs in; no longer
  listed; a second login for the same employee → 400; a plain user can't list them (403).
- `scripts/add-user-rule-ui.cjs`: **6/6** — "Login for" choice, the new-joiner hint, typing the Employee ID finds the
  employee and fills the name, Create User links the login, "Not an employee" asks who it is, no page errors.
- QA scripts that create test logins through `POST /api/users` now send `non_employee_reason: 'QA test account'`
  (docs/test-logs/2026-10-25/scripts and others).
