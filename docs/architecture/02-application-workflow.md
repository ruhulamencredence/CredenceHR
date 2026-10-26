# CredenceHR — পুরো Application Workflow

> ভিত্তি: কোড পড়ে ও চালিয়ে (২৫ অক্টোবর ২০২৬, branch `claude/nice-fermi-0tale9`)। প্রতিটি ধাপে ফাইলের নাম দেওয়া আছে, যাতে যাচাই করা যায়।
> ডায়াগ্রামগুলো Mermaid-এ লেখা। GitHub/VS Code-এ নিজে আঁকা হয়; ইন্টারনেট ছাড়া দেখতে `docs/architecture/index.html` খুলুন।

---

## ১. সিস্টেমের বড় ছবি (Architecture)

```mermaid
flowchart TB
  subgraph Clients["ব্যবহারকারীর ডিভাইস"]
    W["ওয়েব ব্রাউজার<br/>(React অ্যাপ)"]
    A["মোবাইল অ্যাপ<br/>(Capacitor: Android / iOS)"]
  end
  subgraph Edge["সার্ভারের সামনে"]
    N["Nginx<br/>HTTPS, বড় আপলোড ৩০MB"]
  end
  subgraph App["Node.js সার্ভার (Express + TypeScript), PM2 cluster"]
    MW["Middleware: CORS ও নিরাপত্তা header,<br/>JWT যাচাই, সেশন/ডিভাইস/ব্লক যাচাই,<br/>কোম্পানি context"]
    R["প্রায় ৭০টি Route ফাইল (৭০০+ API)<br/>Admin Panel + Self Service"]
    S["Socket.IO (Chat, কল)"]
    J["Background jobs<br/>(রিমাইন্ডার, ZK sync, mail, ছুটির বছর)"]
  end
  DB[("MySQL / MariaDB<br/>সব টেবিল<br/>ফাইলসহ")]
  RD[("Redis<br/>(একাধিক PM2 worker হলে<br/>Chat সিঙ্ক)")]
  subgraph Ext["বাইরের সেবা (ঐচ্ছিক, .env দিয়ে চালু)"]
    SM["SMTP / IMAP<br/>(মেইল)"]
    FCM["Firebase / Web Push<br/>(পুশ নোটিফিকেশন)"]
    GM["Google Gemini<br/>(AI Assistant)"]
    ZK["ZKTeco ডিভাইস<br/>(অফিস উপস্থিতি)"]
    ERP["360 ERP (SSO)"]
  end
  W --> N
  A --> N
  N --> MW --> R
  W -. websocket .-> S
  R --> DB
  S --> RD
  J --> DB
  R --> SM
  R --> FCM
  R --> GM
  J --> ZK
  R --> ERP
```

**মূল কথা:** একটাই সার্ভার প্রসেস ওয়েব পেজ, API আর Chat দেয়। ডাটা একটাই ডাটাবেসে (ফাইলসহ)। Background job শুধু এক worker-এ চলে (`jobRunner.ts`), যাতে রিমাইন্ডার দুবার না যায়।

---

## ২. একটি রিকোয়েস্টের জীবন (Request Lifecycle)

```mermaid
sequenceDiagram
  autonumber
  participant B as ব্রাউজার/অ্যাপ
  participant S as server.ts (Express)
  participant Q as queryDB + companyScope
  participant D as ডাটাবেস
  B->>S: GET/POST /api/... + Authorization: Bearer JWT + X-Company-Id
  S->>S: CORS + security header, JSON পার্স (ভুল হলে 400 JSON)
  S->>S: authenticateToken: JWT সই ঠিক? সেশন শেষ হয়নি? ডিভাইস বৈধ? অ্যাকাউন্ট ব্লক/মুছে ফেলা নয়?
  S->>S: কোন কোম্পানিতে কাজ হচ্ছে, তার অধিকার আছে কি?
  S->>S: requireAdmin → requireModule(মডিউল) → requireModuleLayer(মডিউল, ধাপ)
  S->>S: Route handler: ইনপুট যাচাই (ভুল হলে 400 error)
  S->>Q: queryDB(sql, [params])
  Q->>Q: কোম্পানির ফিল্টার SQL-এ বসানো (companyScope)
  Q->>D: prepared statement (?)
  D-->>Q: সারি
  Q-->>S: সারি
  S-->>B: JSON (ভুল হলে error, ডাটাবেসের বার্তা লুকানো)
```

ফাইল: `server.ts` (`authenticateToken`, `requireAdmin`, `requireModule`, `requireModuleLayer`), `SessionSecurity.ts`, `DeviceRoutes.ts`, `AccountBlock.ts`, `companyContext.ts`, `companyScope.ts`, `ApiErrors.ts`, `WebSecurity.ts`।

---

## ৩. লগইন workflow

```mermaid
flowchart TD
  S([ব্যবহারকারী লগইন ID + পাসওয়ার্ড দেয়]) --> W{"ওয়ার্কস্পেস (কোম্পানি-গ্রুপ) ঠিক?"}
  W -- না --> X1["প্রত্যাখ্যান"]
  W -- হ্যাঁ --> L{"LoginGuard: ৫ বার ভুল?<br/>বা এক IP থেকে ৩০ বার?"}
  L -- হ্যাঁ --> X2["429: ১৫ মিনিট অপেক্ষা<br/>সঠিক পাসওয়ার্ডও তখন চলে না"]
  L -- না --> P{"পাসওয়ার্ড ঠিক? bcrypt"}
  P -- না --> X3["400: একই বার্তা<br/>ভুল ID বা ভুল পাসওয়ার্ড দুটোতেই<br/>+ login_attempts-এ লেখা"]
  P -- হ্যাঁ --> B{"অ্যাকাউন্ট ব্লক?"}
  B -- হ্যাঁ --> X4["403: ব্লক, HR-কে জানান"]
  B -- না --> O{"onboarding লগইন?<br/>মেয়াদ শেষ?"}
  O -- মেয়াদ শেষ --> X5["প্রত্যাখ্যান"]
  O -- ঠিক --> A{"মোবাইল অ্যাপ?"}
  A -- হ্যাঁ --> DV{"একটি ফোন নিয়ম:<br/>নতুন ফোন?"}
  DV -- হ্যাঁ --> X6["Superadmin-এর অনুমতির অপেক্ষা"]
  DV -- না --> LOC["অ্যাপ থেকে লোকেশন নেওয়া"]
  A -- "না (ওয়েব)" --> T
  LOC --> T["JWT তৈরি: ১২ ঘণ্টা ওয়েব / ৭ দিন অ্যাপ<br/>+ user_sessions-এ হ্যাশ করে সেশন"]
  T --> M{"পাসওয়ার্ড বদলাতে হবে?<br/>must_change_password"}
  M -- হ্যাঁ --> C["পাসওয়ার্ড বদল পেজ"]
  M -- না --> D([ড্যাশবোর্ড])
  C --> D
```

**বিকল্প প্রবেশ:** (ক) **Forgot password:** ইমেইলে ৬ অঙ্কের কোড (১৫ মিনিট, ৫ চেষ্টা) অথবা "HR-কে বলুন" (HR একটি অস্থায়ী পাসওয়ার্ড দেয়)। (খ) **Fingerprint/Passkey:** অ্যাপে ফোনের Keystore/Keychain-এর সিক্রেট, ওয়েবে WebAuthn passkey। দুটোই পাসওয়ার্ডের একই নিয়ম (ব্লক, ডিভাইস, কোম্পানি) মানে। অ্যাপে লগইন পাতায় fingerprint-এর জানালা নিজে একবার খোলে — অ্যাপ পুরো পর্দায় আসার পরে; আগে আঙুল, তারপর লোকেশন, তারপর সার্ভার। জানালা না খুললে বা সেন্সর ব্যস্ত থাকলে চালু করা fingerprint মুছে যায় না, "Sign in with fingerprint" চাপলেই আবার চেষ্টা হয়; শুধু ফোনের সংরক্ষিত চাবি সত্যিই না থাকলে (fingerprint বদলানো/মোছা) আবার চালু করতে বলে (`src/lib/fingerprint.ts`, টেস্ট `npm run test:fingerprint`)।
ফাইল: `AuthRoutes.ts`, `LoginGuard.ts`, `PasswordResetRoutes.ts`, `FingerprintRoutes.ts`, `SessionSecurity.ts`।

**সেশন শেষ হয় যখন:** ওয়েবে ১২ ঘণ্টা বা ৬০ মিনিট নিষ্ক্রিয়; অ্যাপে ৭ দিন বা ৩ দিন না খুললে (Superadmin বদলাতে পারে); Logout; Superadmin কাউকে বের করে দিলে; পাসওয়ার্ড বদলালে (বাকি সব সেশন); অ্যাকাউন্ট ব্লক হলে।

---

## ৪. কে কী দেখবে: অনুমতির সিদ্ধান্ত

```mermaid
flowchart TD
  R([অনুরোধ আসে]) --> J{"JWT ও সেশন বৈধ?"}
  J -- না --> E1["401"]
  J -- হ্যাঁ --> RO{"role"}
  RO -- superadmin --> OK["সব অনুমতি"]
  RO -- "user (কর্মী)" --> SS["শুধু Self Service:<br/>নিজের তথ্য ও যে সুইচ চালু আছে<br/>যেমন can_view_roster"]
  RO -- admin --> MOD{"এই মডিউল Superadmin দিয়েছে?<br/>admin_module_permissions"}
  MOD -- না --> E2["403"]
  MOD -- হ্যাঁ --> LY{"মডিউলে layer লাগে?<br/>যেমন payroll → salary_hold"}
  LY -- layer নেই/বন্ধ --> E3["403"]
  LY -- আছে --> DEP{"বিভাগ-সীমা আছে?<br/>যেমন Attendance Report, Leave, Duty Roster"}
  DEP -- সীমিত --> DS["শুধু ওই বিভাগের কর্মী"]
  DEP -- সীমা নেই --> ALL["সব বিভাগ"]
  OK --> CO
  SS --> CO
  DS --> CO
  ALL --> CO["কোম্পানি-সীমা: শুধু বর্তমান কোম্পানির সারি"]
```

- **Layer:** একই মডিউলের ভেতরে ভাগ। যেমন Payroll: `read`, `salary_hold`, `audit_approve`, `accounts_pay`। যে layer ডিফল্টে বন্ধ (🔒), Superadmin টিক না দিলে কেউ পায় না। পুরো তালিকা: `security/access-control-matrix.md`।
- **নিয়ম (CLAUDE.md):** প্রতিটি নতুন ফিচারে UI লুকানো **এবং** API বন্ধ, দুটোই লাগে।
- **কোম্পানি বদলে কাজ (সাধারণ নিয়ম):** মাদার কোম্পানির HR-কে Superadmin sister company-র প্রবেশাধিকার ও সেখানকার Module Access দেন (Admin Panel → Companies → Company access); HR উপরের company switcher-এ ওই কোম্পানি বেছে সেখানকার কাজ করেন। একটা কোম্পানি বাছা থাকলে শুধু সেই কোম্পানির কর্মী ও রেকর্ড আসে।
- **All companies mode (আলাদা অনুমতি, ডিফল্টে বন্ধ):** Superadmin একই পাতায় "All companies mode" টিক দিলে switcher-এ **All companies** আসে। তখন যে কোম্পানিগুলোতে প্রবেশাধিকার আছে, সবগুলোর কর্মী এক তালিকায় (নামের পাশে কোম্পানির কোড) — রেকর্ড খোলা ও বদলানো (প্রোফাইল, ব্যাংক অ্যাকাউন্ট, ছুটি, উপস্থিতি…) কোম্পানি না বদলেই। নিয়ম: (১) প্রবেশাধিকার নেই এমন কোম্পানি আসে না; (২) নতুন রেকর্ড switcher-এ আগে বাছা কোম্পানিতে যায়; (৩) settings ও Module Access ওই বাছা কোম্পানির; (৪) বেতন (payroll) চালানো আগের মতো প্রতিটা কোম্পানিতে আলাদা — CBL-এর বেতন CBL বেছে চালাতে হয়। কোনো একটা কোম্পানি বাছলে আবার আগের মতো এক কোম্পানি। চালু/বন্ধ করা `user_access_audit`-এ থাকে।

---

## ৫. কর্মীর পুরো জীবনচক্র (HR-এর প্রধান প্রবাহ)

```mermaid
flowchart LR
  A["Job Posting"] --> B["প্রার্থী ও ইন্টারভিউ"] --> C["Hire"]
  C --> D["Onboarding আবেদন খোলা<br/>অস্থায়ী লগইন ONB-0001"]
  D --> E["নতুন কর্মী ফর্ম ও ডকুমেন্ট জমা"]
  E --> F{"HR review ও approve<br/>যে খুলেছে সে approve করতে পারে না"}
  F -- approve --> G["কর্মী রেকর্ড + আসল লগইন<br/>Appointment letter"]
  F -- ফেরত --> E
  G --> H["সেবাকাল: ছুটি, উপস্থিতি, বেতন,<br/>ক্লেইম, ঋণ, টার্গেট, মূল্যায়ন"]
  H --> I["HR Action: নিশ্চিতকরণ,<br/>পদোন্নতি, increment, বদলি"]
  H --> J["অভিযোগ / শৃঙ্খলা"]
  H --> K["পদত্যাগ / সমাপ্তি"]
  K --> L["বিভাগভিত্তিক ছাড়পত্র<br/>IT, Finance, Admin, HR"]
  L --> M["Final Settlement<br/>ছুটি নগদায়ন, gratuity, বকেয়া"]
  M --> N["লগইন ব্লক<br/>রেকর্ড রাখা থাকে"]
```

ফাইল: `RecruitmentRoutes.ts`, `OnboardingSelfServiceRoutes.ts`, `HROperationsRoutes.ts`, `ExitOffboardingRoutes.ts`, `EmployeeRecordsGuard.ts`।
গুরুত্বপূর্ণ: onboarding চলাকালে নতুন ব্যক্তি **কর্মী নন** (`all_employees`-এ নেই), তাই headcount, payroll, উপস্থিতিতে আসে না। শুধু "My Onboarding" পেজ খোলা যায় (বাকি সব 403 `ONBOARDING_ONLY`)।

---

## ৬. ছুটির workflow

```mermaid
flowchart TD
  A([কর্মী: ছুটির আবেদন]) --> V{"যাচাই"}
  V -->|তারিখ ভুল, কারণ নেই,<br/>ধরন অচেনা| X1["400"]
  V -->|একই দিনে আগের আবেদন আছে| X2["409"]
  V -->|ব্যালেন্স কম / নীতি ভঙ্গ:<br/>reliever, অগ্রিম নোটিশ, সর্বোচ্চ টানা দিন| X3["400"]
  V -->|ঠিক| S["leave_applications: pending<br/>ব্যালেন্স থেকে দিন কাটে"]
  S --> RL{"Reliever দরকার?"}
  RL -- হ্যাঁ --> R1["Reliever সম্মতি/অসম্মতি"]
  R1 -- অসম্মতি --> RJ
  R1 -- সম্মতি --> AP
  RL -- না --> AP
  AP["Approval engine:<br/>টেমপ্লেটের ধাপ ধরে অনুমোদন"] --> D{"সিদ্ধান্ত"}
  D -- approved --> OK["ছুটি মঞ্জুর<br/>payroll ও উপস্থিতিতে ছুটি হিসেবে আসে"]
  D -- rejected --> RJ["ব্যালেন্সে দিন ফেরত"]
  S -. Supervisor ও Template কোনোটাই নেই .-> W["অপেক্ষায় থাকে: কর্মী দেখেন 'No approver set yet — tell HR'<br/>Superadmin ও HR alert পান; শুধু Superadmin সিদ্ধান্ত দিতে পারেন<br/>Supervisor/Template সেট হলে নিজে থেকে সেখানে যায়"]
```

- ব্যালেন্স: ছুটির বছর শুরুতে নীতি (workflow) অনুযায়ী বসে; বছর শেষে rollover job চলে (`LeaveRoutes.ts`, ৬ ঘণ্টা পরপর পরীক্ষা)।
- অনুমোদনকারী ঠিক করে **Approval Template** (`approval_templates`/`_steps`/`_step_approvers`)। কর্মীর সুপারভাইজার বা নির্দিষ্ট ব্যক্তি/ভূমিকা হতে পারে।

---

## ৭. Approval engine (সব অনুমোদনের সাধারণ ইঞ্জিন)

```mermaid
flowchart LR
  T[(approval_templates<br/>ধাপ + ধাপের approver)] --> Q
  Q["যে কোনো আবেদন<br/>ছুটি, ক্লেইম, ঋণ, সম্পদ, উপস্থিতি সংশোধন..."] --> RQ["approval_requests"]
  RQ --> ST{"বর্তমান ধাপের approver"}
  ST --> MY["Approver-এর 'My Approvals' তালিকা<br/>+ Dashboard + alert (বেল)"]
  MY --> ACT["act: approved / rejected + মন্তব্য"]
  ACT -->|আরও ধাপ আছে| ST
  ACT -->|শেষ ধাপ approved| FIN["মূল রেকর্ডের অবস্থা বদলায়<br/>(ছুটি, bill তৈরি ...)"]
  ACT -->|rejected| REJ["আবেদনকারীকে জানানো"]
```

**কে প্রথম অনুমোদন দেন:** কর্মীর Direct Supervisor (না থাকলে Department Supervisor) ধাপ ১, তারপর Template-এর layer। Supervisor নিজে আবেদন করলে সরাসরি Template-এর layer-এ যায় (টেস্ট `test-logs/2026-10-25/07-supervisor-chain.log`, ৩৬/৩৬)।
**Supervisor ও Template দুটোই না থাকলে:** আবেদন "approver নেই" অবস্থায় অপেক্ষা করে (`approval_requests.awaiting_approver = 1`)। কর্মী alert পান এবং নিজের পেজে "No approver set yet — tell HR" দেখেন। Superadmin ও Approvals মডিউলের Admin alert পান। শুধু Superadmin সিদ্ধান্ত দিতে পারেন: আবেদনটা তাঁর "My Approvals"-এ "No approver set" চিহ্নসহ আসে, Admin Panel → Approvals-এও থাকে। Supervisor বা Template সেট হলে আবেদন নিজে থেকে সেখানে সরে যায়: কেউ Approvals তালিকা খুললে, নইলে প্রতি ১০ মিনিটে (`rehomeAwaitingApprovals`)। টেস্ট: `test-logs/2026-10-25/09-no-approver-after-fix.log`।
ফাইল: `ApprovalRoutes.ts` (তালিকা ও act: `GET /api/my-approvals`, `POST /api/my-approvals/:id/act`), `Alerts.ts` (notification)।

---

## ৮. উপস্থিতি: তিন উৎস, একটি হিসাব

```mermaid
flowchart TD
  subgraph Src["উপস্থিতির তিন উৎস"]
    R["রিমোট (প্রজেক্ট)<br/>অ্যাপে GPS check-in/out<br/>প্রজেক্টের কাছে না হলে refuse"]
    O["অফিস (ZKTeco)<br/>প্রতি ৫ মিনিটে ডিভাইস থেকে punch আনে<br/>PIN → কর্মী"]
    SI["সাইট muster roll<br/>সুপারভাইজার দলের উপস্থিতি দেয়"]
  end
  R --> ATT[(attendance)]
  O --> ZKL[(zk_attendance_logs)]
  SI --> SAE[(site_attendance_*)]
  RO["ডিউটি রোস্টার + শিফট + ছুটির ক্যালেন্ডার"] --> CALC
  LP["দেরি নীতি + late waiver"] --> CALC
  LV["অনুমোদিত ছুটি"] --> CALC
  ATT --> CALC
  ZKL --> CALC
  SAE --> CALC
  CALC["হিসাব: উপস্থিত / অনুপস্থিত / ছুটি / দেরি"] --> REP["উপস্থিতি রিপোর্ট ও 360° পেজ"]
  CALC --> PW["Payroll wizard"]
```

- রোস্টারে "Off" বা শিফট দিলে ওই কর্মীর ওই দিনের ছুটি/কর্মদিবস ও দেরির সময় বদলে যায় (`RosterRoutes.ts`)।
- ভুল উপস্থিতি: কর্মী **সংশোধন আবেদন** দেয় → Approval। In Time ওই দিনের; Out Time In Time-এর আগে দিলে সেটা night shift ধরে পরদিন সকালের সময় হিসেবে যায় (ফর্মে "Next day" লেখা দেখায়)। অন্য তারিখের সময় বা In-এর আগের Out সার্ভার নেয় না।
- ZK ডিভাইসের PIN কর্মীর সাথে না জুড়লে punch কারো নামে যায় না (Unlinked PINs তালিকা)।

---

## ৯. Payroll workflow (HR → Audit → Accounts)

```mermaid
flowchart TD
  SS["বেতন কাঠামো<br/>salary_structures<br/>(তারিখ ধরে, পুরোনো রেকর্ড বদলায় না)"] --> WZ
  ATW["উপস্থিতি, ছুটি, দেরি"] --> WZ
  BN["bonus (pending_bonuses), ঋণ কিস্তি,<br/>pay items, overtime"] --> WZ
  WZ["Payroll wizard (HR)<br/>উপস্থিতি যাচাই: মোট দিন ছাড়াতে পারবে না<br/>ঋণাত্মক bonus/overtime/কর্তন নয়<br/>নিষ্ক্রিয় কর্মী: শুধু ছেড়ে যাওয়ার মাস পর্যন্ত"] --> GEN["payrolls তৈরি<br/>কর্মী × মাস = একটি"]
  GEN --> HOLD{"কারও বেতন hold?"}
  HOLD -- হ্যাঁ --> HD["মাসের বাইরে থাকে; ছাড়লে আলাদা চলে"]
  HOLD -- না --> SUB
  GEN --> SUB["HR: Submit for Audit<br/>(মাস লক)"]
  SUB --> AUD{"Audit (View only + audit_approve)<br/>যে submit করেছে বা কোনো বেতন<br/>চালিয়েছে/বদলেছে সে নয়"}
  AUD -- ফেরত নোট সহ --> GEN
  AUD -- approve --> PR["অবস্থা: Processed"]
  PR --> PAY["Accounts (View only + accounts_pay)<br/>যে চালিয়েছে, submit বা approve করেছে সে নয়<br/>তারিখ, পদ্ধতি, রেফারেন্স দিয়ে Pay"]
  PAY --> PD["Paid: আর বদলানো যায় না<br/>ঋণের কিস্তি কাটা হিসেবে ধরা হয়"]
  PD --> PSLIP["কর্মীর My Payslip + PDF + 'Salary Paid' alert"]
  GEN -. প্রতিটি লেখা .-> LOG[(payroll_access_log)]
```

**হিসাব:** net = মোট আয় (বেসিক + ভাতা + overtime + bonus) − কর − PF − ঋণ কিস্তি − অনুপস্থিতি/দেরি কর্তন − অন্য কর্তন। কর ও PF **হাতে/কাঠামোতে দেওয়া** (আয়কর স্ল্যাবের স্বয়ংক্রিয় হিসাব নেই)।
**কে কোন layer পায়:** HR = "Payroll" (`read`, বানানো ও বদলানো)। Audit = "View only" (`payroll_view`) + Audit Approve। Accounts = "View only" + Accounts Pay। View only সব পেজ ও রিপোর্ট দেখে, কিছু বদলাতে পারে না। নিয়মগুলো Superadmin-এর জন্য খাটে না।
**কর্মীর বেতন অ্যাকাউন্ট বদল:** যোগ/বদল/মোছা `employee_change_log`-এ (পুরনো → নতুন, কে) থাকে, কর্মী "Salary account changed" alert পায়।
ফাইল: `PayrollRoutes.ts`, `PayrollApprovalRoutes.ts`, `PayrollItemsRoutes.ts`, `PayslipRoutes.ts`।

---

## ১০. Conveyance Bill Claim → Disbursement

```mermaid
flowchart TD
  C([কর্মী: খরচের দাবি<br/>ক্যাটাগরি, তারিখ, পরিমাণ, বিবরণ, রসিদ]) --> POL{"Bill Claim Policy:<br/>সীমা, রসিদ, সময়সীমা"}
  POL -- ভঙ্গ --> X["প্রত্যাখ্যান"]
  POL -- ঠিক --> AE["Approval engine<br/>টেমপ্লেটের ধাপ: যেমন HR → Accounts"]
  AE --> SIG{"নীতিতে 'approver signature' চালু?"}
  SIG -- হ্যাঁ --> SGN["প্রতি ধাপে approver-এর সংরক্ষিত স্বাক্ষর বসে"]
  SIG -- না --> L
  SGN --> L["শেষ ধাপ approved"]
  L --> BILL["conveyance_bills + items তৈরি"]
  BILL --> DISB["Disbursement (Accounts):<br/>Voucher নম্বর দিয়ে paid"]
  DISB --> PDF["Bill PDF ও Payment Voucher PDF<br/>'Approved By' সহ"]
```

**Movement Claim** আলাদা: কর্মী কোথাও গেলে GPS-সহ ক্লেইম, একই Approval engine (`MovementClaimRoutes.ts`)।
ফাইল: `ConveyanceBillClaimRoutes.ts`, `BillClaimPolicy.ts`।

---

## ১১. ই-স্বাক্ষর (Document Vault)

```mermaid
flowchart TD
  U["ডকুমেন্ট আপলোড / HR চিঠি<br/>employee_documents (BLOB)"] --> SND["স্বাক্ষরের জন্য পাঠানো<br/>স্বাক্ষরকারী ও ক্রম<br/>মূল ফাইলের SHA-256 ঠিক হয়"]
  SND --> TURN{"যার পালা"}
  TURN --> OTP{"OTP চালু?"}
  OTP -- হ্যাঁ --> OT["Credence Mail-এ ৬ অঙ্কের কোড<br/>৫ মিনিট, একবার, ৫ ভুলে ১৫ মিনিট লক"]
  OTP -- না --> SG
  OT --> SG["স্বাক্ষর আঁকা/আপলোড<br/>user_signatures-এ রাখা"]
  SG --> NEXT{"আরও স্বাক্ষরকারী?"}
  NEXT -- হ্যাঁ --> AL["পরের জনকে alert"] --> TURN
  NEXT -- না --> PDF["সব স্বাক্ষর PDF-এ বসে<br/>Signature Certificate পাতা + QR"]
  PDF --> CERT{"সার্টিফিকেট স্বাক্ষর চালু?"}
  CERT -- হ্যাঁ --> PK["PKCS#7 ডিজিটাল স্বাক্ষর<br/>(কেনা .p12 বা কোম্পানির self-signed)"]
  CERT -- না --> V
  PK --> V["/verify/&lt;code&gt;: যে কেউ দেখতে পারে কে কখন সই করেছে,<br/>ফাইল মেলাতেও পারে"]
  V --> EM["সই করা PDF ইমেইলে পাঠানো"]
```

ফাইল: `DocumentVaultRoutes.ts`, `ESignRoutes.ts`, `ESignCertificate.ts`। Adobe Reader-এ "valid" দেখাতে লাইসেন্সপ্রাপ্ত CA-র সার্টিফিকেট দরকার (self-signed-এ "validity unknown")।

---

## ১২. PEPM: প্রকল্পের MPR চক্র

```mermaid
flowchart LR
  P["প্রজেক্ট ব্যবহারকারী<br/>MPR সারি (entries) তোলে<br/>Job ও Budget-এর মধ্যে"] --> SB["Budget Submission<br/>'শেষ' চিহ্ন"]
  SB --> RPT["Purchase: MPR Entries রিপোর্ট<br/>ফিল্টার → টিক → 'Send to Dispatch'"]
  RPT --> DM["Dispatch Material<br/>সরবরাহকারী, রেট, P.O., challan<br/>(স্ক্রিনে বা Excel আপলোডে)"]
  DM --> OW["On the way"]
  OW --> RC["Project: Material Receive<br/>পুরো/আংশিক গ্রহণ"]
  RC -. ফেরত নেওয়া .-> P
  BI["Budget Excel import<br/>→ খসড়া notice"] --> P
```

অনুমতি: Reports মডিউলের layer `dispatch_material`, `dispatch_all` (দুটোই 🔒)। Receive-এর সুইচ `can_receive_material`। ফাইল: `EntriesRoutes.ts`, `MprDispatchRoutes.ts`, `BudgetImportRoutes.ts`।

---

## ১৩. যোগাযোগ: Notice, Chat, Mail, Alerts

| ব্যবস্থা | কীভাবে চলে |
|---|---|
| **Notice** | Admin HTML লেখে → সার্ভার `NoticeSafety.ts` দিয়ে পরিষ্কার করে → টার্গেট (সবাই বা নির্দিষ্ট ব্যক্তি, `notice_targets`) → লগইনের পর popup ও Notice board |
| **Chat** | Socket.IO; রুম, ব্যক্তিগত মেসেজ; edit (১৫ মিনিট), unsend, forward, pin, reaction; ফাইল ডাটাবেসে। Module Access-এর সুইচে চালু |
| **Credence Mail** | নিজস্ব মেইল ক্লায়েন্ট; IMAP/SMTP দিয়ে মেইল সার্ভারের সাথে; পাসওয়ার্ড AES-256-GCM-এ এনক্রিপ্ট; গ্রুপ, ফিল্টার, টেমপ্লেট, নির্ধারিত পাঠানো |
| **Alerts (বেল)** | সার্ভারে `createAlert()`; অ্যাপে পুশ (Firebase), ওয়েবে Web Push |
| **AI Assistant** | কর্মীর প্রশ্ন → স্থানীয় নিয়মে উত্তর; Gemini চালু থাকলে প্রশ্ন ও ফল Google-এ যায়। সব ডাটা **প্রশ্নকারীর নিজের token দিয়ে** অ্যাপের নিজের API থেকে আনে, তাই যা দেখার অধিকার নেই তা দেখায় না; কিছু লেখে না |

---

## ১৪. Background jobs (একটি worker-এ)

| কাজ | কত পরপর | ফাইল |
|---|---|---|
| ZKTeco ডিভাইস থেকে punch আনা | ৫ মিনিট | `zkSync.ts` (node-cron) |
| অপেক্ষমাণ approval নতুন approver-এ সরানো | ১০ মিনিট | `server.ts` |
| HR/সাইট/টাস্ক/টার্গেট রিমাইন্ডার | ৩০–৬০ মিনিট | `HrRemindersRoutes.ts`, `TaskRoutes.ts`, `TargetRoutes.ts`, `SiteAttendanceRoutes.ts` |
| ছুটির বছর rollover পরীক্ষা | ৬ ঘণ্টা | `LeaveRoutes.ts` |
| Onboarding মেয়াদ শেষ | ১ ঘণ্টা | `OnboardingSelfServiceRoutes.ts` |
| Mail: নির্ধারিত পাঠানো / ফোল্ডার watch / পুরোনো blob পরিষ্কার | ১ মিনিট / ১ মিনিট / ৬ ঘণ্টা | `MailRoutes.ts` |
| Vehicle ride মেয়াদ | ১ মিনিট | `VehicleManagementRoutes.ts` |
| নির্ধারিত HR রিপোর্ট | ১০ মিনিট | `HrOpsReportsRoutes.ts` |

---

## ১৫. ডিপ্লয়মেন্ট

```mermaid
flowchart LR
  DEV["ডেভেলপমেন্ট<br/>npm run dev<br/>(tsx server.ts + Vite এক পোর্টে)"] --> BLD["npm run build<br/>Vite → dist/ ফ্রন্টএন্ড<br/>esbuild → dist/server.cjs"]
  BLD --> PM["PM2 cluster<br/>(ecosystem.config.cjs)"]
  PM --> NG["Nginx (HTTPS, proxy)"]
  NG --> U["ব্যবহারকারী"]
  PM --> DBS[(MySQL)]
  PM --> RDS[(Redis)]
```

Node ≥ ২২। `.env`-এর মূল চাবি: `DB_*`, `JWT_SECRET`, `ADMIN_EMAIL/PASSWORD`, `CORS_ORIGINS`, `MAIL_ENCRYPTION_KEY`, `REDIS_URL`, `GEMINI_API_KEY` (ঐচ্ছিক), `ESIGN_CERT_*` (ঐচ্ছিক)।

---

## ১৬. যা এই workflow-তে ধরা নেই

আসল ফোন অ্যাপের ভেতরের প্রবাহ (GPS, ক্যামেরা), প্রতিটি ছোট রিপোর্ট ও পেজ, মডিউলভিত্তিক সব এজ-কেস। বিস্তারিত দেখতে `docs/CredenceHR-Code-Guide-for-Laravel-Developers-BN.md` ও সংশ্লিষ্ট `*Routes.ts` ফাইলের শুরুর মন্তব্য পড়ুন (প্রতিটি ফাইলে প্রবাহ লেখা আছে)।
