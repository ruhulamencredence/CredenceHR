# পরিকল্পনা: Head of Department আর এক Department-এ একাধিক Supervisor

অবস্থা: **প্রস্তাব** (মকআপ দেখে সিদ্ধান্ত হলে কাজ শুরু)। তারিখ: 2026-11-11।

## এখন কী আছে

- প্রতিটা Department-এ **একজন** "Supervisor" (`departments.supervisor_user_id`), আর একটা সুইচ "Include Supervisor in Approval Workflow (first layer)" (`include_supervisor_approval`)।
- Approval: কর্মীর নিজের **Direct Supervisor** (Employees → Edit → Supervisor, `employee_supervisors.is_direct`) থাকলে তিনি layer 1; না থাকলে Department-এর Supervisor (`resolveDepartmentSupervisor`, server.ts); তারপর Template-এর layer-গুলো।
- একই ঘর "department head" হিসেবেও ব্যবহার হয়: Tasks (`TaskRoutes.ts`), Targets (`TargetRoutes.ts`), Module Access-এ department-ভিত্তিক অনুমতির প্রথম টিক (`ModuleAccessPage.tsx`), HR Ops-এ "Reports to" না থাকলে department-এর জন (`HROperationsRoutes.ts`), Users-এর department picker।
- আলাদা করে "Head of Department" বলে কিছু নেই।

## কী চাই

1. **Head of Department** — প্রতি Department-এ একজন, Supervisor থেকে আলাদা।
2. **একাধিক Supervisor** — এক Department-এ দুই বা তার বেশি Supervisor।

## ডাটা

- `departments.head_user_id` (INT NULL) — Head of Department।
- `departments.include_head_approval` (TINYINT, default 0) — Head কি Supervisor-এর পরে approve করবেন।
- নতুন টেবিল `department_supervisors` (`id, department_id, user_id, sort_order, created_at`, UNIQUE(department_id, user_id))।
- Migration (একবার): প্রতিটা Department-এর এখনকার `supervisor_user_id` → `department_supervisors`-এর প্রথম সারি। পুরনো ঘর কিছুদিন রাখা হবে (প্রথম Supervisor-এর সাথে মিলিয়ে), যাতে পুরনো কোড / report না ভাঙে; সব জায়গা নতুন টেবিলে গেলে সরানো হবে।
- `tools/db/groups.json`-এ নতুন টেবিল Departments গ্রুপে।

## Approval কীভাবে চলবে (প্রস্তাব)

কর্মী অনুরোধ দিলে:
1. **Supervisor ধাপ** — কর্মীর নিজের Direct Supervisor থাকলে শুধু তিনি (আগের মতো)। না থাকলে Department-এর **যেকোনো একজন Supervisor** approve করলেই হবে (সবাই notification পান; একজন করলে বাকিদের তালিকা থেকে সরে যায়)। কর্মী নিজেই Supervisor হলে নিজের অনুরোধে তিনি বাদ — বাকি Supervisor-রা approve করেন; আর কেউ না থাকলে অনুরোধ Head-এর কাছে যায়।
   একই মানুষ Supervisor আর Head দুটোই হলে একবারই approve করেন। Supervisor বা Head কেউ না থাকলে সরাসরি Template (আজকের মতো)।
2. **Head ধাপ** (সুইচ চালু থাকলে) — Head of Department। Head নিজেই অনুরোধকারী বা আগের ধাপের approver হলে ধাপটা বাদ।
3. তারপর Template-এর layer-গুলো, আগের মতো।

`getCurrentStepApprovers` এক ধাপে একাধিক approver আগে থেকেই সামলায় (Template layer-এ), তাই "যেকোনো একজন" নতুন কিছু নয়।

## অন্য জায়গায় কী বদলাবে

| জায়গা | এখন | পরে |
|---|---|---|
| Admin Panel → Departments | Supervisor একটা picker | Head of Department (একটা picker) + Supervisors (একাধিক, chip + "Add supervisor"), দুটো সুইচ |
| তালিকা | Supervisor কলাম | Head কলাম, Supervisors কলাম (chip, বেশি হলে "+2"), Approval কলামে পুরো ধারা |
| Employees → Edit → Supervisor | যেকোনো কর্মী | আগের মতো; তালিকার উপরে এই Department-এর Supervisor-রা সাজেশন হিসেবে |
| Tasks / Targets ("department head") | `supervisor_user_id` | Head **এবং** সব Supervisor |
| Module Access — department অনুমতির প্রথম টিক | Supervisor হলে নিজের Department টিক | Head বা যেকোনো Supervisor হলে |
| HR Ops "Reports to" (নিজের Supervisor না থাকলে) | Department-এর Supervisor | Department-এর প্রথম Supervisor; Head আলাদা লাইনে |
| Assistant / Notification | — | "আপনি এখন X Department-এর Head / Supervisor" alert |

## অনুমতি (CLAUDE.md)

- Head ও Supervisor সেট করা = Departments module-এর এডিট (আগের মতো `departments` module + edit layer); API-তেও একই `requireModule` / layer।
- Head of Department হওয়া নিজে কোনো Admin module খোলে না — শুধু approval আর নিজের Department-এর Task / Target দেখা, আগের Supervisor-এর মতো।

## ধাপ

1. ডাটা + migration + API (`DepartmentsAndBranches.ts`), পুরনো ঘর মিলিয়ে রাখা।
2. Approval: `resolveDepartmentSupervisor` → একাধিক; Head ধাপ।
3. Departments পাতা (ডেস্কটপ + ফোনের sheet), picker সব `SearchSelect`।
4. Tasks, Targets, Module Access, HR Ops, Debug — নতুন টেবিল।
5. টেস্ট: দুই Supervisor-এর একজন approve → পরের ধাপ; Head চালু / বন্ধ; Supervisor নিজে অনুরোধ দিলে; Direct Supervisor থাকলে department-এর কেউ আসে না; পুরনো Department (migration) আগের মতো চলে।
6. Docs: 02 (approval ধারা), 04/05 (কে approve করতে পারে), groups.json।

## সিদ্ধান্ত লাগবে

1. একাধিক Supervisor হলে — **যেকোনো একজন** approve করলেই হবে (প্রস্তাব), নাকি **সবাইকে**?
2. Head of Department approval-এ থাকবেন — শুরুতে **বন্ধ** রেখে প্রতিটা Department-এ চালু করা যাবে (প্রস্তাব), নাকি সবসময়?
3. প্রত্যেক কর্মীকে নির্দিষ্ট একজন Supervisor-এ ভাগ করা লাগবে? এখনকার Direct Supervisor দিয়েই সেটা হয় — আলাদা কিছু না বানানোর প্রস্তাব।
