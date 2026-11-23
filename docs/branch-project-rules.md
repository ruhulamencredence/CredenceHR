# প্রজেক্ট ও Branch: যে নিয়মগুলো ভাঙা যাবে না

> **অবস্থা (২৩ নভেম্বর):** বানানো হয়েছে। প্রজেক্ট **এডিটে** Branch ও Branch Type (নতুন প্রজেক্ট যোগ করার সময় নয়, তৈরির পর এডিটে), প্রজেক্ট তালিকায় ফিল্টার ট্যাব, Branch ফর্মের প্রজেক্ট বাছাইয়ে "linked to … (ধরন)" / "free" / "this Branch", সব জায়গায় "Project Side" নাম। API: `PUT /api/projects/:id` (ঐচ্ছিক `branch_type`, `branch_link`), `GET /api/projects/:id/branch-impact`।

> কেন এই ফাইল: Projects পাতায় Branch-এর ধরন (Head Office / Project Side) বাছার সুবিধা আর Branch ফর্মে প্রজেক্ট বাছাই সহজ করার কাজ আসছে (মকআপ অনুমোদনের পর)। সেই কাজ করতে গিয়ে নিচের চলতি নিয়মগুলো যেন নষ্ট না হয়, তাই কোড পড়ে এগুলো লিখে রাখা হলো। কাজটা করার আগে ও পরে এই তালিকা মিলিয়ে দেখতে হবে।
> ভিত্তি: `DepartmentsAndBranches.ts`, `ProjectRoutes.ts`, `src/components/AdminPanel.tsx`।

## ১. ডেটার গড়ন

| বিষয় | আজকের নিয়ম | কোথায় |
|---|---|---|
| দুটো আলাদা টেবিল | `projects` আর `branches`। Attendance, Jobs, PEPM প্রজেক্টের নিজের `id` ধরে চলে, তাই টেবিল জোড়া লাগানো যাবে না | `DepartmentsAndBranches.ts` |
| সংযোগ | `branches.project_id` (UNIQUE)। **এক প্রজেক্টে এক Branch**, এক Branch-এ এক প্রজেক্ট | `unique_branch_project` |
| Branch-এর ধরন | `branches.branch_type` = `head_office` বা `project_site`। এটাই **Holiday Calendar Group** | `parseBranchType` |
| ধরনের ডিফল্ট | API-তে `branch_type` না পাঠালে `head_office`; ডেটাবেস কলামের ডিফল্ট `project_site`। **দুটো মেলে না**, তাই নতুন কোডকে সবসময় ধরন স্পষ্ট করে পাঠাতে হবে | `parseBranchType`, `schemaMigrations.ts` |

## ২. ধরন যা যা চালায় (বদলালে এগুলোও বদলায়)
- কর্মীর Weekend / Holiday ক্যালেন্ডার: `all_employees.branch_id → branches.branch_type` (`getEmployeeBranchTypeMap`, `holidayRoutes.ts`)।
- Employees-এর Branch ফিল্টার (`EmployeeFilters.ts`), Attendance (`AttendanceRoutes.ts`), Payroll (`PayrollRoutes.ts`), Employee রুট (`EmployeeRoutes.ts`)।
- Transfer: Head Office-এর Branch PEPM প্রজেক্ট দেয় না, Project Side দেয়।
- তাই ধরন বদলানো মানে অনেক কর্মীর ছুটির হিসাব বদলানো। কাজেই `confirmDialog` লাগবে (কতজন কর্মী প্রভাবিত তা লিখে), আর তৈরি হয়ে যাওয়া payroll নিজে নতুন করে হিসাব হয় না, সেটা জানাতে হবে।

## ৩. নাম ও লোকেশন মেলানো (এক জায়গায় বদল অন্যটায় যায়)
1. **Branch-এর নাম বদলালে:** যুক্ত প্রজেক্টের নাম শুধু তখনই বদলায় যখন দুটোর নাম এতদিন এক ছিল (`nameFollows`)। এবং এই কপিগুলোও নতুন নাম পায়: `all_employees.branch`, `department_team_auto.branch`, `zk_devices.branch`, `mobile_sims.duty_location`।
2. **প্রজেক্টের নাম বদলালে:** `budget_items.project_name` (নামে মেলানো) বদলায়; যুক্ত Branch-ও বদলায় যদি আগে দুটোর নাম এক থাকে। অন্য Branch ওই নাম আগেই নিলে Branch নিজের নামে থাকে।
3. **লোকেশন পিন (lat, lng, label, radius):** প্রজেক্ট সেভ করলে যুক্ত Branch-এর পিনও ওই মানই হয়। Branch-এর নিজের পিন না থাকলে সে প্রজেক্টের পিন নেয়। যুক্ত করলে আগের Attendance সাইট মুছে যায় না।
4. নাম মিলের তুলনা ছোট-বড় হাত ও দুই পাশের ফাঁকা বাদ দিয়ে।

## ৪. সংযোগের নিয়ম (`planProjectLink`)
- `project_link`: `auto` (একই নামের প্রজেক্ট যুক্ত করো বা বানাও), `none` (যুক্ত নয়), বা প্রজেক্টের id। সম্পাদনায় না পাঠালে **আগেরটাই থাকে**।
- অন্য Branch-এ যুক্ত প্রজেক্ট বাছলে ত্রুটি: `That Project is already linked to Branch "…"`।
- নতুন প্রজেক্ট বানানো, যুক্ত করা বা বদলানোর জন্য **Projects → Edit/Add** অনুমতি লাগে; না থাকলে `auto` শুধু যুক্ত না করে রেখে দেয়, আর স্পষ্ট বদল 403 দেয়।

## ৫. অনুমতি (UI ও API দুটোতেই)
| কাজ | লাগে |
|---|---|
| Branch তৈরি / বদল / মোছা | মডিউল `branches` |
| প্রজেক্ট তৈরি / বদল | মডিউল `projects` + লেয়ার `edit_add` |
| প্রজেক্ট মোছা | মডিউল `projects` + লেয়ার `delete_trash` |
| Branch ফর্মে প্রজেক্ট যুক্ত করা | উপরেরটার সাথে `projects` → `edit_add` |
| **নতুন:** প্রজেক্ট এডিটে Branch-এর ধরন বা Branch বদল | মডিউল `branches` ও `projects` → `edit_add` দুটোই। যার `branches` নেই, সে UI-তে অংশটা দেখবে না, আর বডিতে `branch_type` / `branch_link` পাঠালেও API 403 দেবে |
- Superadmin সব পায়। `user_project_permissions` (কে কোন প্রজেক্টে Check In করতে পারে) এই কাজে অপরিবর্তিত।

## ৬. নতুন কাজটা যেভাবে বানাতে হবে
1. `PUT /api/projects/:id` নতুন ঐচ্ছিক `branch_type` ও `branch_link` নেবে। **না পাঠালে আজকের আচরণ হুবহু একই** (`keep`)।
2. যুক্তি নতুন করে লেখা চলবে না: `planProjectLink` / `applyProjectLink` ও ধরন-বদলের অংশ এক সাধারণ ফাংশনে এনে Branch রুট আর Project রুট দুটোই সেটা ডাকবে, যাতে নিয়ম এক জায়গায় থাকে।
3. **আগে পুরোটা যাচাই, তারপর লেখা** (`planBranchChange`): কোনো ত্রুটি থাকলে কিছুই লেখা হয় না। (transaction নয়, কারণ কোম্পানি-ভিত্তিক আলাদা রাখার ফিল্টার `queryDB`-তে বসানো, transaction-এর কাঁচা সংযোগে নেই।)
4. Branch না থাকা প্রজেক্ট: `branch_link = auto` মানে প্রজেক্টের নামে Branch বানানো (ধরন স্পষ্ট দিয়ে)।
5. Projects পাতার ট্যাব (All / Head Office / Project Side / No Branch) শুধু ফিল্টার; কোনো ডেটা বদলায় না।
6. **নামকরণ এক করতে হবে:** Projects তালিকায় ব্যাজ "Project Side", Branches তালিকা ও Employees-এ "Project", Branch ফর্মে "Project Site"। সব জায়গায় একই শব্দ ("Project Side") হবে। ডেটাবেসের মান (`project_site`) বদলাবে না।
7. Branch ফর্মের প্রজেক্ট বাছাই `SearchSelect`-ই থাকবে (টাইপ করে খোঁজা), প্রতিটা সারিতে ধরনের ব্যাজ আর "linked to …" বা "free"। এখন যে আগে-যুক্ত সারি বাছাই করা যায় না, সেটা আগের মতোই থাকবে।
8. পপআপ বা নিশ্চিতকরণ হবে `confirmDialog` (liquid-glass), `window.confirm` নয়।
9. `docs/architecture/02-application-workflow.md`, `04-security.md` ও `05-security-questions-and-answers.md` একই কমিটে হালনাগাদ হবে।

## ৭. কাজ শেষে যা মিলিয়ে দেখতে হবে (পুনঃপরীক্ষা তালিকা)
- [ ] প্রজেক্ট এডিটে নতুন ঘর না ছুঁয়ে সেভ করলে Branch-এর নাম, ধরন ও পিন আগের মতোই।
- [ ] প্রজেক্টের নাম বদলালে মেলা-নামের Branch ও `budget_items` সাথে বদলায়; মিল না থাকলে Branch নিজের নামে থাকে।
- [ ] Branch-এর নাম বদলালে চার জায়গার কপি (কর্মী, Team নিয়ম, মেশিন, SIM) বদলায়।
- [ ] ধরন Head Office ↔ Project Side করলে সংশ্লিষ্ট কর্মীর ক্যালেন্ডার ও Employees ফিল্টার বদলায়, আর `confirmDialog` কত জনের তা বলে।
- [ ] অন্য Branch-এ যুক্ত প্রজেক্ট বাছলে ত্রুটি আসে।
- [ ] `branches` মডিউল ছাড়া একাউন্টে নতুন অংশ দেখা যায় না, আর API-তে 403 আসে। `projects` → `edit_add` ছাড়া সেভই হয় না।
- [ ] নতুন Branch (ধরন স্পষ্ট দিয়ে) ঠিক ধরনে তৈরি হয়; ডিফল্ট-অমিল ফাঁদে পড়ে না।
- [ ] Employees ফর্মে Branch-এর পাশের ব্যাজ, Attendance, Payroll পাতা আগের মতো খোলে।
- [ ] `npm run docs:check` ত্রুটিহীন।
