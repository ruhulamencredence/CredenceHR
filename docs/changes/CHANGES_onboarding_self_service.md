# New Joiner Onboarding (Self-Service) — What Was Added

Recruitment-এ কোনো candidate **Hired** হলে HR একটা "New Joiner Onboarding" খোলে।
জয়েনার একটা অস্থায়ী Onboarding ID (যেমন `ONB-0001`) দিয়ে ঢুকে নিজের তথ্য আর
ডকুমেন্ট দেয়। HR approve করলে এক transaction-এ আসল active Employee তৈরি হয়, আর
সেই login-টাই পূর্ণ account হয়ে যায়। **Approve-এর আগে মানুষটা `all_employees`-এ
থাকে না**, তাই কোনো dropdown, headcount, payroll বা attendance-এ দেখা যায় না।

---

## কোথায় কী

| জায়গা | কী আছে |
|---|---|
| Admin Panel → HR Operations → Onboarding → **New Joiners** | আবেদন খোলা, তালিকা, review পপআপ (Approve / Send back / Cancel), নতুন অস্থায়ী পাসওয়ার্ড |
| Admin Panel → HR Operations → Onboarding → **Checklist** | আগের মতোই (approve হলে নতুন Employee-র checklist নিজে থেকে শুরু হয়) |
| HR Operations → Settings | "New Joiner Onboarding": login কত দিন খোলা থাকবে, আবেদন-খোলা ব্যক্তি approve করতে পারবেন কিনা |
| জয়েনারের login | পুরো app-এর বদলে শুধু **My Onboarding** পেজ |

## ধাপগুলো

1. **HR আবেদন খোলে**
   - hired candidate বাছলে নাম/email/phone নিজে থেকে বসে, অথবা হাতে লেখা যায়।
   - designation, department, branch, joining date HR দেয়।
   - ফলাফল: `ONB-####` login আর একটা ১০ অক্ষরের পাসওয়ার্ড, যা **শুধু একবার** HR-কে দেখায়, Copy বোতামসহ।
   - হারালে "New password" দিয়ে নতুন একটা বানানো যায়। তাতে পুরনো পাসওয়ার্ড আর sign-in বন্ধ হয়ে যায়।
2. **জয়েনার ঢোকে**
   - ONB ID দিয়ে সাধারণ login পেজেই ঢোকে।
   - প্রথমে অস্থায়ী পাসওয়ার্ড বদলাতে হয়।
   - তারপর ফর্ম: Personal, Address, Emergency contact, Nominee, Documents।
   - Save draft করে পরে এসে শেষ করা যায়।
3. **Submit**
   - বাধ্যতামূলক তথ্য:
     - gender, date of birth, NID, mobile, present ও permanent address
     - অন্তত ১ জন emergency contact (ফোনসহ)
     - অন্তত ১ জন nominee (একাধিক হলে share মিলিয়ে ১০০%)
     - Settings-এর সব required documents
   - কিছু বাকি থাকলে সার্ভার Submit নেয় না।
   - Submit হলে ফর্ম লক হয়, মেয়াদ গোনা থামে, আর reviewer/approver, আবেদনকারী ও Superadmin alert পান।
4. **HR review**
   - জয়েনারের সব তথ্য আর ডকুমেন্ট দেখা যায়।
   - কোনো Employee বা login-এর সাথে NID, mobile বা email মিলে গেলে লাল সতর্কতা আসে, কার সাথে মিলেছে সেটাও।
5. **সিদ্ধান্ত**
   - **Approve:** নিচে দেখুন।
   - **Send back:** কারণ লিখতেই হয়। জয়েনার পেজে কারণটা দেখে, ঠিক করে আবার Submit করে। মেয়াদ নতুন করে শুরু হয়।
   - **Cancel:** login block হয়ে যায়, কোনো Employee তৈরি হয় না।
   - **মেয়াদ শেষ:** draft বা sent-back অবস্থায় মেয়াদ পেরোলে → `expired`, আর login block হয়। ঘণ্টায় একবার, সার্ভার চালু হলে, আর HR তালিকা খুললে যাচাই হয়।

Status-এর ধারা `hr_info_requests`-এর মতো:
`draft → submitted → approved | rejected (→ submitted আবার) | cancelled | expired`

## Approve — এক transaction, idempotent

`POST /api/hr-ops/joiner-onboarding/:id/approve`। পুরো কাজ একসাথে হয়, মাঝপথে কিছু ব্যর্থ হলে সব rollback হয়ে যায়।

1. আবেদন `FOR UPDATE` দিয়ে lock হয়।
   - আগেই approved হলে কিছু না করে `already_approved` ফেরত দেয়।
   - `submitted` না হলে 409।
2. বাকি তথ্য, আর NID/mobile/email-এর duplicate যাচাই। মিললে 409, সাথে কার সাথে মিলেছে তার তালিকা।
3. `nextEmployeeCode()` দিয়ে Employee ID নেওয়া হয়। company row lock থাকে, তাই একসাথে দুটো approve-এ একই ID পড়ে না।
4. `all_employees` INSERT: `is_active = 1`, joining date, designation, department, branch, আর জয়েনারের ব্যক্তিগত field।
5. **সেই একই** `users` row-ই Employee-র login হয়:
   - `username` = Employee ID, `email` = personal email
   - `is_onboarding = 0`, `must_change_password = 1`
6. ডকুমেন্ট → `employee_documents` (Document Vault), একই `user_id`।
7. Emergency contact ও nominee → `hr_emp_family`। একই মানুষ দুই তালিকায় থাকলে এক সারি হয়।
8. Onboarding checklist + default probation (`startOnboardingChecklist()`)। পুরনো "Start" বোতামও এটাই ডাকে।
9. আবেদন `approved` হয়, `employee_id` বসে।
10. `employee_change_log`-এ লেখা হয় "Created from onboarding ONB-####"।

**Commit-এর পরে** (এগুলো ব্যর্থ হলেও approve বাতিল হয় না):
- পুরনো সব session শেষ হয়।
- **শুধু Superadmin approve করলে** default access template বসে। অন্য কেউ করলে access HR নিজে দেবেন।
- নতুন Employee "Welcome — your Employee ID is …" alert পায়, আবেদনকারী HR-ও alert পান।

নতুন Employee প্রথম login-এ নতুন পাসওয়ার্ড বসানোর পপআপ পায় (`must_change_password`)।

## নিরাপত্তা — সীমিত token

`users.is_onboarding = 1` হলে (token-এর `onb` claim **বা** DB flag, যেকোনো একটা) `authenticateToken` শুধু এগুলো ছাড়ে:

- `/api/onboarding/me` আর তার নিচের path
- `GET /api/auth/me`, `POST /api/auth/logout`
- `PUT /api/profile/password`, `GET/POST /api/profile/photo`, আর `GET /api/profile/photo/<নিজের id>`

বাকি সব path পায় **403 `ONBOARDING_ONLY`**। অনুমতির তালিকা (`onboardingPathAllowed()`) `..`, `//`, `\`, `;`, control character, ভুল encoding আর বড়-ছোট হাতের অক্ষরের চালাকি সবই প্রত্যাখ্যান করে।

বাড়তি সুরক্ষা হিসেবে এগুলোও onboarding login আটকায়:
- `requireAdmin` / `requireSuperAdmin` / `requireModule` / `requireModuleLayer` / `hasModuleLayer`
- Chat socket (chat ও call)

জয়েনারের পেজ মূল app-এর বদলে আলাদা shell (`main.tsx`) হিসেবে চলে। তাই alerts, push, tracking বা chat-এর কোনো API ডাকা হয় না।

## Permission (CLAUDE.md অনুযায়ী)

`hr_operations` মডিউলে layer যোগ হয়েছে। মডিউলটা এখন `PERMISSION_LAYER_MODULES`-এ।

| Layer | কী দেয় | ডিফল্ট |
|---|---|---|
| `read` | HR Operations আগের মতো | layer সেভ না থাকলে শুধু এটা |
| `onboarding_create` | আবেদন খোলা, নতুন পাসওয়ার্ড | explicit-only |
| `onboarding_review` | দেখা, Send back, Cancel | explicit-only |
| `onboarding_approve` | Approve (Employee তৈরি) | explicit-only |

- তিনটা নতুন layer `EXPLICIT_ONLY_LAYERS`-এ আছে, আর no-saved-layers ডিফল্টে নেই।
- আগে যাদের HR Operations ছিল তাদের বাকি সব আগের মতোই চলে, কিন্তু onboarding-এর কিছু টিক ছাড়া পায় না।
- Superadmin সবসময় সব পায়।
- UI লুকানো থাকে, API-ও আটকায়।
- **"Whoever opens an application can't approve it"** (Settings, ডিফল্ট চালু): আবেদনকারী নিজে approve করতে পারেন না। Superadmin-এর জন্য এই নিয়ম খাটে না।

## ফাইল

**নতুন:**
- `OnboardingSelfServiceRoutes.ts`: schema, সীমিত-token helper, joiner ও HR API, approve transaction, expiry
- `src/components/OnboardingShell.tsx`: জয়েনারের My Onboarding পেজ
- `src/components/OnboardingForm.tsx`: ফর্ম আর HR-এর জন্য শুধু-পড়ার সারাংশ
- `src/components/HrOpsJoinerOnboarding.tsx`: HR-এর New Joiners তালিকা, তৈরির ও review পপআপ
- `tests/onboarding.test.ts`

**বদলানো:**
- `server.ts`: guard, layer, wiring
- `AuthRoutes.ts`: মেয়াদ যাচাই, `onb` claim, নতুন field
- `profileRoutes.ts`: পাসওয়ার্ড বদলালে `must_change_password` মোছে
- `schemaMigrations.ts`
- `ChatRoutes.ts`: socket guard
- `HROperationsRoutes.ts`: `startOnboardingChecklist()`, settings key
- `src/types.ts`, `src/main.tsx`, `src/App.tsx`
- `HrOpsOnboarding.tsx`, `HrOpsSettings.tsx`, `AlertsBell.tsx`, `AlertsPage.tsx`
- `package.json`: `test:onboarding`

**DB** (সার্ভার চালু হলে নিজে থেকে তৈরি হয়, হাতে SQL চালাতে হয় না):
- `users.is_onboarding`, `users.must_change_password`, `users.onboarding_expires_at`
- `onboarding_applications`, `onboarding_documents`
- `hr_ops_settings`-এর key: `onboarding_expiry_days` (14), `onboarding_creator_cannot_approve` (1)

## Test

```
npm run test:onboarding
```

- **Unit** (সবসময় চলে): path allowlist (অনুমোদিত আর প্রত্যাখ্যাত path), ফর্মের যাচাই।
- **Integration** (চালু সার্ভারের বিরুদ্ধে, **শুধু test DB-তে**, কারণ এগুলো data বানায়):
  - onboarding token-এ ৪৪টা সাধারণ endpoint-এ 403 `ONBOARDING_ONLY`
  - cancel হওয়া login বন্ধ
  - duplicate NID/mobile/email আটকানো ও কার সাথে মিলেছে দেখানো
  - দুবার বা একসাথে approve করলে একটাই Employee
  - Approve-এর ২, ৪, ৬, ৮, ১০ ধাপের পরে জোর করে ব্যর্থ করালে পুরো rollback
  - layer ছাড়া প্রতিটা HR route-এ 403
  - নিজের খোলা আবেদন নিজে approve করা যায় না
  - review layer দিয়ে Send back করা যায়, approve করা যায় না
- **Environment variable:**
  - `ONB_TEST_BASE`, `ONB_TEST_WORKSPACE`
  - `ONB_TEST_ADMIN_EMAIL`/`_PASSWORD`
  - `ONB_TEST_HR_EMAIL`/`_PASSWORD`: একটা সাধারণ account। test সেটাকে layer দেয়, শেষে আগের Module Access ফিরিয়ে দেয়।
  - `ONB_TEST_SERVER_TEST_MODE=1`: rollback test-এর জন্য সার্ভার `NODE_ENV=test`-এ চালাতে হবে। তখন `X-Onboarding-Test-Fail-After` header কাজ করে। অন্য কোনো environment-এ header-টা উপেক্ষিত হয়।
- সার্ভার না পেলে integration test skip হয়।

## সীমাবদ্ধতা / জানা বিষয়

- **পাসওয়ার্ড:** অস্থায়ী পাসওয়ার্ড SMS বা email-এ যায় না। HR নিজে জয়েনারকে দেন।
- **দুবার পাসওয়ার্ড বদল:** Approve-এর পর `must_change_password = 1` রাখা হয়েছে, তাই জয়েনার onboarding-এ একবার আর Employee হয়ে আরেকবার পাসওয়ার্ড বদলান। এই নিয়ম শুধু app-এর পপআপ দিয়ে চলে, সার্ভার অন্য API আটকায় না।
- **Send back-এর খবর:** জয়েনার alert পান না (onboarding login alert পড়তে পারে না)। পরের বার ঢুকলে পেজে কারণ দেখেন।
- **Database:** Approve আর আবেদন খোলা MySQL transaction ছাড়া হয় না, memory-DB fallback-এ "needs the MySQL database" দেখায়।
- **Appointment Letter (signed):** HR Ops Settings-এর ডিফল্ট required documents-এ এটা আছে, তাই জয়েনারকে Submit-এর আগে এটাও দিতে হয়। না চাইলে Settings থেকে লাইনটা সরান।
- **যাচাই হয়নি:** আসল Android app দিয়ে জয়েনারের login (Device Access/location), আর production MySQL-এর collation/`max_allowed_packet`।
