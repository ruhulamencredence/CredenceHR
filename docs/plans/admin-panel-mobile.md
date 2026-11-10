# Admin Panel: ফোনে Self Service-এর মতো — পরিকল্পনা ও তালিকা

অবস্থা: **পরিকল্পনা — mockup অনুমোদনের অপেক্ষায়। কোনো code বদলানো হয়নি।**
তারিখ: ৯ নভেম্বর ২০২৬।

## ১. সমস্যা (ফোনে ৩৯০ px চওড়ায় ৪৬টা module খুলে দেখা)

Self Service-এর পাতাগুলো ফোনে অ্যাপের মতো: সাদাটে header-এ গোল Back, মাঝে শিরোনাম, ডানে ⋮;
গোল chip-এর tab; Directory-ধাঁচের কার্ড (`SelfCard`)। Admin Panel-এর পাতাগুলো এখনো website-এর মতো:

| সমস্যা | কোথায় | কতগুলো module |
|---|---|---|
| Website-এর কমলা logo bar header + "Admin Panel / HRM / …" breadcrumb (Self Service-এর app header নেই) | সব | ৪৬ |
| পাতার ভেতর বড় সাদা বাক্স, তার ভেতরে আবার বাক্স — দুপাশে জায়গা নষ্ট | সব | ৪৬ |
| Table পাশে কাটা পড়ে (ভেতরে আড়াআড়ি scroll, শেষ column দেখা যায় না) | imports, reports, employees, departments, attendance, attendance_reports, office_attendance, recycle, approvals, bill_claim_policy, permanent_delete_log, hr_operations, mobile_bill, target_reports, mail_admin, duty_roster, devices, Payroll, Leave Manage | ১৯ |
| ছোট, ভাঙা sub-tab (দুই লাইনে ভাঙা লেখা, underline tab) | asset, vehicle, exit, office_attendance, reports, attendance_reports, mobile_bill, payroll… | ~২৫ |
| শুরুতে লম্বা ব্যাখ্যার অনুচ্ছেদ (অর্ধেক পর্দা জুড়ে) | approvals, attendance, active_users, vehicle, data_import, editlog, recycle… | ~৩০ |
| ছোট বোতাম / ঘর (৩২ px-এর কম, আঙুলে চাপা কঠিন) | holidays ১০৮টা, reports ৪২, users ৩৩, employees ৩০, bill_claim_policy ২৩ … | ৩৫ |
| ১১ px-এর ছোট লেখা | attendance_reports ১৩৭, dashboard ১০৬, duty_roster ৪০ … | ২৫ |
| তালিকার উপরে "Add …" ফর্ম সবসময় খোলা (তালিকা নিচে চলে যায়) | branches, projects, mprs, departments, users | ৫ |
| অনেক filter একসাথে খোলা (তালিকা পর্দার নিচে) | attendance, attendance_reports, bill_claim, disbursement, target_reports, feedback, reports | ~১২ |

পাতা পুরো পাশে সরে যায় (page overflow) — **কোথাও না** (০/৪৬)। JS error — ০।

## ২. নকশার নিয়ম (Self Service-এর মতো)

1. **App header:** ফোনে Admin পাতাতেও Self Service-এর header — গোল Back (এক ধাপ পেছনে), মাঝে module-এর নাম, ডানে ⋮ (Home, Alerts, Chat, Profile, Menu)। কমলা logo bar আর breadcrumb ফোনে লুকানো (`usePhoneHeaderTitle`, Self Service যেভাবে করে)।
2. **বাক্স ছাড়া পাতা:** বাইরের সাদা বাক্স ফোনে নেই; কার্ডগুলো পাতার ওপর সরাসরি, দুপাশে ১২–১৬ px।
3. **Tab = গোল chip-এর সারি,** আড়াআড়ি scroll (Self Service-এর "Pending / History"-এর মতো); লেখা এক লাইনে।
4. **ব্যাখ্যা ভাঁজ করা:** লম্বা অনুচ্ছেদের জায়গায় এক লাইন + "ⓘ More"; চাপলে খোলে। লেখা বদলাবে না।
5. **Table → কার্ড:** তালিকার প্রতিটা সারি একটা `SelfCard` — বাঁয়ে initials / icon, শিরোনাম (নাম), নিচে এক লাইন (ID · Department), chip-এ অবস্থা (Pending / Approved…), ডানে গোল action বোতাম; চাপলে বিস্তারিত। যেসব table আসলেই grid (Duty Roster, Monthly Attendance Report, Payroll sheet, Top Sheet, Holiday calendar) সেগুলো table-ই থাকবে, তবে প্রথম column (নাম) আটকে থাকবে আর বাকি আড়াআড়ি scroll — হাতে "← সরান →" ইঙ্গিত।
6. **Filter = এক বোতাম:** উপরে Search pill + "Filters (৩)" বোতাম; চাপলে নিচ থেকে liquid-glass sheet-এ সব filter, Apply।
7. **"Add …" ফর্ম = বোতাম:** তালিকার উপরে বা নিচে ভাসমান "+ Add …"; চাপলে sheet-এ সেই একই ফর্ম।
8. **মাপ:** বোতাম / ঘর অন্তত ৪০ px উঁচু, লেখা অন্তত ১২ px; প্রধান বোতাম পুরো চওড়া।
9. **Desktop হুবহু আগের মতো।** সব বদল শুধু ফোনে (≤ ৭৬৭ px, `useIsPhone`) — CSS-এ `md:` দিয়ে বা phone-only component দিয়ে।

## ৩. যাতে কিছু নষ্ট না হয় — নিয়ম

- **ডাটা, API, অনুমতি একটুও বদলাবে না।** শুধু দেখানোর ধরন। প্রতিটা বোতাম, filter, action ফোনেও থাকবে — কিছু লুকানো হবে না, শুধু জায়গা বদলাবে (sheet / ⋮ / কার্ডের বোতাম)।
- **Desktop ছবি মিলিয়ে দেখা:** কাজের আগে ৪৬টা module + Payroll-এর desktop (১৪৪০ px) পুরো-পাতার ছবি তোলা হয়েছে; প্রতিটা ধাপের পর আবার তুলে pixel মিলিয়ে দেখা হবে — একটা pixel-ও বদলালে কারণ খুঁজে ঠিক করা।
- **ফোনে প্রতিটা module:** আগে-পরে ছবি, JS error ০, পাতা পাশে সরে না, প্রতিটা বোতাম চাপা যায় (৪০ px)।
- **Action test:** ফোনে প্রতিটা module-এর মূল কাজ একবার করে দেখা (যেমন Approve, Add Department, Filter Apply, Export) — Playwright দিয়ে।
- QA suite (১৩টা), e2e-forms, pickers চালানো; ধাপে ধাপে commit, প্রতিটা ধাপ আলাদা যাতে দরকারে ফেরানো যায়।
- নতুন shared অংশ একবার বানিয়ে সব জায়গায় ব্যবহার: `PhoneAdminHeader`, `PhoneTabs`, `InfoCollapse`, `FilterSheet`, `AddSheet`, `PhoneCardList` (`SelfCard`-এর ওপর), `StickyFirstColumnTable`।

## ৪. ধাপ

| ধাপ | কী | module |
|---|---|---|
| ০ | shared অংশগুলো + desktop / phone baseline ছবি | — |
| ১ | App header, breadcrumb লুকানো, বাক্স ছাড়া পাতা, chip tab, ব্যাখ্যা ভাঁজ, মাপ — **সব module-এ একসাথে** (AdminPanel-এর wrapper থেকে) | ৪৬ + Payroll |
| ২ | Table → কার্ড, বেশি ব্যবহৃত আগে | Employees, Users, Approvals (Queue), Leave Applications, Remote Attendance, Bill Claim, Disbursement, Departments, Devices, Mail Admin, Mobile Bill, Target Reports, HR Operations, Recycle / Delete Log, Imports / Reports (PEPM), Bill Claim Policy, Office Attendance, Leave Manage, Payroll List |
| ৩ | Filter sheet, "Add" sheet | ধাপ ২-এর filter-ওয়ালা পাতা + Branches, Projects, MPR Nos, Departments, Users |
| ৪ | Grid table: নাম আটকে আড়াআড়ি scroll | Duty Roster, Monthly Attendance Report, Payroll sheet / Top Sheet, Holiday calendar, Admin Dashboard-এর ২টা table |
| ৫ | পুরো test, docs (02 workflow), commit | — |

## ৫. Module তালিকা (৪৬ + Payroll + Leave Manage)

`table` = ফোনে কাটা-পড়া table আছে; `tab` = sub-tab আছে; `form` = উপরে খোলা ফর্ম; `filter` = অনেক filter।

| # | Module (tab key) | ফাইল | ফোনে এখন | ধাপ |
|---|---|---|---|---|
| 1 | Admin Dashboard (`dashboard`) | AdminDashboard.tsx | tile ঠিক আছে; ২টা table; ছোট লেখা ১০৬ | ১, ৪ |
| 2 | Reports & Insights (`reports_insights`) | ReportsInsights.tsx | কার্ড ঠিক; category chip ঠিক | ১ |
| 3 | HR Data Import (`data_import`) | HrDataImport (AdminPanel) | লম্বা কার্ড-লেখা | ১ |
| 4 | Projects (`projects`) | AdminPanel.tsx | form উপরে, তালিকা নিচে | ১, ৩ |
| 5 | Branches (`branches`) | AdminPanel.tsx | form উপরে | ১, ৩ |
| 6 | MPR Nos (`mprs`) | AdminPanel.tsx | form উপরে | ১, ৩ |
| 7 | Imports — Budget (`imports`) | AdminPanel.tsx | table কাটা, ছোট বোতাম ১৬ | ১, ২ |
| 8 | Reports — PEPM (`reports`) | AdminPanel.tsx | tab, filter, table কাটা, ছোট বোতাম ৪২ | ১, ২, ৩ |
| 9 | Users (`users`) | AdminPanel.tsx | "Add New User" form উপরে, Module Access অনেক ছোট বোতাম | ১, ২, ৩ |
| 10 | Employees (`employees`) | EmployeesPanel.tsx | tab, table কাটা (৪টা table) | ১, ২ |
| 11 | Departments (`departments`) | AdminPanel.tsx | form উপরে, table কাটা | ১, ২, ৩ |
| 12 | Remote Attendance (`attendance`) | AdminPanel.tsx | filter অনেক, table কাটা | ১, ২, ৩ |
| 13 | Monthly Attendance Report (`attendance_reports`) | AdminPanel.tsx | tab, filter, calendar grid, ছোট লেখা ১৩৭ | ১, ৩, ৪ |
| 14 | Monthly Leave Application (`leave_applications`) | AdminPanel.tsx | কার্ড-ধাঁচের তালিকা আছে, শুধু header | ১ |
| 15 | Office Attendance (`office_attendance`) | SiteAttendanceAdmin.tsx | tab, table কাটা | ১, ২ |
| 16 | Employee Tracking (`tracking`) | EmployeeTrackingPanel.tsx | মানচিত্র ঠিক; ছোট বোতাম ১৮ | ১ |
| 17 | Job Recycle (`recycle`) | AdminPanel.tsx | table কাটা | ১, ২ |
| 18 | Job Edit / MPR Edit Log (`editlog`) | AdminPanel.tsx | ব্যাখ্যা লম্বা | ১, ২ |
| 19 | Notices (`notices`) | NoticeManager.tsx | কার্ড ঠিক; tab | ১ |
| 20 | Check In/Out (`claims`) | ClaimsPanel.tsx | ফোনের তালিকা আছে; filter | ১, ৩ |
| 21 | Approval Chain (`approvals`) | AdminPanel.tsx | লম্বা ব্যাখ্যা, Queue table কাটা | ১, ২ |
| 22 | Bill Claim (`bill_claim`) | ConveyanceBillPanel.tsx | ফোনের তালিকা আছে; filter | ১, ৩ |
| 23 | Bill Claim Policy (`bill_claim_policy`) | BillClaimPolicyPanel.tsx | ২টা table কাটা, ছোট বোতাম ২৩ | ১, ২ |
| 24 | Disbursement (`disbursement`) | DisbursementPanel.tsx | ফোনের তালিকা আছে; filter | ১, ৩ |
| 25 | Holidays (`holidays`) | HolidayCalendarPanel.tsx | ক্যালেন্ডার, ছোট বোতাম ১০৮ | ১, ৪ |
| 26 | Asset Management (`asset_management`) | AssetManagementAdmin.tsx | tab দুই লাইনে ভাঙা; table | ১, ২ |
| 27 | Vehicle Management (`vehicle_management`) | VehicleManagementAdmin.tsx | tab ভাঙা, লম্বা ব্যাখ্যা, ছোট ঘর | ১, ২ |
| 28 | Permanent Delete Log (`permanent_delete_log`) | AdminPanel.tsx | table কাটা | ১, ২ |
| 29 | Companies (`companies`) | SystemCompanies.tsx | tab; "Who can work where" table | ১, ২ |
| 30 | Device Access (`devices`) | DeviceAccess.tsx | table (ভেতরে ভাঙা লেখা) | ১, ২ |
| 31 | Active Users (`active_users`) | ActiveUsers.tsx | লম্বা লেখা, setting form | ১ |
| 32 | Exit / Offboarding (`exit_offboarding`) | ExitOffboardingPanel.tsx | tile ঠিক | ১ |
| 33 | Performance (`performance_management`) | PerformanceManagementPanel.tsx | ফাঁকা অবস্থা ঠিক | ১ |
| 34 | Recruitment (`recruitment`) | RecruitmentPanel.tsx | ফাঁকা অবস্থা ঠিক | ১ |
| 35 | Grievance & Disciplinary (`grievance_disciplinary`) | GrievanceDisciplinaryPanel.tsx | tab | ১ |
| 36 | HR Analytics (`hr_analytics`) | HRAnalyticsDashboard.tsx | tile ঠিক | ১ |
| 37 | Management Dashboard (`management_dashboard`) | ManagementDashboard.tsx | কার্ড ঠিক; ১টা table | ১, ২ |
| 38 | Document Vault (`document_vault`) | DocumentVaultPanel.tsx | তালিকার লেখা কাটা ("C… co…") | ১, ২ |
| 39 | HR Operations (`hr_operations`) | HROperationsPanel.tsx + উপ-পাতা | tab ১০টা, table কাটা | ১, ২ |
| 40 | Task Management (`task_management`) | TaskManagement.tsx | tile ঠিক, tab | ১ |
| 41 | Mobile Bill (`mobile_bill`) | MobileBillAdmin.tsx | tab ৯টা, table কাটা (৫টা) | ১, ২ |
| 42 | Target Reports (`target_reports`) | TargetReports.tsx | filter অনেক, table | ১, ২, ৩ |
| 43 | Mail Administration (`mail_admin`) | MailAdministration.tsx | tab, table কাটা | ১, ২ |
| 44 | Duty Roster (`duty_roster`) | DutyRoster.tsx | grid (ছোট ঘর), tab | ১, ৪ |
| 45 | Break Time (`break_time`) | BreakTimeAdmin.tsx | ঠিক আছে | ১ |
| 46 | User Feedback (`user_feedback`) | FeedbackAdmin.tsx | filter ৫টা | ১, ৩ |
| 47 | Payroll (Self Service view `payroll`) | PayrollModule.tsx + উপ-পাতা | tab অনেক, salary sheet grid | ১, ২, ৪ |
| 48 | Leave Manage (Self Service view `leaveManagement`) | LeaveManage.tsx | accordion ঠিক; table কাটা | ১, ২ |

## ৬. ফাইল

- ফোনের ছবি (আগে): scratchpad-এ, পরে test log-এ যোগ হবে।
- Desktop baseline: প্রতি ধাপের পর মেলানোর জন্য।
- Mockup: https://claude.ai/artifact/Qc9rKPgSZ2rFpKwQfxkc86 (৫টা board: Employees, Approval Chain, Remote Attendance, Departments, Duty Roster — আগে / পরে)।
