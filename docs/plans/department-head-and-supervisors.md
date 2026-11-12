# পরিকল্পনা: Head of Department আর টিম ধরে Supervisor

অবস্থা: **তৈরি** (2026-11-12)। সিদ্ধান্ত: Backup Supervisor নেই; Head-এর approval শুরু থেকেই সবসময় (সুইচ নেই); টিমে নেই এমন কর্মীর অনুরোধ Head → workflow। কীভাবে চলে: `docs/architecture/02-application-workflow.md` → "Department: Head of Department আর টিম ধরে Supervisor"। তারিখ: 2026-11-11।

## এখন কী আছে

- প্রতিটা Department-এ **একজন** "Supervisor" (`departments.supervisor_user_id`), আর একটা সুইচ "Include Supervisor in Approval Workflow (first layer)" (`include_supervisor_approval`)।
- Approval: কর্মীর নিজের **Direct Supervisor** (Employees → Edit → Supervisor, `employee_supervisors.is_direct`) থাকলে তিনি layer 1; না থাকলে Department-এর Supervisor (`resolveDepartmentSupervisor`, server.ts); তারপর Template-এর layer-গুলো।
- একই ঘর "department head" হিসেবেও ব্যবহার হয়: Tasks (`TaskRoutes.ts`), Targets (`TargetRoutes.ts`), Module Access-এ department-ভিত্তিক অনুমতির প্রথম টিক (`ModuleAccessPage.tsx`), HR Ops-এ "Reports to" না থাকলে department-এর জন (`HROperationsRoutes.ts`), Users-এর department picker।
- আলাদা করে "Head of Department" বা Department-এর ভেতরে টিম বলে কিছু নেই।

## কী চাই

1. **Head of Department** — প্রতি Department-এ একজন।
2. **টিম ধরে Supervisor** — এক Department-এ কয়েকটা টিম, প্রতিটা টিমের নিজের Supervisor আর নিজের সদস্য। **এক টিমের অনুরোধ অন্য টিমের Supervisor-এর কাছে যাবে না।**

## ডাটা

- `departments.head_user_id` (INT NULL) — Head of Department।
- `departments.include_head_approval` (TINYINT, default 0) — Head কি টিম Supervisor-এর পরে approve করবেন।
- নতুন টেবিল `department_teams` (`id, department_id, name, supervisor_user_id, backup_user_id NULL, is_active, created_at`)।
- নতুন টেবিল `department_team_members` (`team_id, employee_id`, UNIQUE(employee_id)) — **একজন কর্মী একটাই টিমে**।
- Migration (একবার): যে Department-এ এখন Supervisor আছেন, সেখানে একটা টিম "<Department> team" — Supervisor তিনি, সদস্য Department-এর সব কর্মী। তাই আজকের approval হুবহু একই থাকে। পুরনো `supervisor_user_id` কিছুদিন রাখা হবে (পুরনো কোড / report না ভাঙতে), সব জায়গা নতুনে গেলে সরানো হবে।
- কর্মী অন্য Department-এ transfer হলে আগের টিম থেকে নিজে বাদ পড়বেন (নতুন Department-এ টিম বেছে দিতে বলা হবে)।
- `tools/db/groups.json`-এ নতুন টেবিল দুটো Departments গ্রুপে।

## Approval কীভাবে চলবে

কর্মী অনুরোধ দিলে:
1. **Supervisor ধাপ**
   - কর্মীর নিজের Direct Supervisor থাকলে শুধু তিনি (আজকের মতো — একজনের জন্য বিশেষ ব্যবস্থা)।
   - না থাকলে **তাঁর নিজের টিমের Supervisor** — শুধু তিনি (তিনি অনুপস্থিত / blocked হলে টিমের Backup)। অন্য টিমের Supervisor কখনো নয়।
   - কর্মী কোনো টিমে নেই → এই ধাপ নেই; Head সেট থাকলে Head, না হলে সরাসরি workflow।
   - Supervisor নিজে অনুরোধ দিলে → তাঁর Backup; Backup না থাকলে Head; Head-ও না থাকলে workflow।
2. **Head ধাপ** (সুইচ চালু থাকলে) — Head of Department। Head নিজেই অনুরোধকারী বা আগের ধাপের approver হলে বাদ।
3. তারপর Template-এর layer-গুলো, আগের মতো।

## অন্য জায়গায় কী বদলাবে

| জায়গা | এখন | পরে |
|---|---|---|
| Admin Panel → Departments | Supervisor একটা picker | Head of Department picker, নিচে **Teams**: প্রতিটা টিমের নাম, Supervisor, Backup, সদস্য (খুঁজে যোগ / বাদ) |
| তালিকা | Supervisor কলাম | Head কলাম, Teams কলাম (টিম · Supervisor · কতজন), "টিমে নেই: n জন" সতর্কতা |
| Employees → Edit | Supervisor tab | Department-এর পাশে **Team** বাছাই; Direct Supervisor আগের মতো |
| Team Attendance / Tasks / Targets | Department Supervisor | টিম Supervisor নিজের টিম দেখেন; Head পুরো Department |
| Module Access — department অনুমতির প্রথম টিক | Supervisor হলে নিজের Department | Head বা কোনো টিমের Supervisor হলে |
| HR Ops "Reports to" (নিজের Supervisor না থাকলে) | Department-এর Supervisor | নিজের টিমের Supervisor |
| Notification | — | "আপনি এখন X টিমের Supervisor / X Department-এর Head" |

## অনুমতি (CLAUDE.md)

- Head, টিম আর সদস্য ঠিক করা = Departments module-এর এডিট (`departments` module + edit layer); API-তেও একই `requireModule` / layer।
- Head বা টিম Supervisor হওয়া নিজে কোনো Admin module খোলে না — শুধু approval আর নিজের টিম / Department-এর Task, Target, Team Attendance।
- Picker সব `SearchSelect` (নাম · Employee ID · পদ · Department)।

## ধাপ

1. ডাটা + migration + API (`DepartmentsAndBranches.ts`)।
2. Approval: `resolveDepartmentSupervisor` → টিমের Supervisor / Backup; Head ধাপ।
3. Departments পাতা (ডেস্কটপ + ফোনের sheet), Employees → Edit-এ Team।
4. Tasks, Targets, Team Attendance, Module Access, HR Ops, Debug — নতুন টেবিল।
5. টেস্ট: টিম A-র কর্মীর অনুরোধ শুধু A-র Supervisor পান (B-র Supervisor-এর তালিকায় আসে না, API দিয়েও approve করতে পারেন না — 403); Backup; Head চালু / বন্ধ; Supervisor-এর নিজের অনুরোধ; টিমে নেই এমন কর্মী; Direct Supervisor থাকলে টিম আসে না; migration-এর পর পুরনো Department আগের মতো।
6. Docs: 02 (approval ধারা), 04/05 (কে approve করতে পারে), groups.json।

## সিদ্ধান্ত লাগবে

1. প্রতিটা টিমে একজন **Backup Supervisor** রাখার সুযোগ থাকবে (প্রস্তাব: হ্যাঁ, ঐচ্ছিক)?
2. Head-এর approval শুরুতে **বন্ধ**, প্রতিটা Department-এ চালু করা যাবে (প্রস্তাব) — নাকি সবসময়?
3. টিমে নেই এমন কর্মীর অনুরোধ Head-এর কাছে যাবে (প্রস্তাব), নাকি সরাসরি workflow-এ?
