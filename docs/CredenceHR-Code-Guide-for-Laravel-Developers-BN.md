# CredenceHR কোড গাইড — Laravel ডেভেলপারদের জন্য (বাংলায়)

এই লেখাটা পড়লে আপনি বুঝবেন CredenceHR প্রজেক্টের কোড কোথায় কী আছে, আর কোন পেজ কীভাবে কাজ করে।
সবকিছু Laravel-এর MVC-র সাথে মিলিয়ে বোঝানো হয়েছে।

---

## ১. প্রথমে বড় ছবিটা

Laravel-এ আপনি একটা প্রজেক্টে PHP (backend) আর Blade (view) একসাথে লেখেন।
CredenceHR-এ দুটো আলাদা অংশ আছে:

| অংশ | কী দিয়ে বানানো | Laravel-এ সমান কী |
|---|---|---|
| **Backend (API)** | Node.js + Express + TypeScript | Laravel-এর `routes/api.php` + Controller + Middleware |
| **Frontend (পেজ)** | React + Vite + Tailwind CSS | Blade view + JavaScript (Inertia/Vue-র মতো SPA) |
| **ডাটাবেস** | MySQL / MariaDB | MySQL |
| **মোবাইল অ্যাপ** | Capacitor (`android/`, `ios/` ফোল্ডার) | (Laravel-এ নেই) |

**সবচেয়ে বড় পার্থক্য তিনটি:**

1. **Blade নেই।** সার্ভার HTML বানিয়ে পাঠায় না। সার্ভার শুধু JSON পাঠায় (`res.json(...)`)।
   পেজ আঁকে React, ব্রাউজারের ভেতরে।
2. **Eloquent / ORM নেই।** সরাসরি SQL লেখা হয়: `queryDB("SELECT ... WHERE id = ?", [id])`।
3. **Controller ফাইল আলাদা আলাদা Class নয়।** প্রতিটি ফিচারের জন্য একটা ফাইল, যার ভেতরে
   `app.get(...)`, `app.post(...)` লাইনগুলো সরাসরি লেখা। এই ফাইলই Route আর Controller দুটোর কাজ করে।

---

## ২. ফোল্ডার ম্যাপ

```
CredenceHR/
├── server.ts                  ← Backend-এর প্রবেশদ্বার (Laravel-এর bootstrap/app.php + AppServiceProvider)
├── *Routes.ts  (৭০+ ফাইল)      ← Route + Controller (যেমন LeaveRoutes.ts, PayrollRoutes.ts)
├── *Engine.ts, Alerts.ts ...  ← Service / Helper ক্লাসের মতো (ব্যবসার হিসাব)
├── schema.sql                 ← মূল টেবিলের SQL (Migration-এর শুরুর অংশ)
├── schemaMigrations.ts        ← সব ensure*Schema() ডাকে (Migration runner)
├── companyScope.ts            ← মাল্টি-কোম্পানি ফিল্টার (Global Scope-এর মতো)
├── companyContext.ts          ← এখন কোন কোম্পানিতে কাজ হচ্ছে (request-এর context)
├── jobRunner.ts               ← Background job / Scheduler
├── mailer.ts, WebPushService.ts, PushNotificationService.ts  ← Mail, Push (Notification)
├── .env / .env.example        ← কনফিগ (Laravel-এর .env-এর মতো)
├── package.json               ← composer.json-এর মতো (npm প্যাকেজ আর কমান্ড)
├── tests/                     ← টেস্ট
├── docs/                      ← ডকুমেন্ট (এই ফাইল সহ)
├── CHANGES_*.md               ← কোন ফিচারে কী বদলেছে তার লগ
├── CLAUDE.md                  ← প্রজেক্টের নিয়ম (নতুন ফিচারে permission বাধ্যতামূলক ইত্যাদি)
│
├── src/                       ← Frontend (এখানেই সব পেজ)
│   ├── main.tsx               ← Frontend-এর শুরু (public/index.php + app.js-এর মতো)
│   ├── App.tsx                ← মূল Layout + পেজ বদলের ব্যবস্থা (Router-এর কাজ)
│   ├── types.ts               ← ডাটার আকার (Resource / DTO-এর মতো) + permission তালিকা
│   ├── index.css              ← Tailwind + liquid-glass স্টাইল
│   ├── components/ (~২৫০ ফাইল) ← প্রতিটি পেজ/পপআপ/কার্ড (Blade view / component)
│   └── lib/                   ← Helper ফাংশন (api.ts, confirmDialog.tsx, adminUrl.ts ...)
│
├── dist/                      ← build-এর ফল (php artisan optimize-র মতো; হাতে বদলাবেন না)
├── deploy/nginx.conf.example  ← সার্ভারে nginx কনফিগ
└── ecosystem.config.cjs       ← PM2 কনফিগ (production-এ প্রসেস চালানো, Supervisor-এর মতো)
```

> **মনে রাখুন:** `server.ts` প্রায় ৩,০০০ লাইন আর `src/components/AdminPanel.tsx` প্রায় ৯,০০০ লাইন। ফাইল বড় বলে ঘাবড়াবেন না।
> খুঁজে নিতে `Ctrl+F` বা `grep` ব্যবহার করুন। নিচে কোথায় কী খুঁজবেন তা বলা আছে।

---

## ৩. একটা রিকোয়েস্ট কীভাবে চলে (Request Lifecycle)

```
ব্রাউজার (React পেজ)
   │  fetch('/api/leave-applications', { headers: { Authorization: 'Bearer <token>' } })
   ▼
server.ts → Express app
   │  app.use(cors, compression, express.json)            ← গ্লোবাল Middleware
   ▼
Route লাইন, যেমন:
   app.post("/api/leave-applications", authenticateToken, requireLeaveApplicationAccess, async (req, res) => { ... })
              ▲ Route path            ▲ Middleware ১         ▲ Middleware ২              ▲ Controller-এর কাজ
   ▼
Handler-এর ভেতরে:
   ১. req.body পড়া ও ভ্যালিডেশন (হাতে লেখা `if (!x) return res.status(400)...`)
   ২. queryDB("INSERT ...")  → ডাটাবেস
   ৩. createAlert(...)       → Notification
   ৪. res.json({ success: true })
   ▼
ব্রাউজারে JSON ফেরত → React স্টেট বদলায় → পেজ নতুন করে আঁকে
```

**Laravel-এর সাথে তুলনা:**

| এখানে | Laravel-এ |
|---|---|
| `app.post("/api/...", mw1, mw2, handler)` | `Route::post('/api/...', [Controller::class,'store'])->middleware([...])` |
| `req.body` | `$request->all()` |
| `req.user` (JWT থেকে) | `$request->user()` / `auth()->user()` |
| `res.json({...})` | `return response()->json([...])` |
| `res.status(400).json({ error: "..." })` | `abort(422, '...')` / ValidationException |
| `await queryDB(sql, params)` | `DB::select(sql, params)` |

**Error-এর আকার:** সব জায়গায় একই: `{ "error": "বার্তা" }`। Frontend এই `error` ফিল্ড দেখিয়ে দেয়।

---

## ৪. MVC-র মাপে কোড কোথায়

### 4.১ Model (ডাটা ও ডাটাবেস)

- **Eloquent Model নেই।** প্রতিটি টেবিলের জন্য আলাদা Model ক্লাস নেই।
- টেবিলের গঠন দেখতে: `schema.sql` (মূল ~৬০টি টেবিল) আর প্রতিটি `XxxRoutes.ts`-এর ওপরের দিকে থাকা `ensureXxxSchema()` ফাংশন।
- ডাটা পড়া-লেখা হয় `queryDB()` দিয়ে (এটা `server.ts`-এ ১৯৬৩ নম্বর লাইনের কাছে)। এর ভেতরে `mysql2`-র prepared statement চলে। তাই `?` দিয়ে প্যারামিটার দিন, SQL-এ সরাসরি ভ্যালু বসাবেন না।

```ts
// Laravel: LeaveApplication::where('user_id', $id)->get();
const rows = await queryDB("SELECT * FROM leave_applications WHERE user_id = ?", [req.user.id]);
```

- তারিখ সবসময় `"YYYY-MM-DD"` স্ট্রিং হিসেবে আসে (`dateStrings: true`)। Carbon-এর মতো কিছু নেই।
- `users` টেবিল হলো **লগইন অ্যাকাউন্ট**। `all_employees` টেবিল হলো **কর্মীর তথ্য** (HR ডাটা)। দুটো আলাদা। একজন কর্মীর `user_id` দিয়ে লগইনের সাথে লিংক থাকে।
- **Frontend-এ ডাটার আকার** বোঝাতে `src/types.ts` (TypeScript interface)। এটা Laravel-এর API Resource-এর কাছাকাছি।

### 4.২ Migration

| Laravel | এখানে |
|---|---|
| `php artisan migrate` | সার্ভার চালু হওয়ার সময় নিজে থেকে চলে (`schemaMigrations.ts` → প্রতিটি `ensure*Schema`) |
| `Schema::create(...)` | `CREATE TABLE IF NOT EXISTS ...` |
| নতুন কলাম যোগ | `ALTER TABLE ... ADD COLUMN`, আর `ER_DUP_FIELDNAME` error হলে চুপ করে থাকে |
| migrations টেবিল, rollback | **নেই।** প্রতিবার চালু হলে সব `ensure*` আবার চলে, তাই সেগুলো বারবার চালানো গেলেও ক্ষতি হয় না |
| Seeder | `seedAdminFromEnv()` (`.env`-এর `ADMIN_EMAIL`/`ADMIN_PASSWORD` থেকে Superadmin বানায়) |

### 4.৩ Controller + Route

প্রতিটি ফিচারের জন্য একটা `XxxRoutes.ts` ফাইল। এর গঠন সবসময় একরকম:

```ts
export async function ensureXxxSchema(dbPool) { ... }        // Migration

export function registerXxxRoutes(app, deps) {               // Controller + Route
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;   // ← Dependency Injection

  app.get("/api/xxx", authenticateToken, requireAdmin, requireModule("xxx"), async (req, res) => { ... });
  app.post("/api/xxx", ...);
  app.put("/api/xxx/:id", ...);
  app.delete("/api/xxx/:id", ...);
}
```

`server.ts` এই `registerXxxRoutes(app, {...})` ফাংশনগুলোকে ডেকে সবকিছু জুড়ে দেয়
(Laravel-এর `RouteServiceProvider` যেভাবে route ফাইল লোড করে)। `deps` হলো shared helper-এর বান্ডিল।
এই কারণে route ফাইল আলাদা হলেও একই `queryDB`, `authenticateToken` ব্যবহার করে।

#### কোন ফিচার কোন ফাইলে

| ফিচার | Backend ফাইল | Frontend ফাইল |
|---|---|---|
| লগইন, রেজিস্টার, `/auth/me` | `AuthRoutes.ts` | `AuthScreen.tsx` |
| ইউজার ও পারমিশন ব্যবস্থাপনা | `UserManagement.ts` | `AdminPanel.tsx` (Users ট্যাব), `UserAccessDrawer.tsx` |
| ছুটি (Leave) | `LeaveRoutes.ts` | `NewLeaveApplicationModal.tsx`, `LeaveManage.tsx`, `ApproveApplications.tsx` |
| Approval (অনুমোদন চেইন) | `ApprovalRoutes.ts` | `ApprovalManager.tsx`, `ApproveApplicationPage.tsx` |
| Attendance (দূরবর্তী) | `AttendanceRoutes.ts` | `AttendanceCard.tsx` |
| অফিস attendance, ZK ডিভাইস | `OfficeAttendanceRoutes.ts`, `zkSync.ts` | `AdminPanel.tsx` |
| সাইট attendance | `SiteAttendanceRoutes.ts` | `SiteAttendanceAdmin.tsx` |
| Duty Roster | `RosterRoutes.ts` | `DutyRoster.tsx`, `MyRoster.tsx` |
| বেতন (Payroll) | `PayrollRoutes.ts`, `PayrollItemsRoutes.ts`, `PayrollApprovalRoutes.ts` | `RunPayrollWizard.tsx`, `SalaryStructureSetupPanel.tsx` |
| পেস্লিপ | `PayslipRoutes.ts` | `MyPayslips.tsx` |
| Movement Claim | `MovementClaimRoutes.ts` | `ClaimsPanel.tsx`, `NewConveyanceClaimModal.tsx` |
| Conveyance Bill Claim | `ConveyanceBillClaimRoutes.ts`, `BillClaimPolicy.ts` | `ConveyanceBillPanel.tsx`, `DisbursementPanel.tsx` |
| কর্মী তালিকা | `EmployeeRoutes.ts`, `EmployeeDirectoryRoutes.ts` | `EmployeesPanel.tsx`, `EmployeeDirectory.tsx` |
| HR Operations (চিঠি, বদলি, ইত্যাদি) | `HROperationsRoutes.ts`, `HrOps*Routes.ts` | `HrOps*.tsx` |
| Notice | `NoticeRoutes.ts` | `NoticeManager.tsx`, `NoticePopup.tsx` |
| Document Vault + E-Signature | `DocumentVaultRoutes.ts`, `ESignRoutes.ts` | `DocumentVaultPanel.tsx`, `SendForSigningButton.tsx` |
| Chat (রিয়েলটাইম) | `ChatRoutes.ts` | `ChatPanel.tsx` |
| Credence Mail | `MailRoutes.ts`, `mailer.ts` | `src/components/mail/` |
| Tracking (লাইভ লোকেশন) | `EmployeeTrackingRoutes.ts`, `LiveTrackingRoutes.ts` | `EmployeeTrackingPanel.tsx` |
| Asset, Vehicle | `AssetManagementRoutes.ts`, `VehicleManagementRoutes.ts` | `AssetManagement*.tsx`, `VehicleManagement*.tsx` |
| Recruitment, Performance, Grievance, Exit | `RecruitmentRoutes.ts`, `PerformanceRoutes.ts`, `GrievanceRoutes.ts`, `ExitOffboardingRoutes.ts` | `*Panel.tsx` |
| Task, Target, Mobile Bill | `TaskRoutes.ts`, `TargetRoutes.ts`, `MobileBillRoutes.ts` | `TaskManagement.tsx`, `TargetReports.tsx`, `MobileBill*.tsx` |
| PEPM (MPR, Job, Budget) | `EntriesRoutes.ts`, `ProjectRoutes.ts`, `BudgetImportRoutes.ts` | `AdminPanel.tsx`, `UserPanel.tsx`, `JobEditPanel.tsx` |
| Measurement Sheet (নতুন) | `MeasurementRoutes.ts`, `MeasurementEngine.ts` | `MeasurementSheet.tsx` |
| Report / Analytics | `ReportsInsightsRoutes.ts`, `HRAnalyticsRoutes.ts` | `ReportsInsights.tsx`, `HRAnalyticsDashboard.tsx` |
| কোম্পানি (multi-company) | `CompanyRoutes.ts` | `CompanySwitcher.tsx`, `SystemCompanies.tsx` |

### 4.৪ Middleware (তিনটি স্তর)

সব `server.ts`-এ (২০৩৭ নম্বর লাইনের পর) আছে।

| নাম | কাজ | Laravel-এ কাছাকাছি |
|---|---|---|
| `authenticateToken` | `Authorization: Bearer <JWT>` পড়ে ইউজার চেনে। ব্লক হওয়া/মুছে ফেলা অ্যাকাউন্ট হলে ঢুকতে দেয় না। কোন কোম্পানিতে কাজ হচ্ছে তাও ঠিক করে | `auth:sanctum` |
| `requireAdmin` | শুধু `admin` বা `superadmin` | `role:admin` Middleware |
| `requireModule("leave_applications")` | ওই Admin Panel মডিউলের অনুমতি আছে কি না | `can:module-access` Gate |
| `requireModuleLayer("payroll", "salary_hold")` | মডিউলের ভেতরের নির্দিষ্ট কাজের অনুমতি (আরও সূক্ষ্ম স্তর) | `$this->authorize('salary-hold')` Policy ability |

### 4.৫ Authentication ও Authorization

- **Authentication:** লগইন করলে সার্ভার একটা **JWT token** দেয় (`AuthRoutes.ts`)। Frontend এটা `localStorage`-এ রাখে (`mpr_token`) এবং প্রতিটি রিকোয়েস্টে পাঠায়। Laravel-এর session নেই।
- **Role:** তিনটি: `superadmin` (সব পারে, `.env` থেকে তৈরি), `admin` (শুধু যে মডিউল দেওয়া হয়েছে), `user` (সাধারণ কর্মী)।
- **Module Access:** `admin_module_permissions` টেবিলে লেখা থাকে কোন Admin কোন মডিউল পাবে। তালিকা `ADMIN_MODULE_KEYS` (server.ts) আর `ADMIN_MODULES` (src/types.ts)।
- **Layer:** মডিউলের ভেতরে আরও ভাগ, যেমন `read`, `edit_add`, `delete_trash`, `salary_hold`। কিছু layer **explicit only**, মানে কেউ টিক না দিলে পায় না।
- **নিয়ম (CLAUDE.md):** নতুন যেকোনো ফিচার, মেনু, বোতাম বা API route-এর পেছনে permission থাকতে **হবে**। UI লুকানো আর API বন্ধ, দুটোই করতে হয়।

### 4.৬ Multi-company (একই ডাটাবেসে একাধিক কোম্পানি)

- Laravel-এ যেমন Global Scope দিয়ে `where company_id = ?` যোগ হয়, এখানে `companyScope.ts` সেটা **SQL স্ট্রিং বদলে** করে। `queryDB` চালানোর আগে `scopeSql(sql)` নিজে থেকে কোম্পানির ফিল্টার বসিয়ে দেয়।
- কোন কোম্পানি তা আসে ব্রাউজারের `X-Company-Id` header থেকে। এটা request-এর পুরো সময়ের জন্য `AsyncLocalStorage`-এ থাকে (`companyContext.ts`)।
- **তাই নতুন টেবিল বানালে** `companyScope.ts`-এর কোন তালিকায় (`OWN_TABLES`, `EMPLOYEE_TABLES` ইত্যাদি) পড়বে তা ঠিক করতে হয়। না করলে এক কোম্পানির ডাটা অন্য কোম্পানিতে দেখা যেতে পারে।

### 4.৭ বাকি Laravel ধারণার মিল

| Laravel | এখানে |
|---|---|
| Queue / Job / Scheduler | `jobRunner.ts` (রিমাইন্ডার, ছুটির বছর শেষ, ZK sync ইত্যাদি)। একাধিক প্রসেসে শুধু একটাতে চলে |
| Notification (database) | `Alerts.ts` → `createAlert(...)`, Frontend-এ `AlertsBell.tsx` |
| Push notification | `WebPushService.ts`, `PushNotificationService.ts` |
| Mail | `mailer.ts` (SMTP) |
| Broadcasting / Echo | Socket.IO (`server.ts` ~২৮৩৭ লাইন, `ChatRoutes.ts`) |
| Storage / ফাইল আপলোড | Multer বা `storage/` ফোল্ডার নেই। ফাইল **base64 হয়ে JSON-এর ভেতরে** আসে (`file_base64`, `file_name`) এবং ডাটাবেসে (BLOB/টেক্সট কলামে) রাখা হয়। তাই `express.json` সীমা ২৫MB |
| Config / `.env` | `.env` (`DB_*`, `JWT_SECRET`, `PORT`, `ADMIN_*`) |
| Config cache / Optimize | `npm run build` |
| Tinker | নেই |
| Service Class | `*Engine.ts`, `BillClaimPolicy.ts`, `Alerts.ts` ইত্যাদি। এগুলোতে Route নেই, শুধু হিসাব |

---

## ৫. View (Frontend) — Blade-এর বদলে React

### 5.১ পেজ বদল কীভাবে হয়

Laravel-এ URL → Route → Controller → View। এখানে **URL দিয়ে পেজ ঠিক হয় না** (react-router ব্যবহার হয়নি)। পেজ ঠিক হয় **React স্টেট দিয়ে**।

```
src/main.tsx          → App.tsx চালু করে
src/App.tsx           → ইউজার লগইন করা আছে কি না দেখে
   ├─ না থাকলে        → <AuthScreen />                       (লগইন পেজ)
   └─ থাকলে
       ├─ viewMode = 'user'  → <UserPanel />                  (কর্মীর Self Service)
       └─ viewMode = 'admin' → <AdminPanel />                 (Admin Panel)
       + সবসময়: <GlobalSidebar /> (ডান/বাঁ মেনু), <Navbar />, <BottomNav /> (মোবাইল)
```

- **`GlobalSidebar.tsx`:** মেনুর তালিকা। প্রতিটি আইটেম `canSeeModule('xxx')` দিয়ে ছাঁকা, মানে permission না থাকলে মেনুতে আসে না।
- **`AdminPanel.tsx`:** এর ভেতরে `activeTab` স্টেট আছে। `activeTab === 'duty_roster'` হলে `<DutyRoster />` আঁকে। প্রতিটি ট্যাব এভাবে আলাদা component।
- **`UserPanel.tsx`:** কর্মীর ড্যাশবোর্ড (Attendance কার্ড, Leave Summary, Pending Approvals ইত্যাদি)।
- **URL:** শুধু সুবিধার জন্য। `/admin/duty-roster` খুললে `activeTab = 'duty_roster'` হয়। নিয়ম `src/lib/adminUrl.ts`-এ। Self Service-এর জন্য `src/lib/selfUrl.ts`। সার্ভার পেছনে সব URL-এ একই `index.html` পাঠায়।

### 5.২ Component = Blade partial/component

- `src/components/*.tsx` প্রতিটি একটা পেজ, কার্ড বা পপআপ।
- নামের ধরন: `XxxPanel.tsx` (বড় পেজ), `XxxModal.tsx` (পপআপ), `XxxCard.tsx` (ছোট কার্ড)।
- `props` = Blade component-এ পাঠানো attribute। `useState` = পেজের ভেতরের ভ্যারিয়েবল। `useEffect` = পেজ খুললে যে কোড চলে (যেমন API ডাকা)।

### 5.৩ API ডাকা

বেশিরভাগ component নিজেই `fetch` করে:

```tsx
const res = await fetch(apiUrl('/api/leave-balances/mine'), { headers: { Authorization: `Bearer ${token}` } });
const data = await res.json();
if (!res.ok) throw new Error(data.error);
setBalance(data);
```

`token` আসে `App.tsx` থেকে প্রতিটি component-এ props হিসেবে।

### 5.৪ স্টাইল ও পপআপ (নিয়ম)

- Tailwind CSS ক্লাস সরাসরি HTML-এ। `src/index.css`-এ `.liquid-glass*` ক্লাস আছে।
- **সব পপআপ** একই "liquid glass" ধরনের। `window.confirm()` ব্যবহার নিষেধ, বদলে `await confirmDialog("বার্তা")` (`src/lib/confirmDialog.tsx`)।

---

## ৬. পুরো উদাহরণ: "ছুটির আবেদন" কীভাবে চলে

1. কর্মী **UserPanel → Leave & Attendance** মেনুতে ঢোকেন।
2. "নতুন আবেদন" চাপলে `NewLeaveApplicationModal.tsx` খোলে। খোলার সময় সে `GET /api/leave-balances/mine`, `/api/leave-categories`, `/api/leave-policies`, `/api/leave-applications/relievers` ডেকে ডাটা আনে।
3. কর্মী ফর্ম পূরণ করে সাবমিট করেন → `POST /api/leave-applications`।
4. `LeaveRoutes.ts` (প্রায় ৯৯১ লাইন): Middleware `authenticateToken` + `requireLeaveApplicationAccess` চলে।
5. Handler যাচাই করে: ছুটির ধরন ঠিক আছে? তারিখ ঠিক আছে? কারণ আছে? Reliever বাছা হয়েছে? ব্যালেন্সে কুলাবে?
   ভুল হলে `res.status(400).json({ error: "..." })`, আর modal সেই বার্তা দেখায়।
6. ঠিক থাকলে `INSERT INTO leave_applications ...`, তারপর অনুমোদনকারীর জন্য `createAlert(...)`।
7. অনুমোদনকারীর কাছে আবেদন দেখায় `ApproveApplications.tsx` (`GET /api/my-approvals`)।
8. তিনি Approve/Reject চাপলে `POST /api/my-approvals/:id/act` (`ApprovalRoutes.ts`)। চেইনের শেষ ধাপ হলে ছুটির স্ট্যাটাস বদলায়, ব্যালেন্স কাটে।

---

## ৭. নতুন ফিচার যোগ করার ধাপ (Laravel-এর `make:` কমান্ডের বদলে)

উদাহরণ হিসেবে সদ্য বানানো **Measurement Sheet** দেখুন (PEPM Management-এর নতুন মেনু):

| ধাপ | কী করতে হয় | Measurement Sheet-এ কোথায় |
|---|---|---|
| ১ | `XxxRoutes.ts` ফাইল: `ensureXxxSchema` + `registerXxxRoutes` | `MeasurementRoutes.ts` |
| ২ | ব্যবসার হিসাব আলাদা ফাইলে (ঐচ্ছিক) | `MeasurementEngine.ts` |
| ৩ | `server.ts`-এ import, `ensure...` ডাকা, `register...` ডাকা | `server.ts` (৫৩, ২২৭, ২৯৪৪ লাইনের কাছে) |
| ৪ | মডিউলের নাম `ADMIN_MODULE_KEYS` আর `PERMISSION_LAYER_MODULES`-এ, layer তালিকা `MODULE_LAYER_KEY_SETS`-এ | `server.ts` |
| ৫ | একই নাম Frontend-এ: `AdminModuleKey`, `ADMIN_MODULES`, `MODULE_LAYER_OPTIONS` | `src/types.ts` |
| ৬ | URL আর পাথ: `ADMIN_TAB_KEYS`, `modulePaths` | `src/lib/adminUrl.ts`, `src/lib/modulePaths.ts` |
| ৭ | মেনুতে আইটেম | `GlobalSidebar.tsx` |
| ৮ | Admin Panel-এ ট্যাব ও Module Access গ্রুপ | `AdminPanel.tsx` |
| ৯ | পেজের component | `src/components/MeasurementSheet.tsx` |
| ১০ | নতুন টেবিল কোন কোম্পানি-তালিকায় পড়বে | `companyScope.ts` |
| ১১ | পরীক্ষা, তারপর commit | — |

---

## ৮. চালানো, বিল্ড ও ডিপ্লয়

```bash
npm install          # composer install-এর মতো
npm run dev          # tsx server.ts → Backend চালু; Vite এর ভেতরেই Frontend দেয় (একই পোর্টে)
npm run build        # Frontend → dist/ ; Backend → dist/server.cjs
npm start            # node dist/server.cjs  (production)
npm run pm2:start    # PM2 দিয়ে (ecosystem.config.cjs)
npm run lint         # tsc --noEmit (শুধু টাইপ চেক)
```

- **dev-এ** একটাই কমান্ড, একটাই পোর্ট (`.env`-এর `PORT`, না থাকলে 3000)। আলাদা `npm run dev` Frontend/Backend-এর দরকার নেই।
- **production-এ** nginx (`deploy/nginx.conf.example`) সামনে থাকে, পেছনে PM2 দিয়ে `dist/server.cjs` চলে।
- ডাটাবেস চালু না থাকলে সার্ভার সীমিত "memory DB" মোডে চলতে চায় (`memoryDbFallback.ts`)। আসল কাজের জন্য MySQL লাগবেই।
- **মোবাইল অ্যাপ (Capacitor):** `android/`, `ios/` ফোল্ডার। অ্যাপ আলাদা কোড নয়। ওয়েবের একই সার্ভারকে WebView-তে খোলে।

---

## ৯. Laravel ডেভেলপারদের জন্য সাবধানতা

1. **Validation Class নেই।** প্রতিটি handler নিজের ভেতরে `if (...) return res.status(400)...` লেখে।
2. **Transaction প্রায় নেই।** `beginTransaction` শুধু `server.ts`-এর কিছু জায়গায় আছে। বেশিরভাগ হ্যান্ডলার আলাদা আলাদা `queryDB` চালায়। যেখানে একাধিক টেবিল একসাথে বদলায়, সেখানে মাঝপথে ব্যর্থ হলে অর্ধেক ডাটা থেকে যেতে পারে, তাই কোড পড়ে নিন।
3. **কলামের নাম সরাসরি SQL-এ।** টেবিল বা কলাম বদলালে `grep` করে সব জায়গা খুঁজুন, কারণ ORM বা Model নেই যে একজায়গায় বদলালেই হবে।
4. **`await` ভুলবেন না।** সব ডাটাবেস কল asynchronous।
5. **`req.user`:** JWT থেকে আসে (`id`, `role` ইত্যাদি)। সব ডাটা এতে নেই, দরকারে ডাটাবেসে দেখে নিতে হয়।
6. **Permission দুই জায়গায়:** Backend-এ `requireModule`/`requireModuleLayer`, Frontend-এ `canSee`/`canSeeModule`। একটা ছাড়লে ফাঁক থেকে যায়।
7. **`CHANGES_*.md`:** কোনো ফিচার কেন ও কীভাবে বদলানো হয়েছে তার লগ। ওই ফিচার বুঝতে প্রথমে এগুলো পড়ুন।

---

## ১০. কোথা থেকে শুরু করবেন (পরামর্শ)

1. `package.json` → কী কী প্যাকেজ আর কমান্ড আছে।
2. `server.ts` → ওপর থেকে `startServer()` পর্যন্ত পড়ুন (সংযোগ, middleware, route রেজিস্ট্রেশন)।
3. ছোট একটা route ফাইল পড়ুন, যেমন `NoticeRoutes.ts`। গঠনটা একবার ধরতে পারলে বাকি ৭০টা একইরকম।
4. `src/App.tsx` → কোন স্টেটে কোন পেজ আঁকা হয়।
5. `src/components/GlobalSidebar.tsx` → মেনু থেকে পেজের সংযোগ।
6. একটা ফিচার বেছে (যেমন Leave) Frontend component থেকে API হয়ে ডাটাবেস পর্যন্ত ধরে ধরে যান। উপরের ৬ নম্বর অংশ এর নমুনা।
