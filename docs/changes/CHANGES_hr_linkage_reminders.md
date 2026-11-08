# HR Linkage + Reminders — What Was Added

HR-কে আগে একই তথ্য কয়েক জায়গায় হাতে লিখতে হতো:
- Recruitment থেকে Onboarding-এ
- Onboarding থেকে Appointment Letter-এ
- Exit-এর সময় কার কাছে কী বাকি, সেটা আলাদা আলাদা module ঘুরে খুঁজতে হতো

Probation, contract, document-এর মেয়াদ শুধু Dashboard-এ দেখা যেত।

এই কাজে দুটো জিনিস হয়েছে:
- **(১)** এই module-গুলো একটার সাথে আরেকটা জোড়া লাগানো।
- **(২)** এই তারিখগুলোর আগে আপনা থেকে alert আর push যায়।

---

## কোথায় কী

| জায়গা | কী আছে |
|---|---|
| Admin Panel → HR Advanced → **Recruitment (ATS)** | Hired candidate-এর পাশে onboarding-এর অবস্থা (`ONB-0001 → CHL-1025`), আর **Start onboarding** বোতাম |
| HR Operations → Onboarding → New Joiners | "From Recruitment: <posting>" লেখা; approve-এর পর **Issue Appointment Letter**; letter না দেওয়া থাকলে "Appointment letter: not issued" |
| Admin Panel → HR Advanced → **Exit / Offboarding** | প্রতিটা exit-এ **Dues from other modules** card; বকেয়া থাকলে "Paid" আটকানো |
| HR Operations → **Dashboard** | **Coming up — next 60 days**: সব তারিখ এক তালিকায়, পাশে Confirm / Extend / Renew / Retire / Increment |
| HR Operations → Settings → Company & Letter No. → **Reminders** | চালু/বন্ধ, কোন ধরন, কত দিন আগে, retirement বয়স, supervisor-কে জানানো |
| Alerts (bell) | `hr_reminder` alert চাপলে HR Operations → Dashboard খোলে |

## ১. Recruitment ↔ Onboarding

- **Start onboarding:** Hired candidate-এর পাশের বোতাম New joiner ফর্ম খোলে, candidate আগে থেকে বেছে রাখা।
  - নাম, email আর phone আসে candidate থেকে।
  - designation আর department আসে job posting থেকে, যদি HR খালি রাখে।
  - department নাম Departments-এর নামের সাথে হুবহু মিললে (বড়-ছোট হাতের অক্ষর বাদে) তবেই বসে।
- **Status বদলানো আটকানো:**
  - onboarding খোলা থাকলে (draft / submitted / sent back) candidate-কে Hired থেকে সরানো যায় না।
  - approve হয়ে গেলেও সরানো যায় না।
  - cancel বা expire হলে আবার সরানো যায়, আর "Start onboarding" ফিরে আসে।
- **Approve হলে:** candidate-এ তৈরি হওয়া Employee যুক্ত হয় (`job_candidates.employee_id`)।

## ২. Onboarding → Appointment Letter

- **Letter issue করা:**
  - Approve-এর পর review drawer-এ **Issue Appointment Letter** বোতাম আসে।
  - চাপলে Letters-এর composer খোলে, নতুন Employee আর Appointment type আগে থেকে বসানো।
  - HR পড়ে বা বদলে Issue করে। letter আপনা থেকে যায় না।
- **Issue হলে:**
  - ref no দেখায়।
  - checklist-এর "Appointment Letter issued" আগের মতোই নিজে থেকে টিক হয়।
- **Template না থাকলে:** Settings → Letter Templates-এ যোগ করতে বলে।
- **Bug fix:** approve হওয়া আবেদনের drawer-এ Employee ID দেখাচ্ছিল না, এখন দেখায়।

## ৩. Exit → অন্য module-এর বকেয়া

Exit খুললে **Dues from other modules** card দেখায়। প্রতিটা ভাগের পাশে সেই module খোলার লিংক থাকে।

| কী | Paid আটকায়? |
|---|---|
| ফেরত না দেওয়া asset (`asset_assignments`) | হ্যাঁ |
| চালু SIM (`mobile_sims`) | হ্যাঁ |
| loan / advance-এর বাকি (`employee_advances`) | হ্যাঁ, যতক্ষণ Settlement-এ যোগ হয়নি |
| pending loan / advance request | না, শুধু তথ্য |
| pending claim, টাকা না দেওয়া conveyance bill | না, শুধু তথ্য |
| চলমান vehicle requisition | না, শুধু তথ্য |

- **Add to settlement:**
  - টিক দেওয়া loan/advance-এর বাকি টাকা Outstanding Dues-এ যোগ হয়, Net Payable আবার হিসাব হয়।
  - একই loan দুবার যোগ হয় না।
  - কী যোগ হয়েছে তা থাকে `final_settlements.dues_json`-এ।
- **Paid / Settled আটকানো:**
  - বকেয়া থাকলে "Mark Paid & Settle" বা exit-কে সরাসরি "settled" করা যায় না। 409 আসে, আর liquid-glass পপআপে তালিকা দেখায়।
  - এটা নিয়ম, permission নয়, তাই সবার ওপর খাটে।
- **Clearance alert:** IT/Admin approver-দের alert-এ asset আর SIM লেখা থাকে। Finance-এর alert-এ loan আর claim লেখা থাকে।
- **Net Payable ঋণাত্মক:** loan পাওনার চেয়ে বেশি হলে Net Payable ঋণাত্মক হতে পারে। আগের মতোই আটকানো হয় না।

## ৪. আপনা থেকে reminder

| ধরন | তারিখ কোথা থেকে |
|---|---|
| Probation শেষ | `hr_employee_service.probation_end_date` (confirm হয়ে গেলে বাদ) |
| Contract শেষ | `hr_employee_service.contract_end_date` |
| Document-এর মেয়াদ | `employee_documents.expiry_date` |
| Retirement | জন্মতারিখ + retirement বয়স (ডিফল্ট ৬০) |
| Increment due | চালু increment policy (`computeIncrementsDue`, Increments পেজের হিসাবও এটাই) |

- **কখন যায়:**
  - ডিফল্ট ৩০, ১৫, ৭ দিন আগে, আর যেদিন শেষ বা মেয়াদ পেরোলে। Settings থেকে বদলানো যায়।
  - প্রতিটা ধাপ একজনের কাছে একবারই যায়। কী গেছে তা মনে রাখে `hr_reminder_log`।
  - প্রথমবার দেরিতে চললে শুধু সবচেয়ে কাছের ধাপটা যায়, পুরনো সব ধাপ একসাথে নয়।
  - ৩০ দিনের বেশি পুরনো তারিখের reminder যায় না।
- **কখন যায় না:** ওই তারিখের জন্য কোনো Action আগে থেকেই pending থাকলে (Confirmation, Probation Extension, Contract Renewal, Retirement, Increment) reminder যায় না।
- **কারা পায়:**
  - **Admin / User account**, যাদের HR Operations-এ **"Reminders — receive & view"** টিক দেওয়া।
  - কর্মীর direct supervisor, যদি Settings-এ চালু থাকে।
  - **Superadmin alert পায় না।** Module Access-এ Superadmin-কে layer দেওয়া যায় না। তবে Dashboard-এর তালিকা Superadmin দেখতে পায়।
- **কীভাবে যায়:** একজনের একাধিক reminder একটা alert-এ জোড়া লাগে, সাথে push যায়।
- **কখন চলে:** সার্ভার চালুর ২ মিনিট পরে, তারপর ঘণ্টায় একবার। প্রতিটা company-র জন্য আলাদা করে, সেই company-র Settings আর কর্মী দিয়ে (`contextForCompany`)।
- **Dashboard থেকে পরের কাজ:** বোতাম চাপলে Personnel Action ফর্ম খোলে, কর্মী, action type আর effective date আগে থেকে বসানো।

## Permission (CLAUDE.md অনুযায়ী)

| Layer | Module | কী খোলে |
|---|---|---|
| `onboarding_create` / `_review` / `_approve` (আগের) | HR Operations | Recruitment-এর chip দেখতে যেকোনোটা লাগে। "Start onboarding" বোতামে লাগে `onboarding_create`। |
| **`exit_dues`** (নতুন, explicit-only) | Exit / Offboarding | Dues card, `GET /api/exit-requests/:id/dues`, `POST …/settlement/add-dues` |
| **`reminders_receive`** (নতুন, explicit-only) | HR Operations | Dashboard-এর "Coming up", `GET /api/hr-ops/reminders/upcoming`, reminder alert |

- **Exit-এর layer:** `exit_offboarding` এখন permission-layer module। layer সেভ না থাকলে ডিফল্ট শুধু `read`। পুরনো exit route আগের মতোই শুধু module দেখে, তাই এখনকার কারো কিছু বদলায়নি।
- **কী করতে হবে:** নতুন দুটো layer কাউকে আপনা থেকে দেওয়া হয় না। Users → Module Access-এ টিক দিতে হবে।

## ফাইল

- **নতুন:**
  - `HrRemindersRoutes.ts`
  - `src/components/HrRemindersCard.tsx`
  - `src/components/ExitDuesCard.tsx`
  - `tests/hr_linkage.test.ts`
- **বদলেছে:**
  - **Backend:** `OnboardingSelfServiceRoutes.ts`, `RecruitmentRoutes.ts`, `ExitOffboardingRoutes.ts`, `HROperationsRoutes.ts`, `server.ts`, `schemaMigrations.ts`, `Alerts.ts`
  - **Frontend:** `src/types.ts`, `RecruitmentPanel.tsx`, `HrOpsJoinerOnboarding.tsx`, `ExitOffboardingPanel.tsx`, `HrOpsDashboard.tsx`, `HROperationsPanel.tsx`, `HrOpsActions.tsx`, `HrOpsSettings.tsx`, `AlertsBell.tsx`, `AlertsPage.tsx`
- **DB (সার্ভার চালুর সময় নিজে থেকে তৈরি হয়, আলাদা migration লাগে না):**
  - `job_candidates.employee_id`
  - `final_settlements.dues_json`
  - নতুন টেবিল `hr_reminder_log`
  - `hr_ops_settings`-এ নতুন key: `reminders_enabled`, `reminder_lead_days`, `reminder_notify_supervisor`, `retirement_age`, `reminder_kinds`

## Test

```
npm run test:hr-linkage
```

- **Unit (সবসময় চলে):**
  - reminder-এর ধাপ
  - lead days পড়া
  - retirement-এর তারিখ (২৯ ফেব্রুয়ারি সহ)
  - reminder-এর ধরন
  - settlement-এ যোগ হওয়া dues-এর রেকর্ড
- **Integration (চালু সার্ভারে, শুধু test DB-তে):** settings `tests/onboarding.test.ts`-এর মতোই (`ONB_TEST_*`)।
  - Recruitment → Onboarding:
    - posting-এর designation বসে
    - status বদলানো আটকায়
    - approve-এ Employee যুক্ত হয়
    - Appointment letter-এর ref দেখায়
    - cancel-এর পরে status বদলানো যায়
  - Exit:
    - SIM আর loan থাকলে Paid আর Settled-এ 409
    - loan একবারই যোগ হয়
    - SIM সরানোর পর Paid হয়, Net Payable ঠিক থাকে
  - Reminder: সার্ভার `NODE_ENV=test` আর `ONB_TEST_SERVER_TEST_MODE=1` লাগে, সাথে `ONB_TEST_HR_EMAIL`।
    - ৪০ দিন আগে কিছু যায় না।
    - ৭ দিন আগে একবার যায়।
    - একই ধাপ আবার যায় না।
    - Confirmation pending থাকলে আর যায় না।
  - Permission: `ONB_TEST_HR_EMAIL` লাগে।
    - শুধু module থাকলে dues আর reminder-এ 403।
    - layer টিক দিলে খোলে।
    - test শেষে account-এর আগের Module Access ফিরিয়ে দেওয়া হয়।
- **Test hook:** `POST /api/hr-ops/reminders/run` (job এখনই চালানো, চাইলে অন্য তারিখ ধরে) শুধু `NODE_ENV=test`-এ কাজ করে। অন্য সব জায়গায় 404 দেয়।
- **ফলাফল:**
  - test সার্ভারে: ৩২টার ৩২টা পাস।
  - সার্ভার ছাড়া: ২৫টা পাস, ৭টা skip।

## সীমাবদ্ধতা / জানা বিষয়

- **বেতনের ঘর:** Approve-এর সময় বেতন ঠিক হয় না। তাই Appointment Letter-এ বেতনের জায়গা ফাঁকা ("BDT —") আসে। HR composer-এ লিখে দেয়, অথবা আগে salary বসায়।
- **Outstanding Dues হাতে কমালে:** যোগ করা loan তখনও "In settlement" দেখায়। HR-এর হাতের হিসাবকেই ঠিক ধরা হয়।
- **Supervisor-এর alert:** supervisor-এর HR Operations না থাকলে alert চাপলে কিছু খোলে না, শুধু তথ্য হিসেবে থাকে।
- **যাচাই করা যায়নি:**
  - আসল ফোনে push পৌঁছানো।
  - কয়েক দিন ধরে আসল সময়ে job চালানো। তারিখ বদলে চালিয়ে দেখা হয়েছে।
- **আগে থেকে থাকা সমস্যা (এই কাজে ছোঁয়া হয়নি):** Exit module-এ অন্য company-র কর্মীর exit id দিয়ে settlement খুললে একই settlement দ্বিতীয়বার তৈরির চেষ্টা হয়, ফলে 500 error আসে।
