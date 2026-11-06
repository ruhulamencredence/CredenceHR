# CredenceHR — Application Security (নিরাপত্তা ব্যবস্থা)

> **এই ডকুমেন্ট কী:** কেউ নিরাপত্তা নিয়ে প্রশ্ন করলে (ক্লায়েন্ট, অডিটর, ম্যানেজমেন্ট, IT) দেখানোর জন্য।
> **কীভাবে লেখা:** প্রতিটি দাবির পাশে **প্রমাণ** (কোড-ফাইল বা চালানো টেস্ট) দেওয়া আছে। যা এখনও ঠিক হয়নি তা **খোলাখুলি** "জানা সীমাবদ্ধতা" অংশে আছে।
> **ভিত্তি:** কোড ও পরীক্ষা, ২৫ অক্টোবর ২০২৬ (branch `claude/nice-fermi-0tale9`)।
> **যা এখানে নেই:** সার্ভার/নেটওয়ার্ক/ব্যাকআপ/অফিসের নীতি (হোস্টিং ও প্রতিষ্ঠানের ব্যাপার), বাইরের penetration test। এগুলোর অবস্থা `README.md`-র "ডকুমেন্ট প্রস্তুতি" তালিকায়।

---

## ১. এক পাতার সারাংশ

| ক্ষেত্র | অবস্থা |
|---|---|
| পাসওয়ার্ড রাখা | bcrypt hash (cost 10); সরল পাঠ কোথাও নেই |
| লগইন সুরক্ষা | ৫ ভুলে ১৫ মিনিট লক; এক IP থেকে ৩০ ভুলে অপেক্ষা; সব চেষ্টা লগে |
| সেশন | JWT, ওয়েব ১২ ঘণ্টা/৬০ মিনিট নিষ্ক্রিয়তা, অ্যাপ ৭ দিন; যেকোনো সময় বাতিল করা যায়; পাসওয়ার্ড বদলালে বাকি সব সেশন বন্ধ |
| অনুমতি | role (superadmin/admin/user) + মডিউল + layer + বিভাগ-সীমা + কোম্পানি-সীমা; **UI লুকানো ও API বন্ধ দুটোই** |
| ডাটাবেস | সব query prepared statement (`?`); কোম্পানি-ফিল্টার স্বয়ংক্রিয়; বেতন/সেবা-রেকর্ড মোছা ডাটাবেসই আটকায় |
| XSS | Notice সার্ভারে ও ব্রাউজারে পরিষ্কার; React নিজে escape করে; Mail বডি DOMPurify |
| ডিজিটাল স্বাক্ষর | OTP, SHA-256 tamper-check, QR যাচাই, PKCS#7 সার্টিফিকেট স্বাক্ষর |
| মেইল পাসওয়ার্ড | AES-256-GCM (চাবি `.env`-এ, কোডে নেই) |
| নিরীক্ষা (audit) | লগইন চেষ্টা, পাসওয়ার্ড রিসেট, payroll-এ কে কী করল, কর্মীর তথ্য বদল, অ্যাক্সেস বদল, ই-স্বাক্ষর ঘটনা |
| জানা সীমাবদ্ধতা | নিচে ১০ নম্বর অংশে **১১টি**, সৎভাবে লেখা |
| বাইরের পরীক্ষা | ❌ এখনও হয়নি (Penetration test)। আমাদের নিজস্ব স্বয়ংক্রিয় টেস্ট আছে (১১ নম্বর অংশ) |

---

## ২. Authentication (কে লগইন করছে তা প্রমাণ)

| নিয়ন্ত্রণ | বিবরণ | প্রমাণ |
|---|---|---|
| Asset ফেরত গ্রহণ | ফেরত গ্রহণ (`POST /api/assets/assignments/:id/receive`) শুধু যিনি item-টা দিয়েছিলেন (assigned_by, অ্যাকাউন্ট বন্ধ না) বা Asset Management / Superadmin — অন্য কেউ, এমনকি কর্মী নিজেও না (403)। ফেরত পাঠাতে পারেন শুধু যাঁর নামে item। Returns to receive তালিকায় store keeper শুধু নিজের দেওয়া item দেখেন। এক item-এর ইতিহাস (`/api/assets/:id/timeline`) দেখে শুধু Asset Management, item-এর কর্মী (নিজের অংশ) আর যিনি দিয়েছিলেন; বাকিদের 403। বাইরের লোকের নাম ও মোবাইল শুধু এই হাতবদলের রেকর্ডে থাকে | `AssetManagementRoutes.ts` |
| অনুমোদনের approver বদল | block / inactive / চলে যাওয়া account কোনো আবেদনের approver হিসেবে ধরা হয় না (server-এ `getCurrentStepApprovers`), নতুন আবেদনও তাঁর কাছে যায় না; অপেক্ষায় থাকা আবেদন কর্মীর এখনকার Supervisor বা Layer-এর active লোকের কাছে যায়, কেউ না থাকলে শুধু Superadmin সিদ্ধান্ত দেন — alert যায় শুধু আবেদনকারীর নিজের workspace-এর Superadmin (ও system owner)-এর কাছে, অন্য workspace-এর কাছে নয়। এই মিলিয়ে দেখা কোনো একটা company-র Admin Panel scope-এ চলে না, তাই sister company-র Supervisor হারিয়ে যান না। কে কখন approve করলেন `actions_json`-এ আগের মতোই থাকে | `server.ts` reconcilePendingApprovals |
| Ride বাতিল | start-এর আগের ride বাতিল server-এ যাচাই হয়: Pending — শুধু rider; Approved (গাড়ি নেই) — rider, শেষ approver বা Vehicle Management / Maintainer; গাড়ি দেওয়া — rider, driver, যিনি দিয়েছেন বা Vehicle Management; বাকিদের 403। শুরু হওয়া ride বাতিল হয় না | `VehicleManagementRoutes.ts` |
| Vehicle drivers | Inventory → Drivers দেখা Vehicle Management module-এ; driver যোগ / বদল / বাদ আলাদা 🔒 layer `manage_drivers` (ডিফল্টে কারও নেই, API-ও `requireModuleLayer` দিয়ে বন্ধ)। ride-এ driver বাছাই server-এও যাচাই হয়: তালিকা চালু থাকলে শুধু Active, মেয়াদি License-এর driver | `VehicleManagementRoutes.ts` |
| Login ID | কর্মীর Login ID হলো তার Employee ID (যেমন `CPL-0201`), `users.username`-এ রাখা (ডাটাবেসে UNIQUE)। একই Employee ID দুবার দেওয়া যায় না: অন্য কোম্পানির কর্মী, অন্য অ্যাকাউন্টের username বা email-এর সাথে মিললেও সার্ভার 409 দেয় (নতুন কর্মী, এডিট, Data Import)। Employee ID বদলালে Login ID-ও বদলায়। ইমেইল দিয়েও লগইন চলে; Superadmin ও Project login আগের মতো। Admin Panel → Users → Change Login ID-এ (Users module + `edit_add` layer, সার্ভারেও যাচাই) বর্তমান email ও username দুটোই দেখায়, নতুন username দেওয়া যায় (`PUT /api/users/:id/username`): ৩–৫০ অক্ষর, শুধু অক্ষর/সংখ্যা/`.`/`-`/`_`, অন্যের username, email বা অন্য কর্মীর Employee ID হলে 400; হাতে দেওয়া username পরে Employee save-এ বদলায় না | `EmployeeLoginId.ts`, `EmployeeRoutes.ts`, `DataImportRoutes.ts` |
| কেউ নিজে অ্যাকাউন্ট খুলতে পারে না | Public registration বন্ধ; শুধু Admin/HR অ্যাকাউন্ট বানায় | `AuthRoutes.ts` |
| Superadmin | `.env`-এর `ADMIN_EMAIL/PASSWORD` থেকে তৈরি; app থেকে বদলানো password restart-এ আর `.env`-এরটায় ফেরে না — `.env`-এ `ADMIN_PASSWORD` বদলে restart করলে তবেই সেটা বসে (শেষ বসানো password-এর bcrypt hash `startup_migrations`-এ, `startupOnce.ts`); API দিয়ে বানানো যায় না (নতুন "superadmin" চাইলেও role `user` হয়); ব্লক করা যায় না; পাসওয়ার্ড রিসেট প্রবাহে বদলানো যায় না | `server.ts` `seedAdminFromEnv`, `AccountBlock.ts`, টেস্ট |
| পাসওয়ার্ড hash | bcryptjs, cost 10 | `UserManagement.ts`, `AuthRoutes.ts` |
| ভুল পাসওয়ার্ড | অ্যাকাউন্টে ৫ বার ভুলে ১৫ মিনিট লক (সঠিক পাসওয়ার্ডও তখন চলে না); এক IP-তে ৩০ বার ভুলে অপেক্ষা; অচেনা ID-ও একইভাবে গোনা হয় | `LoginGuard.ts`, টেস্ট (২৫ ভুলের পর আটকায়) |
| অ্যাকাউন্ট আন্দাজ | ভুল ID ও ভুল পাসওয়ার্ড, দুটোতে একই বার্তা; Forgot-password-এ ID আছে কি না বোঝা যায় না | টেস্ট `SEC-02`, `PasswordResetRoutes.ts` |
| পাসওয়ার্ড নীতি | **কোম্পানির সিদ্ধান্তে যেকোনো পাসওয়ার্ড চলে** (যেমন `1234`), শুধু ফাঁকা নয় ও ১২৮ অক্ষরের বেশি নয়। ব্যবহারকারীদের সুবিধার জন্য ইচ্ছাকৃত। সুরক্ষা আসে অন্য স্তর থেকে: ভুল পাসওয়ার্ডে লগইন আটকানো (LoginGuard), এক-ফোন নিয়ম, পাসওয়ার্ড বদলালে অন্য সব সেশন বন্ধ, bcrypt hash। সব জায়গায় একই নিয়ম এক ফাইলে | `src/lib/passwordPolicy.ts` |
| Forgot password | (ক) ইমেইলে ৬ অঙ্কের কোড: ১৫ মিনিট, ৫ চেষ্টা, কোড hash করে রাখা, timing-safe তুলনা, একবার ব্যবহার; (খ) HR-কে অনুরোধ: HR অস্থায়ী পাসওয়ার্ড দেয়, কর্মী পরের লগইনে নিজেরটা দিতে বাধ্য। দুটোতেই পুরোনো সব সেশন বন্ধ; IP ও অ্যাকাউন্টভিত্তিক রেট লিমিট | `PasswordResetRoutes.ts` |
| Fingerprint / Passkey | অ্যাপ: ফোনের Keystore/Keychain-এ সিক্রেট (সার্ভারে শুধু SHA-256); ওয়েব: WebAuthn passkey (সার্ভারে শুধু public key)। পাসওয়ার্ড বদলালে/ডিভাইস সরালে/সুইচ বন্ধ হলে অচল। ভুল চেষ্টা লগইন-লকে গোনা হয় | `FingerprintRoutes.ts` |
| একটি ফোন নিয়ম (অ্যাপ) | নতুন ফোনে লগইন Superadmin-এর অনুমতির অপেক্ষায়; ফোন সরালে ওই ফোনের সেশন বন্ধ | `DeviceRoutes.ts` |
| মোবাইল অ্যাপের আলাদা অনুমতি | অ্যাপ (APK) পুরো বন্ধ করা যায়, বা module / Self Service switch আলাদা করে অ্যাপ থেকে সরানো যায়; অ্যাপ কখনো ওয়েবসাইটের চেয়ে বেশি পায় না। সার্ভারে প্রতিটা অ্যাপ request-এ `queryDB` অনুমতি ছোট করে দেয়, তাই UI আর API দুটোই আটকায়। নতুন অ্যাকাউন্টে অ্যাপ ডিফল্টে বন্ধ | `AppAccess.ts` |
| onboarding লগইন | নতুন কর্মীর অস্থায়ী লগইন শুধু "My Onboarding" পেজে সীমিত, মেয়াদ শেষে বাতিল | `OnboardingSelfServiceRoutes.ts` |
| ব্লক | HR ব্লক করলে বা পদত্যাগ/বরখাস্ত কার্যকর হলে সব সেশন সঙ্গে সঙ্গে বন্ধ (প্রতি রিকোয়েস্টে যাচাই) | `AccountBlock.ts` |

---

## ৩. Session ও Token

- **Token:** JWT (HS256), কোম্পানি/ডিভাইস/সময়সহ। সই করার চাবি **কোডে লেখা নেই**: `.env`-এর `JWT_SECRET` (৩২+ অক্ষর) নইলে প্রথম চালুতে এলোমেলো চাবি `.jwt-secret` ফাইলে (git-এ নেই)। একাধিক সার্ভার হলে সবগুলোয় একই `JWT_SECRET` দিতে হবে (`JwtSecret.ts`)।
- **মেয়াদ (Superadmin বদলাতে পারে):** ওয়েব ১২ ঘণ্টা বা ৬০ মিনিট নিষ্ক্রিয়; অ্যাপ ৭ দিন বা ৩ দিন না খুললে (`SessionSecurity.ts`)।
- **বাতিল করা:** `user_sessions` টেবিলে token-এর **hash** থাকে (token নিজে নয়)। Logout, Superadmin-এর "Active Users" থেকে বের করা, পাসওয়ার্ড বদল (যে সেশন থেকে বদলানো সেটা বাদে), অ্যাকাউন্ট ব্লক।
- **কোথায় থাকে:** ওয়েবে `localStorage`; অ্যাপে অ্যাপের স্টোরেজ। (কুকি নয়, তাই CSRF প্রযোজ্য নয়; তবে XSS হলে token ঝুঁকিতে, তাই XSS রোধ কড়া, ৬ নম্বর)।

---

## ৪. Authorization (কে কী করতে পারবে)

পুরো ছবি: `02-application-workflow.md` §৪। তালিকা: [`security/access-control-matrix.md`](security/access-control-matrix.md) (৪০টি Admin মডিউল ও তাদের layer)।

1. **Role:** `superadmin` (সব), `admin` (শুধু যে মডিউল দেওয়া), `user` (কর্মী: শুধু নিজের তথ্য + চালু সুইচ)।
2. **মডিউল অনুমতি:** `requireModule("payroll")`; Admin নিজে নিজেকে বাড়াতে পারে না (টেস্ট `AUTHZ-04`)।
3. **Layer:** মডিউলের ভেতরের সূক্ষ্ম ধাপ (`requireModuleLayer`)। **🔒 layer** ডিফল্টে বন্ধ, Superadmin না দিলে কেউ পায় না। উদাহরণ: `salary_hold`, `audit_approve`, `accounts_pay`, `permanent_delete`, `mail_password`, `block_account`।
4. **বিভাগ-সীমা:** Attendance Report, Leave, Duty Roster, Conveyance Claim-এ Admin শুধু নির্দিষ্ট বিভাগের কর্মী দেখে। Employee Tracking-এ বিভাগের সাথে একক কর্মীও বাছা যায় (`TrackingScope.ts`, `tracking_department_access`, `tracking_employee_access`): কিছু বাছা থাকলে live map, status, notice, notice report, path history, Stay Report ও Live Follow — সব route শুধু সেই মানুষদের দেখায়; বাইরের কারও id পাঠালে 403। কিছু বাছা না থাকলে আগের মতো সবাই।
5. **কোম্পানি-সীমা:** ৫৬টি টেবিলে `company_id`; `companyScope.ts` প্রতিটি `SELECT/UPDATE/DELETE/INSERT`-এ ফিল্টার নিজে বসায়। কোম্পানি বদলাতে ব্যবহারকারীর ওই কোম্পানিতে প্রবেশাধিকার লাগে। **Admin Panel-এর কাজে (strict scope)** — `requireModule`/`requireModuleLayer` পার হলেই — id দিয়ে একটা রেকর্ড খোলা বা বদলানোও শুধু চলতি কোম্পানির (বা সেখানে assign করা) কর্মীর হয়; আগে একই group-এর অন্য কোম্পানির কর্মীর ব্যাংক অ্যাকাউন্ট, বেতন, নাম id পাঠিয়ে পড়া/বদলানো যেত (টেস্ট `qa-companies.mjs` CO-06..13)। নিজের ছুটি, My Approvals-এর মতো self-service অংশে group-জুড়ে খোঁজা আগের মতোই চলে (অন্য কোম্পানির Supervisor approve করতে পারেন, CO-15)। মাদার কোম্পানির HR-কে Superadmin sister company-র প্রবেশাধিকার ও সেখানকার Module Access দিলে তিনি company switcher-এ ওই কোম্পানিতে গিয়ে পুরো HR কাজ করেন — কর্মী, ব্যাংক অ্যাকাউন্ট, বেতন, payroll (টেস্ট `qa-group-hr.mjs` GH-01..09)। **All companies mode** (`users.can_work_all_companies`, ডিফল্টে বন্ধ, শুধু Superadmin দিতে পারেন, বদল `user_access_audit`-এ): request-এ `X-Company-Scope: all` থাকলে সার্ভার শুধু অনুমতি থাকলে মানে, এবং শুধু সেই কোম্পানিগুলো খোলে যেগুলোতে ওই অ্যাকাউন্টের প্রবেশাধিকার আছে; অনুমতি না থাকলে header কিছুই বদলায় না। Settings, Module Access ও নতুন রেকর্ড বাছা কোম্পানির থাকে; payroll চালানো প্রতি কোম্পানিতে আলাদা (টেস্ট GH-10..21)। একদম নতুন ডাটাবেসে প্রথম চালুতে `departments`, Module Access layer, `access_templates` ও `zk_devices`-এ `company_id` আসত না (তাই নতুন কর্মী যোগ ভেঙে যেত); এখন প্রথম চালুতেই আসে (QA tests workflow এটা প্রতিবার খালি ডাটাবেসে পরীক্ষা করে)।
6. **Self-service সুইচ:** Loan, Payslip, Roster, Chat, Fingerprint, AI Assistant, SIM & ID Card request ইত্যাদি ব্যবহারকারীভিত্তিক সুইচ, ডিফল্টে বন্ধ। SIM/ID card issue করা HR Operations-এর আলাদা `requisitions` layer (ডিফল্টে বন্ধ); কর্মী শুধু নিজের request দেখেন ও বাতিল করেন, joiner-এর request-এর route শুধু onboarding login-এর জন্য (`RequisitionRoutes.ts`)। Book a Ride-এর save করা জায়গা (`users.can_save_ride_places`, `ride_saved_places`) এমনই একটা সুইচ, আর জায়গাগুলো শুধু নিজের — প্রতিটা অনুরোধ নিজের `user_id`-এ সীমিত, অন্যের id দিলে 404।
7. **কাজের বিভাজন (segregation of duties):** Payroll: HR বানায় → HR Director review (`hrd_review`) → MD কাগজে (HR তাঁর কপি attach করে, correction লেখে) → Accounts pay → Audit পরে, ঐচ্ছিক। **যে কোনো বেতন চালিয়েছে, হাতে বদলেছে বা মাস পাঠিয়েছে সে অ্যাপে HR Director review দিতে পারে না; যে চালিয়েছে, পাঠিয়েছে বা Accounts-এ পাঠিয়েছে সে pay করতে পারে না; যে বানিয়েছে, পাঠিয়েছে বা pay করেছে সে audit করতে পারে না** (মাস ও একক বেতন দুটোতেই)। কাগজের ধাপ (HR Director-এর সই, MD-র কপি) সই করা scan/photo attach না করলে এগোয় না, আর প্রতিটি correction কে লিখল, কে apply করল, আগে-পরে net কত — `payroll_corrections`-এ থাকে। প্রতিটি print-এ নতুন version নম্বর ছাপা হয়, তাই পুরোনো কপিতে লেখা বদল ধরা যায়। Audit ও Accounts পায় "View only" (`payroll_view`) layer: সব দেখে, কিছু বদলাতে পারে না, তাই দেখার জন্য HR-এর বানানো/বদলানোর অনুমতি দিতে হয় না। বোনাস, overtime ও কর্তন ঋণাত্মক হয় না; নিষ্ক্রিয় কর্মীর বেতন শুধু ছেড়ে যাওয়ার মাস পর্যন্ত চলে (ghost employee নিয়ন্ত্রণ)। Onboarding: **যে খুলেছে সে approve করতে পারে না**। (Superadmin ব্যতিক্রম, ১০ নম্বরে।)
8. **নিজের দাবি নিজে অনুমোদন নয়:** কর্মী নিজের ছুটি নিজে approve করতে পারে না (টেস্ট `LEAVE-12`)।
9. **নিয়ম (`CLAUDE.md`):** নতুন যেকোনো ফিচার/মেনু/বোতাম/API অনুমতির পেছনে থাকবে। UI লুকানো **এবং** API বন্ধ।
10. **Admin Dashboard:** পাতাটা সব Admin খোলেন, কিন্তু প্রতিটি অংশ আসে শুধু সেই মডিউল থাকলে — জন্মদিন (Employees), probation/চুক্তি/ডকুমেন্টের মেয়াদ (Employees বা HR Operations), উপস্থিতির অনুমোদন (Attendance), প্রতিটি "অপেক্ষার কাজ"-এর সংখ্যা তার নিজের মডিউলে (`AdminDashboardRoutes.ts`; টেস্ট QA-01)। "Coming up — next 60 days" (probation, চুক্তি, ডকুমেন্ট, অবসর, increment) শুধু HR Operations-এর `reminders_receive` layer থাকলে আসে — UI-তে না দেখানোর পাশাপাশি `/api/hr-ops/reminders/upcoming`-ও বন্ধ (`AdminDashboardReminders.tsx`)।
11. **কর্মীর তথ্য যাচাই:** ইমেইল `name@domain.tld` হতে হবে; জন্মতারিখ আসল, ভবিষ্যতের নয়, বয়স ১৪–১০০ (শ্রম আইন ২০০৬, ধারা ৩৪; `EmployeeValidation.ts`)। পুরনো রেকর্ডে শুধু বদলানো ঘরটা যাচাই হয়।
12. **HR Data Import আলাদা অনুমতি:** কোনো মডিউল (Employees, Leave, Attendance…) থাকলেই সেখানে Excel থেকে ডাটা ঢোকানো যায় না। লাগে নিজস্ব মডিউল `data_import` আর প্রতিটি ধরনের 🔒 layer (`import_employees`, `import_leave`, `import_movement_claims`, `import_conveyance`, `import_attendance`, `import_office_attendance`) — সব ডিফল্টে বন্ধ। সার্ভারে `DataImportRoutes.ts` → `allowedKinds` মডিউল ও layer দুটোই দেখে (না থাকলে 403), মেনু ও পাতা `data_import` ছাড়া দেখায় না। বেতন import আগের মতো Payroll layer `salary_bulk_upload`।
13. **Payroll-এর Salary sheet (Approval):** প্রতিটি কর্মীর বেতনের ভাঙন স্ক্রিনে দেখা Payroll layer `approval_sheet`-এর পেছনে (`requireModuleLayer("payroll","approval_sheet")`, UI-ও লুকায়)। Month comparison (আগের মাসের সাথে তুলনা) আলাদা layer `month_compare`-এর পেছনে, একইভাবে। এটা শুধু দেখা — review / pay / audit `hrd_review` / `accounts_pay` / `audit_approve` আর কাজের বিভাজনের নিয়ম মেনে। Top Sheet (মাসের বেতন Branch / site অনুযায়ী, প্রতি সাইটের কর্মী-ভিত্তিক sheet, Excel / PDF) আলাদা layer `top_sheet`-এর পেছনে, একইভাবে (`requireModuleLayer("payroll","top_sheet")`, UI-ও লুকায়; শুধু "View only" থাকা Audit / Accounts-কে আলাদা টিক দিতে হয়)। টেস্ট: Payroll module নেই → 403, layer সেভ করা কিন্তু `top_sheet` নেই → 403, View only → 403, View only + Top Sheet → 200।
14. **Attendance Report Builder (Custom Report):** শর্ত দিয়ে হাজিরা খোঁজা Attendance Reports-এর layer `custom_report`-এর পেছনে — সার্ভারে `POST /api/attendance/report/custom` ও `GET …/custom/people` দুটোই `requireAdmin` + `hasModuleLayer("attendance_reports","custom_report")` (না থাকলে 403), UI-তে ট্যাবও লুকায়। ডাটা আসে `computeMonthlyReport` থেকে, তাই Department সীমা ও কোম্পানি ফিল্টার একই — সীমার বাইরের department চাইলে খালি ফেরে। একবারে সর্বোচ্চ ৯২ দিন, ১২টা শর্ত। AI Assistant-এর `attendance_custom_report` একই API প্রশ্নকারীর token দিয়ে ডাকে, তাই layer বা module না থাকলে Assistant-ও "অনুমতি নেই" বলে (টেস্ট: module নেই → 403, layer বাছা কিন্তু `custom_report` নেই → 403, HR-সীমিত Admin → শুধু HR)।
15. **Assistant-এর Email নিজের mailbox থেকে:** Assistant থেকে রিপোর্ট mail করলে Credence Mail-এর New message window খোলে আর mail যায় প্রেরকের নিজের mailbox দিয়ে, Mail module-এর নিজের সব নিয়মে (`users.can_use_mail`, শুধু নিজের mailbox, group-এ লেখার অনুমতি, encrypted password; অন্যের mailbox "view-as" খোলা থাকলে window খোলে না, আর server-ও view-as-এ পাঠানো আটকায়) — server-এর SMTP account দিয়ে নয়, তাই কেউ কোম্পানির সাধারণ ঠিকানা থেকে নিজের নামে mail পাঠাতে পারেন না, প্রাপক আসল প্রেরককে দেখেন। Email বোতাম দেখায় শুধু "Email reports" (`can_email_reports`) থাকলে; Mail না থাকলে বা mailbox না থাকলে পাঠানো যায় না। `/api/reports/email`-এর `via: "own"` একই নিয়মে (Mail না থাকলে 403, mailbox না থাকলে 409, ব্যর্থ চেষ্টাও `report_email_log`-এ)।
16. **Profile ছবি Superadmin-এর অনুমোদনে:** কেউ নিজের profile ছবি বদলালে নতুন ছবি সরাসরি বসে না, Superadmin Approve করলে তবেই (অনুপযুক্ত বা অন্যের ছবি দিয়ে পরিচয় গোলমাল ঠেকাতে)। অনুমোদনের তালিকা, ছবি আর Approve / Reject-এর API শুধু Superadmin-এর (অন্য admin 403, টেস্ট করা); একবারের বেশি সিদ্ধান্ত হয় না (409); Reject-এ কারণ বাধ্যতামূলক; সিদ্ধান্তের পর অনুরোধের ছবির কপি মুছে ফেলা হয়। Superadmin-এর নিজের ছবি আর onboarding-এর joiner-এর ছবি সরাসরি বসে।
17. **Check-in project ও তারিখ:** কে কোন project-এ কোন তারিখে check-in করবেন তা server ঠিক করে (`AttendanceProjects.ts` restrictedAttendanceProjects) — check-in, Correct Attendance ও Data Import তিন জায়গাতেই; ফোন থেকে অন্য project id পাঠালে 403। তালিকা বদলাতে লাগে Users module + `edit_add` layer, Superadmin-এর তালিকা কেউ বদলায় না, Admin-এর তালিকা শুধু Superadmin।
18. **ZKTeco Cloud push (`/iclock/*`):** ADMS protocol-এ কোনো password / token নেই, তাই এই route login ছাড়া খোলা। রক্ষা: (ক) শুধু Machines-এ register করা, চালু, "Cloud push" ধরনের মেশিনের Serial number মানা হয়, অচেনা SN কিছুই লিখতে পারে না; (খ) "Only from this internet address" দিলে শুধু সেই public IP; (গ) শুধু ATTLOG punch লেখা হয়, অন্য কোনো টেবিল ছোঁয় না, মেশিনকে কোনো command পাঠানো হয় না; (ঘ) একই punch দুবার লেখা হয় না (unique key)। SN জেনে কেউ ভুয়া punch পাঠাতে পারে — তাই সাইটের fixed IP থাকলে অবশ্যই দিন (সীমাবদ্ধতা ১৩)।
19. **Payroll-এর সই করা কপি (scan / photo):** `PAYROLL_FILES_DIR` ফোল্ডারে (public নয়) এলোমেলো নামে থাকে, ডাটাবেসে শুধু path; path ফোল্ডারের বাইরে গেলে বাতিল। শুধু PDF / JPG / PNG / WebP, ২০ MB পর্যন্ত, আর ফাইলের প্রথম বাইট ধরন মেলাতে হয় (নাম বদলানো ফাইল বাতিল)। Attach ও মোছা শুধু HR (`read`), আর শুধু সেই ধাপে (HR Director-এর কপি hrd_review-এ, MD-র কপি md_review / corrections-এ) — তারপর কপি বদলায় না। খোলা যায় শুধু অনুমোদনের পথে থাকা layer দিয়ে (`read`, `hrd_review`, `accounts_pay`, `audit_approve`, `payroll_view`), `nosniff` সহ।

---

## ৫. ডাটা সুরক্ষা

- **নিজের profile ছবি cache হয় না:** `/api/profile/photo` সব অ্যাকাউন্টের জন্য একই URL, তাই `Cache-Control: no-store` (আর `Vary: Authorization`)। আগে ৫ মিনিট cache থাকত বলে একই ফোনে account বদলালে আগের জনের ছবি দেখাত। অন্যের ছবি id দিয়ে (`/api/profile/photo/:userId`) আগের মতো কয়েক মিনিট রাখা হয়।

| বিষয় | ব্যবস্থা | প্রমাণ |
|---|---|---|
| SQL Injection | সব query `queryDB(sql, [params])`, prepared statement; লগইনে injection চেষ্টা আটকায় | `server.ts` `queryDB`, টেস্ট `SEC-04` |
| পাসওয়ার্ড/সিক্রেট ডাটাবেসে | login: bcrypt; মেইল পাসওয়ার্ড: AES-256-GCM; passkey: শুধু public key; fingerprint: শুধু SHA-256; reset কোড: hash; token: hash | `MailRoutes.ts`, `FingerprintRoutes.ts`, `PasswordResetRoutes.ts` |
| কর্মী মুছলে বেতন-রেকর্ড | ডাটাবেস `ON DELETE RESTRICT` (১৪টি foreign key), API-তেও `409` | `EmployeeRecordsGuard.ts`, টেস্ট |
| পরিশোধিত বেতন | বদলানো যায় না ("A Paid payroll run can't be edited"); একই কর্মী-মাস দুবার হয় না (UNIQUE) | `PayrollRoutes.ts`, টেস্ট |
| ছুটি দ্বৈত আবেদন | একই দিনে দ্বিতীয় আবেদন 409; ব্যালেন্স শূন্যের নিচে যায় না | টেস্ট `LEAVE-04..06` |
| একসাথে দুবার চাপ (double-click, দুই ট্যাব, দুই server worker) | approve, payroll submit/approve/return/pay, বেতন "paid", বিল disburse, ঋণ approve — প্রতিটা ডাটাবেসে শর্তসহ `UPDATE ... WHERE status = <আগের অবস্থা>`; যে দ্বিতীয় আসে সে 409 পায়। ফলে ঋণের কিস্তি দুবার কাটে না, বিল দুবার দেওয়া হয় না। দিনে একটা claim ও একটা চলমান ঋণ-আবেদনের নিয়ম একসাথে পাঠালেও ভাঙে না | টেস্ট `qa-concurrency.mjs` C1–C9 |
| Chat-এর ফাইল (folder-এ) | ফাইলের নাম এলোমেলো (পাঠানো নাম নয়), path ঠিক folder-এর ভেতরে কিনা প্রতিবার যাচাই হয় (`..` বা অন্য folder দিলে 404); folder ওয়েবে খোলা নয়, শুধু chat-এর সদস্য API দিয়ে পান (অন্যরা 403); `X-Content-Type-Options: nosniff`। folder-এর অনুমতি (শুধু server account) আর ব্যাকআপ আপনাদের হাতে | `chatFiles.ts`, `ChatRoutes.ts` |
| Notice-এর ছবি ও সংযুক্তি | ফাইল folder-এ (`NOTICE_FILES_DIR`), নাম এলোমেলো, path folder-এর বাইরে গেলে খোলে না; folder ওয়েবে খোলা নয় — ফাইল পান শুধু Notices module-এর লোক আর যাঁর জন্য notice এখন live (অন্যরা 403)। শুধু ছবি (PNG/JPG/WebP/GIF — প্রথম byte মিলিয়ে, নাম বদলানো ফাইল নয়) ও অফিস-ডকুমেন্ট নেওয়া হয়, .exe ইত্যাদি নয়; ছবি ৫ MB, ফাইল ২০ MB। লেখা আগের মতো server-এ পরিষ্কার হয় (script, iframe, event handler বাদ)। "Who read it" ও email আলাদা 🔒 layer (`notice_read_report`, `notice_email`)। Animation library-তে Lottie যোগ / মোছা আলাদা 🔒 layer `notice_animations` (API-তেও 403); শুধু Lottie JSON (layers, w, h থাকতে হবে), ৩ MB পর্যন্ত, আর ভেতরের expression (JavaScript) server-এ বাদ দিয়ে রাখা হয় — notice-এ বসানো animation-ও একইভাবে | `NoticeRoutes.ts`, `noticeFiles.ts`, `NoticeSafety.ts` |
| সময়ের সঠিকতা | Timesheet সংশোধনে In Time ওই দিনেরই, Out Time ওই দিন বা (night shift) পরদিন সকাল, এবং In Time-এর পরে; অবাস্তব সময় (25:00) বাতিল | টেস্ট `qa-dates.mjs` DT-11..13b |
| ডাটাবেস ত্রুটি গোপন | ব্যবহারকারী ডাটাবেসের বার্তা (কলামের নাম ইত্যাদি) দেখে না, লগে যায় | `ApiErrors.ts` |
| তথ্য প্রকাশ কমানো | পাসওয়ার্ড hash কোনো API-তে ফেরে না (টেস্ট `SEC-08`); কর্মী অন্যের payroll/payslip পায় না (`PAY-06/07`) | টেস্ট |
| ফাইল | ডাটাবেসের BLOB-এ (আলাদা ফাইল সার্ভার নেই); JSON সীমা ২৫MB, Nginx ৩০MB; ছবির MIME যাচাই | `profileRoutes.ts`, `deploy/nginx.conf.example` |
| ট্র্যাকিং সম্মতি | লোকেশন ট্র্যাকিং চালুর আগে ব্যবহারকারীকে নোটিশ ও সম্মতি, আলাদা Superadmin সুইচ | `TrackingNoticeCard.tsx`, `locationDisclosure.tsx` |
| Chat group-এর তথ্য ও setting | নাম / photo / description বদল: group admin (বা "Edit group info" সবার জন্য খোলা থাকলে যেকোনো member); "Only admins…" setting শুধু admin; "Only admins can send" REST, socket ও forward তিন পথেই server আটকায়। Group photo শুধু member-রা আনতে পারে। Star, Mute, Clear chat প্রত্যেকের নিজের — অন্য কেউ দেখে না, অন্যের message মোছে না। Superadmin সবসময় admin। | `ChatRoutes.ts` `roomRules`, `PushNotificationService.ts` (mute) |
| Chat group invite link ও disappearing message | Link শুধু group admin বানায় / reset / বন্ধ করে; code ১৬ byte random (`crypto.randomBytes`), অনুমান করা যায় না; link-এ শুধু নাম, সদস্য-সংখ্যা ও description দেখায়, member বা message নয়; যোগ দিতে Chat-এর অনুমতি লাগে, আর যোগ দিলে সবাই chat-এ "joined using this group's invite link" দেখে। Disappearing message সময় পেরোলে সব API থেকে বাদ, তারপর ডাটাবেস ও ফাইল থেকে মুছে যায় (ব্যাকআপে আগের কপি থাকতে পারে)। | `ChatRoutes.ts` (invite, sweep) |
| Group call | শুরু ও যোগ দেওয়া: শুধু ওই group-এর member, যাঁর Calls অনুমতি আছে (server প্রতিবার যাচাই করে); signal শুধু একই call-এর দুই participant-এর মাঝে যায়; সর্বোচ্চ ৮ জন; media phone-to-phone বা TURN দিয়ে (DTLS-SRTP এনক্রিপ্টেড), server-এ কোনো audio / video জমা হয় না। | `GroupCallRoutes.ts` |
| Project-এর বাইরে থেকে হাজিরা | নিজের check-in project-এর radius-এর বাইরে দেওয়া In / Out সরাসরি হাজিরা হয় না; কারণ সহ approval-এর অনুরোধ হয়ে Timesheet-এর approval chain পার হলে তবেই `attendance`-এ লেখা হয়। জায়গা (GPS) ও দূরত্ব অনুরোধে থাকে, approver দেখেন। Server নিজে GPS দিয়ে আবার মাপে, তাই app-এর পাঠানো "offsite" দিয়ে কেউ নিজের project-এর নিয়ম এড়াতে পারে না (ভেতরে থাকলে সাধারণ হাজিরা)। | `AttendanceRoutes.ts` `offsitePunch`, `finalizeAttendanceCorrection` |
| বেতন বন্ধ হওয়া মাসের হাজিরা | যে বেতন-মাসের payroll Processed / Paid, সেখানে Timesheet সংশোধন জমা দেওয়া ও approve করা দুটোই server আটকায় (approve-এর আগেই যাচাই, তাই আধা-approve হয় না) — দেওয়া বেতন আর হাজিরার রেকর্ড আলাদা হয়ে যায় না। | `PayrollRoutes.ts` `closedPayMonthFor`, `server.ts` performApprovalAction / finalizeAttendanceCorrection |
| ফোন / ব্রাউজারে Dashboard-এর জমানো কপি | Dashboard যেন loading ছাড়া খোলে, তাই কার্ডগুলোর শেষ data (আজকের In/Out, ছুটির হিসাব, Pending Approvals, ছুটির calendar, Ride / Asset / Team badge, Tracking-এর শুধু সংখ্যা — মানুষের তালিকা নয়) ডিভাইসের `localStorage`-এ থাকে (`src/lib/screenCache.ts`)। চাবি অ্যাকাউন্ট + কোম্পানি অনুযায়ী, তাই অন্য login বা অন্য কোম্পানির data কখনো দেখায় না; ৭ দিনের পুরোনো হলে বাদ; **logout ও নতুন login-এ সব মুছে যায়**। শুধু সেটুকুই থাকে যা ওই অ্যাকাউন্টকে server আগেই দেখিয়েছে; প্রতিবার খোলার পর একই API (একই অনুমতি যাচাই) থেকে নতুন data এসে বদলে দেয়, অনুমতি বাতিল হলে কার্ড সরে যায়। Approve / Reject সবসময় server-এ যাচাই হয়। | `screenCache.ts`, `App.tsx` (`clearScreenCache`) |
| AI Assistant | আসল API-কে প্রশ্নকারীর **নিজের token** দিয়ে ডাকে, তাই অধিকারের বাইরে কিছু দেখায় না — সব রিপোর্টও সেই রিপোর্টের নিজের API দিয়ে, database সরাসরি কখনো নয়; যেখানে API পাতার চেয়ে ঢিলা (PEPM entries) সেখানে পাতার module + layer নিয়ম আগে যাচাই (`hasModuleLayer`); ৮ রকম অনুমতি-মিশ্রণে (module নেই, শুধু Claims, Payroll view-only / sheet+log, admin+Roster, Reports layer আছে/নেই, Superadmin) ২২টা রিপোর্ট-প্রশ্নে পরীক্ষিত; নিজে কিছু লেখে না — ছুটি, Book a Ride, হাজিরা ঠিক করা, Check In/Out-এর খসড়া কার্ড শুধু কর্মী নিজে বোতাম চাপলে পাতার একই API-তে যায় (একই যাচাই, একই অনুমোদন); Gemini চালু না থাকলে কোনো ডাটা বাইরে যায় না। Voice আলাদা সুইচ (`can_use_assistant_voice`, শুরুতে বন্ধ, server-এও যাচাই): কণ্ঠের রেকর্ড শুধু লিখে নেওয়ার জন্য Google-এ যায়, আমাদের সার্ভারে বা ডাটাবেসে জমা হয় না; সর্বোচ্চ ৪ MB, প্রশ্নের হার-সীমা একই | `AiAssistantRoutes.ts` |

---

## ৬. ওয়েব নিরাপত্তা (XSS, CORS, Header)

- **XSS:** React ডিফল্টে সব লেখা escape করে। যেখানে HTML দেখানো দরকার (Notice, Mail): সার্ভারে `sanitize-html` (`NoticeSafety.ts`: শুধু সাধারণ ট্যাগ; script, frame, form, `onerror`, `javascript:` লিংক, CSS `url()` বাদ; Lottie expression বাদ), সংরক্ষণ ও পড়া **দুবারই**; ব্রাউজারে DOMPurify (`noticeHtml.ts`, `MailBody.tsx`)। টেস্ট: `<script>` ও `onerror` ফেরে না।
- **CORS:** `CORS_ORIGINS` সেট করলে শুধু ওই ঠিকানা (টেস্টে `evil.example` পায় না)। **সেট না করলে সবাই ডাকতে পারে** ও সার্ভার চালুর সময় সতর্কবার্তা ছাপে (`WebSecurity.ts`)। আগে `.env`-এ দেওয়া `CORS_ORIGINS` কাজ করত না, কারণ `.env` লোড হওয়ার আগেই মানটা পড়া হয়ে যেত, তাই CORS সবার জন্য খোলা থাকত। এখন `server.ts`-এর একেবারে প্রথম import হিসেবে `dotenv/config` লোড হয়, তাই `.env`-এর মানই কাজ করে।
- **Header (প্রতি উত্তরে):** `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors 'self'; object-src 'none'; base-uri 'self'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (ক্যামেরা, মাইক, লোকেশন শুধু নিজের); HTTPS হলে `Strict-Transport-Security`।
- **CSRF:** token `Authorization` header-এ যায়, কুকিতে নয়; তাই ব্রাউজার নিজে থেকে অন্য সাইট থেকে অনুরোধ পাঠালে token যাবে না।
- **Android app download (`/downloads/*.apk`, লগইন ছাড়াই খোলা):** শুধু `downloads/` (বা `APK_DIR`) ফোল্ডারের নির্দিষ্ট নামের ফাইল পাঠায়। নামে `/` বা `..` থাকলে 404, তাই ফোল্ডারের বাইরের ফাইল পাওয়া যায় না। ফাইলটা সত্যিই APK কিনা (ভেতরে `AndroidManifest.xml`) পরীক্ষা করে পাঠায়, নইলে 404। APK-কে ঘিরে থাকা zip-এর ভেতরের APK বের করে পাঠায়, অন্য কিছু নয় (`AndroidApkRoute.ts`, টেস্ট `npm run test:apk`)। `GET /api/app/android-latest`-ও লগইন ছাড়া খোলা, কারণ লগইন পাতাতেও app-কে update-এর কথা জানাতে হয়। এটা শুধু ওই APK-এর version নম্বর আর download ঠিকানা দেয়, অন্য কোনো তথ্য নয়। app (`MainActivity.java`) পাতার কোনো download নিজে খোলে না, শুধু `http(s)` ঠিকানা ফোনের browser-কে দিয়ে দেয়।
- **Android app শুধু domain-এ চলে (`capacitor.config.ts`):** APK server-এর IP-তে নয়, শুধু `https://` domain খোলে। বানানোর সময় `CAP_SERVER_URL`-এ IP বা সাধারণ `http://` ঠিকানা দিলে build-ই থামে (ব্যতিক্রম শুধু USB দিয়ে পরীক্ষার `http://localhost`)। কারণ: চ্যাট call আর voice-এ microphone দিতে WebView নিরাপদ (https, domain) ঠিকানা চায়, আর domain-এর certificate IP-র জন্য নয়। live build-এ `cleartext` বন্ধ, আর WebView শুধু ওই domain-এর ভেতরে চলে; অন্য ঠিকানার (যেমন IP) লিংক ফোনের browser-এ খোলে, app-এর ভেতরে নয়।
- **ত্রুটির উত্তর:** সব `/api` উত্তর JSON; অজানা ঠিকানায় 404 `{error}`; ভাঙা JSON-এ 400 `{error}`; ভেতরের ত্রুটির বিবরণ বাইরে যায় না (`ApiErrors.ts`)।

---

- **ফোনের কল-পর্দা থেকে Decline:** `POST /api/calls/push-decline` sign-in ছাড়া চলে, কিন্তু শুধু সেই কলের ৪৮-অক্ষরের এলোমেলো চাবি দিলে — চাবিটা শুধু callee-র নিজের ফোনের push-এ যায়, আর কাজ করে শুধু কল বাজতে থাকা অবস্থায়, শুধু Decline-এর জন্য (`CallRoutes.ts`)।
- **কল আবার জোড়া লাগা:** নেট কাটার পর `call:rejoin` শুধু সেই কলের caller/callee account (socket-এর যাচাই করা user) করতে পারে; ৩০ সেকেন্ডে না ফিরলে কল শেষ (`CallRoutes.ts`)।

## ৭. ই-স্বাক্ষর ও ডকুমেন্টের অখণ্ডতা

(`ESignRoutes.ts`, `ESignCertificate.ts`, `DocumentVaultRoutes.ts`)
- পাঠানোর সময় মূল ফাইলের **SHA-256** স্থির; প্রতি স্বাক্ষরে আবার মেলানো; সই করা PDF-এর SHA-256-ও রাখা।
- **ক্রমানুযায়ী স্বাক্ষর:** শুধু যার পালা সে সই করতে পারে।
- **OTP (ঐচ্ছিক সুইচ):** ৬ অঙ্ক, ৫ মিনিট, একবার, ৫ ভুলে ১৫ মিনিট লক, hash করে রাখা; কোড স্বাক্ষরকারীর Credence Mail ঠিকানায় যায়।
- **ডিজিটাল সার্টিফিকেট স্বাক্ষর (ঐচ্ছিক):** PKCS#7 (Adobe Reader-এ "Signed")। কেনা `.p12` (`ESIGN_CERT_FILE`) বা কোম্পানির self-signed (শুধু পরীক্ষার জন্য, Adobe-এ "validity unknown")।
- **যাচাই:** সাধারণ মানুষও `/verify/<code>` (QR) খুলে দেখতে পারে কে কখন সই করেছে, এবং ফাইল ফেলে মিলিয়ে দেখতে পারে।
- সব ঘটনা `document_events`-এ।

---

## ৮. নিরীক্ষা (Audit Trail)

| কী | কোথায় | কত দিন |
|---|---|---|
| ব্যর্থ/সফল লগইন চেষ্টা | `login_attempts` | ৩০ দিন পরে পরিষ্কার |
| পাসওয়ার্ড রিসেট অনুরোধ ও কোড | `password_reset_log`, `password_reset_requests` | — |
| অ্যাক্সেস বদল (কে কাকে কোন অনুমতি দিল, পাসওয়ার্ড রিসেট) | `user_access_audit` | — |
| Payroll: কে খুলল, কী করল | `payroll_access_log` | — |
| কর্মীর তথ্য বদল (আগের/পরের মান), বেতনের ব্যাংক/MFS অ্যাকাউন্ট যোগ-বদল-মোছা (কর্মীকে alert যায়) | `employee_change_log` | — |
| MPR entry সম্পাদনা/স্থায়ী মোছা | `entry_edit_history`, `entry_permanent_delete_log` | — |
| ই-স্বাক্ষর ঘটনা | `document_events` | — |
| Mail অ্যাডমিন কাজ | `mail_admin_log` | — |
| রিপোর্ট ইমেইল | `report_email_log` | — |
| Recruitment: interview-এর প্রতিটি বদল (আগের/নতুন সময় ও জায়গা, কারণ, কে) ও candidate-কে পাঠানো প্রতিটি email (কাকে, বিষয়, লেখা, পাঠানো/ব্যর্থ) | `candidate_interview_events`, `candidate_emails` | — |
| অনুমোদনে ad-hoc approver যোগ (কে, কাকে, কারণ) ও তাঁর সিদ্ধান্ত | `approval_requests.actions_json` (`adhoc_added`, `adhoc: true`) | — |
| Alerts — কখনো মোছা হয় না (মোছার API নেই; বেলের popup শুধু লুকায়) | `alerts` (`hidden_in_bell`) | — |
| সেশন | `user_sessions` (token hash, শেষ ব্যবহার) | ৩০ দিন অব্যবহৃত হলে পরিষ্কার |

---

## ৯. Secret ব্যবস্থাপনা

`.env` git-এ নেই (`.gitignore`: `.env*`, শুধু `.env.example` আছে); `.jwt-secret`-ও git-এ নেই। কোডে কোনো API key/পাসওয়ার্ড লেখা নেই (`GEMINI_API_KEY` / `GEMINI_API_KEYS`, `MAIL_ENCRYPTION_KEY`, `ESIGN_CERT_*`, `ERP360_APP_SECRET`, Firebase, SMTP সবই `.env`/পরিবেশ থেকে)।
**মনে রাখার:** `.env.example`-এ `ADMIN_PASSWORD="ChangeThisPassword123"`। লাইভে অবশ্যই বদলাবেন।

---

## ১০. জানা সীমাবদ্ধতা (সৎ তালিকা)

| # | সীমাবদ্ধতা | ঝুঁকি | করণীয় |
|---|---|---|---|
| ১ | **CORS** `CORS_ORIGINS` না দিলে সব সাইটের জন্য খোলা | মাঝারি | লাইভের `.env`-এ অবশ্যই দিন |
| ২ | সহজ পাসওয়ার্ড অনুমোদিত (কোম্পানির সিদ্ধান্ত) — অনুমান করা সহজ | মাঝারি (গ্রহণ করা ঝুঁকি) | লগইন আটকানো ও এক-ফোন নিয়ম চালু রাখুন; Superadmin/Payroll অ্যাকাউন্টে নিজেরা শক্ত পাসওয়ার্ড বা fingerprint/passkey ব্যবহার করুন। কড়া করতে চাইলে শুধু `passwordProblem` বদলান |
| ৩ | **CSP** শুধু frame/object/base সীমিত; `script-src` নেই | নিম্ন–মাঝারি | Vite বান্ডেলের সাথে মিলিয়ে ক্রমান্বয়ে কড়া করা |
| ৪ | সাধারণ API রেট লিমিট নেই (শুধু লগইন, reset, OTP-তে আছে) | নিম্ন–মাঝারি | Nginx `limit_req` বা middleware |
| ৫ | token ব্রাউজারের `localStorage`-এ | XSS হলে ঝুঁকি | XSS রোধ কড়া রাখা (আছে); দীর্ঘমেয়াদে HttpOnly কুকি |
| ৬ | ফাইল আপলোডে ধরন যাচাই সীমিত (ছবিতে আছে, ডকুমেন্টে আকার ছাড়া কম) | নিম্ন–মাঝারি | অনুমোদিত ধরন ও ভাইরাস স্ক্যান |
| ৭ | ফাইল ডাটাবেসে, রেস্টে এনক্রিপশন অ্যাপ করে না (ডিস্ক/ডাটাবেস এনক্রিপশন হোস্টিংয়ের ব্যাপার) | হোস্টিং-নির্ভর | সার্ভার ডিস্ক এনক্রিপশন, ব্যাকআপ এনক্রিপশন |
| ৮ | Superadmin নিজের payroll মাস নিজেই submit ও approve করতে পারে | নীতি | বড় অঙ্কে আলাদা ব্যক্তি লাগলে বদলানো |
| ৯ | Supervisor ও Template না থাকলে আবেদন অপেক্ষায় থাকে, শুধু Superadmin সিদ্ধান্ত দেন (তাঁর My Approvals-এ আসে; কর্মী "No approver set yet" দেখেন) | কার্যকারিতা | প্রধানদের Supervisor বা Template ঠিক করুন |
| ১০ | কর্মীর NID সব Employees-অ্যাডমিন দেখেন; Directory-তে সবার ফোন নম্বর | গোপনীয়তা নীতি | HR ঠিক করুক কে কী দেখবে |
| ১১ | বাইরের penetration test ও ব্যাকআপ/পুনরুদ্ধার পরীক্ষা এই ডকুমেন্টে নেই | — | নিচের "ডকুমেন্ট প্রস্তুতি" দেখুন |
| ১২ | e-sign-এর `node-forge`-এ একটি high দুর্বলতা (RSA স্বাক্ষর *যাচাই*), এখনো কোনো সংস্করণে ঠিক নেই | নিম্ন | অ্যাপ forge দিয়ে শুধু সার্টিফিকেট খোলে ও স্বাক্ষর দেয়, যাচাই করে না; নতুন সংস্করণ এলে আপডেট |
| ১৩ | ZKTeco Cloud push-এ (ADMS) মেশিনের কোনো গোপন চাবি নেই — শুধু Serial number ও (দিলে) IP দিয়ে চেনা হয় | নিম্ন–মাঝারি (ভুয়া punch) | সাইটের fixed IP "Only from this internet address"-এ দিন; HTTPS চালু রাখুন; Machines-এ আজকের punch সংখ্যা নজরে রাখুন |

---

## ১১. আমাদের নিজস্ব টেস্ট (প্রমাণ হিসেবে দেখানো যায়)

লগ: `docs/test-logs/2026-10-19/` ও `2026-10-25/`।

| টেস্ট | ফল (২৫ অক্টো) |
|---|---|
| HR ম্যানেজারের ২ বছর (১৬ কর্মী) | ২৮৪ পাস, ৪ ফেল (R-01) |
| একজন কর্মীর ৫ বছর | ৩৫৩ পাস, ১ ফেল (স্ক্রিপ্টের ভুল পথ) |
| নিরাপত্তা/নীতির "ভাঙার চেষ্টা" | ৫০ পাস, ৫ ফেল (উপরের সীমাবদ্ধতা ২, ১, ৬-এর অংশ) |
| প্রজেক্টের নিজস্ব `test:onboarding` / `test:hr-linkage` | ১০২ / ২৯ পাস, ০ ফেল |
| UI স্মোক (১০৪ পেজ) | ০ সমস্যা |
| একসাথে দুবার চাপ (`qa-concurrency`) | ৯ পাস, ০ ফেল (আগে ৫টা ফেল, ঠিক করা) |
| কোম্পানি আলাদা রাখা (`qa-companies`) | ১৮ পাস, ০ ফেল (আগে id দিয়ে অন্য কোম্পানির তথ্য পড়া/বদলানো যেত, ঠিক করা) |
| তারিখের কিনারা (`qa-dates`) | ১৫ পাস, ০ ফেল |
| বাংলা PDF/Excel (`qa-bangla-*`) | PDF-এ বাংলা ঠিক (আগে গোলমাল/"????"); Excel ৫ পাস |
| এক মাসের উপস্থিতি, ছুটি ও বেতন হাতে-কলমে হিসাবের সাথে মেলানো (`qa-month-reconcile`, ১০ জন, সেপ্টেম্বর ২০২৬) | ২৩ পাস, ০ ফেল; Excel-এ মেলানোর ফাইল তৈরি হয় |
| ফর্মে টাইপ ও ক্লিক করে (`qa-e2e-forms`, আসল ব্রাউজার) | ১০ পাস, ০ ফেল (লগইন, নতুন কর্মী, ছুটি আবেদন ও অনুমোদন, night shift সংশোধন) |
| বড় কোম্পানি (`qa-bigdata`, ৩০০০ ও ৫০০০ কর্মী) | ১৫ পাস, ০ ফেল (তালিকা < ০.৬ সে.; ৫০০০ জনের মাসের বেতন একবারে ২৪ সে.) |

এই টেস্টগুলো প্রতি push-এ GitHub-এ নিজে চলে: **QA tests** workflow (`.github/workflows/qa-tests.yml`, `tests/qa/run-all.sh`) — প্রতিটা টেস্ট নতুন খালি ডাটাবেসে; ফল Actions-এর "qa-results"-এ।

২৫ অক্টোবরের আগে ধরা এবং এখন **ঠিক হওয়া** জিনিস (প্রমাণসহ): কর্মী মুছলে payroll মোছা, Notice XSS, লগইনে সীমাহীন চেষ্টা, দ্বৈত ছুটি, পাসওয়ার্ড বদলের পরও পুরোনো token, JWT-র কোডে লেখা গোপন মান, HTML ত্রুটি-পাতা, ডাটাবেস-বার্তা প্রকাশ।

---

## ১২. দুর্ঘটনা ঘটলে কী করা যায় (প্রযুক্তিগত হাতিয়ার)

| পরিস্থিতি | হাতিয়ার |
|---|---|
| একজনের অ্যাকাউন্ট ঝুঁকিতে | Admin Panel → Users → Block (সব সেশন বন্ধ); পাসওয়ার্ড রিসেট |
| সন্দেহজনক সেশন | Active Users → Sign out |
| ফোন হারানো | Device Access → ফোন সরান |
| সবাইকে বের করা | `JWT_SECRET` বদলান (সবাই লগআউট) |
| কে কী করেছে | উপরের ৮ নম্বর অংশের লগ |
| কাউকে ডাটা দেখা বন্ধ | Module Access থেকে অনুমতি তুলুন (সঙ্গে সঙ্গে কার্যকর) |

- **Notification পরীক্ষা (`POST /api/web-push/test`):** login করা account শুধু নিজের phone/browser-এ test message পাঠাতে পারে (অন্যের নয়)। উত্তরে push service-এর (Apple/Google) host ও status code আসে, কোনো key বা token নয়। Profile → Notifications থেকে চালানো হয়।
