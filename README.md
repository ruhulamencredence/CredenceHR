# Monthly Budget Optimization (Full-Stack Web & Android APK)

এই অ্যাপ্লিকেশনটি একটি ফুল-স্ট্যাক Employee/Project Management সিস্টেম —
React (Vite) frontend, Node.js + Express (single `server.ts`) backend, এবং
MySQL (XAMPP compatible) ডাটাবেজের উপর তৈরি। এতে আছে: MPR/Budget Entry
tracking, Leave Management, Conveyance Claims, Remote (GPS) + Office
(ZKTeco biometric) Attendance, Employee Tracking, Notices, Personal Alerts,
Holiday Calendar, Role-based Admin Panel, এবং Capacitor দিয়ে Android APK
বিল্ড সাপোর্ট।

---

## 0. এক নজরে — কী কী লাগবে (Prerequisites)

| জিনিস | ভার্সন / নোট |
|---|---|
| Node.js | v18 বা তার উপরে (recommend: v20 LTS) — `node -v` দিয়ে চেক করুন |
| npm | Node.js এর সাথেই আসে |
| MySQL | XAMPP (Windows) অথবা standalone MySQL 8.x — যেকোনো একটা |
| (ঐচ্ছিক) Android Studio | শুধু APK বিল্ড করতে চাইলে লাগবে |
| (ঐচ্ছিক) ZKTeco Office Devices | শুধু "Office Attendance" মডিউল ব্যবহার করলে লাগবে |

---

## 1. Project Files (root এ যা যা থাকা লাগবে)

```
package.json, tsconfig.json, vite.config.ts, index.html
server.ts                  ← মূল ব্যাকএন্ড (Express, সব API route)
holidayRoutes.ts           ← Holiday Calendar module (server.ts থেকে import হয়)
profileRoutes.ts           ← Employee Profile module (server.ts থেকে import হয়)
Alerts.ts                  ← Personal Alerts/Bell module (server.ts থেকে import হয়)
zkSync.ts                  ← ZKTeco Office Attendance sync (server.ts থেকে import হয়)
zklib.d.ts                 ← node-zklib এর জন্য TypeScript type declaration
schema.sql                 ← মূল ডাটাবেজ স্কিমা (নিচে ২ নং ধাপ দেখুন)
zk_office_attendance_schema.sql  ← ঐচ্ছিক (শুধু ZK ডিভাইস ব্যবহার করলে)
.env.example               ← কপি করে .env বানাতে হবে
src/                        ← React frontend (App.tsx, components/, lib/)
android/, capacitor.config.ts  ← APK বিল্ডের জন্য (৬ নং ধাপ দেখুন)
```

⚠️ `holidayRoutes.ts`, `profileRoutes.ts`, `Alerts.ts`, `zkSync.ts`,
`zklib.d.ts` — এই ফাইলগুলো **root এ, `server.ts` এর পাশেই** থাকতে হবে।
`server.ts` এর টপে `import ... from "./holidayRoutes"` ইত্যাদি দিয়ে এগুলো
লোড হয় — কোনো একটা মিসিং থাকলে সার্ভার স্টার্টই হবে না।

---

## 2. Database Setup (XAMPP MySQL / phpMyAdmin)

### ধাপ ১: Database তৈরি
1. XAMPP Control Panel থেকে **Apache** ও **MySQL** স্টার্ট করুন।
2. `http://localhost/phpmyadmin` এ গিয়ে একটি নতুন database বানান, নাম
   `mpr_tracker_db` (অথবা `.env` এ `DB_NAME` এ অন্য নাম দিলে সেটাই)।

### ধাপ ২: `schema.sql` Import করুন
Import ট্যাব থেকে root এর `schema.sql` ফাইলটি আপলোড করে রান করুন। এটি
মূল টেবিলগুলো (users, projects, jobs, entries, mpr_numbers, budgets,
claims, leave_applications, notices, attendance, ইত্যাদি — মোট ২৫টি
টেবিল) তৈরি করে।

### ⚠️ গুরুত্বপূর্ণ — schema.sql কি এককভাবে যথেষ্ট?
**প্রায় সম্পূর্ণ যথেষ্ট, ১০০% না — কিন্তু এটা কোনো সমস্যা তৈরি করে না।**
কোড চেক করে দেখা গেছে `schema.sql` এর বাইরে আরও কিছু টেবিল app এ ব্যবহার
হয় (`rate_list`, `material_categories`, `rate_file_meta`,
`conveyance_bills`, `conveyance_bill_items`, `attendance_corrections`,
`alerts`, `budget_submissions`, `user_profile_details`,
`holiday_calendar` ইত্যাদি) — কিন্তু **`server.ts` (এবং
`holidayRoutes.ts` / `Alerts.ts`) নিজে থেকেই প্রতিবার স্টার্টআপে
`CREATE TABLE IF NOT EXISTS` চালিয়ে এই টেবিলগুলো "self-heal" করে
(`ensureSchemaMigrations()` ফাংশন)।** তাই `schema.sql` import করার পর
প্রথমবার `npm run dev` / `npm start` চালালেই এই টেবিলগুলো নিজে থেকে
তৈরি হয়ে যাবে — আলাদা করে কোনো SQL রান করার দরকার নেই।

**একটাই ব্যতিক্রম — ZKTeco Office Attendance:** `zk_devices` ও
`zk_attendance_logs` টেবিল দুটো self-heal হয় **না** (`zkSync.ts` ধরে
নেয় এগুলো আগে থেকেই আছে)। এই মডিউল ব্যবহার করতে চাইলে
`zk_office_attendance_schema.sql` ফাইলটি phpMyAdmin এ **একবার আলাদাভাবে
import করতে হবে** (নিচে ৫ নং ধাপ দেখুন)। এটা না করলেও মূল অ্যাপ স্বাভাবিকভাবে
চলবে — শুধু কনসোলে একটা warning লগ হবে, সার্ভার ক্র্যাশ করবে না।

---

## 3. Environment Variables (`.env`)

Root এ `.env.example` কপি করে `.env` বানান এবং ভ্যালুগুলো বসান:

```env
# MySQL Database Configuration (XAMPP / Local)
DB_HOST="localhost"
DB_USER="root"
DB_PASSWORD=""
DB_NAME="mpr_tracker_db"
DB_PORT="3306"

# JWT Secret for Authentication — production এ অবশ্যই র‍্যান্ডম, শক্তিশালী কিছু দিন
JWT_SECRET="your_secure_jwt_secret_key"

# ব্যাকএন্ড সার্ভার যে পোর্টে চলবে (ফ্রন্টএন্ডও এই একই পোর্ট থেকে সার্ভ হয়)
PORT="3000"

# Superadmin Account — এই তিনটা ভ্যালু দিয়েই Superadmin account
# তৈরি/sync হয় সার্ভার স্টার্ট হওয়ার সময় প্রতিবার
ADMIN_NAME="System Admin"
ADMIN_EMAIL="admin@yourcompany.com"
ADMIN_PASSWORD="ChangeThisPassword123"
```

⚠️ **Superadmin account UI থেকে register করা যায় না** — শুধু `.env` এর
`ADMIN_EMAIL` / `ADMIN_PASSWORD` দিয়েই তৈরি হয়। সার্ভার প্রতিবার চালু
হওয়ার সময় এই ভ্যালু অনুযায়ী Superadmin account create বা sync
(name/password) করে নেয়। পাসওয়ার্ড বদলাতে চাইলে `.env` এ
`ADMIN_PASSWORD` বদলে সার্ভার রিস্টার্ট করুন। **প্রথমবার লগইনের পরেই
ডিফল্ট পাসওয়ার্ড বদলে ফেলা উচিত।**

---

## 4. Install & Run

```bash
# ১. সব dependencies install করুন
npm install

# ২. (ঐচ্ছিক কিন্তু recommended) TypeScript এরর চেক করুন
npm run lint

# ৩. Development মোডে চালান (Frontend + Backend একসাথে, hot-reload সহ)
npm run dev
```
* **App URL**: `http://localhost:3000` (পোর্ট ব্যস্ত থাকলে পরের ফ্রি
  পোর্টে চলে যেতে পারে — টার্মিনালের আউটপুট দেখুন)
* **Backend REST API**: একই সার্ভার থেকে `/api/...` এ সার্ভ হয় (আলাদা
  পোর্ট লাগে না)
* কনসোলে `✅ Connected to MySQL Database successfully!` দেখলে বুঝবেন DB
  কানেকশন ঠিক আছে। MySQL চালু না থাকলে অ্যাপ in-memory fallback মোডে
  চলবে (শুধু preview/testing এর জন্য — ডাটা persist হবে না, রিস্টার্টে
  সব হারিয়ে যাবে) — production এ অবশ্যই MySQL চালু রাখুন।

### Production Build & Run
```bash
npm run build     # frontend build (dist/) + server.ts কে dist/server.cjs এ bundle করে
npm start          # dist/server.cjs চালায় (production)
```
Production সার্ভার হিসেবে permanently চালাতে PM2 ব্যবহার করতে পারেন:
```bash
npm install -g pm2
pm2 start dist/server.cjs --name mbo-server
pm2 save
pm2 startup
```

---

## 5. (ঐচ্ছিক) ZKTeco Office Attendance Setup

শুধু অফিসে বসানো ZKTeco বায়োমেট্রিক মেশিন থেকে auto attendance sync
করতে চাইলে:

1. phpMyAdmin এ root এর `zk_office_attendance_schema.sql` ফাইলটি
   একবার import করুন। এটি:
   - `all_employees` টেবিলে `zk_device_pin` কলাম যোগ করে,
   - `zk_devices` (ডিভাইস রেজিস্ট্রি) ও `zk_attendance_logs` (raw punch
     history) টেবিল তৈরি করে।
2. অ্যাপ চালু করে Admin Panel -> Office Attendance থেকে প্রতিটা
   ডিভাইসের Name/IP/Port যোগ করুন (device গুলো একই নেটওয়ার্কে/reachable
   হতে হবে)।
3. প্রতিটা employee এর জন্য `all_employees.zk_device_pin`
   কলামে তার ডিভাইস PIN বসিয়ে দিন (Admin Panel -> Employees, অথবা
   `employee_id` ই যদি PIN হয় তাহলে bulk এ:
   `UPDATE all_employees SET zk_device_pin = employee_id;`)
4. সার্ভার স্টার্ট হলেই real-time listener চালু হয়ে যাবে, আর প্রতিদিন
   সকাল ৩টা ও দুপুর ৩টায় reconciliation sync অটো চলবে
   (`node-cron` দিয়ে, `zkSync.ts`)।

বিস্তারিত জানতে root এর `ZK_OFFICE_ATTENDANCE_INTEGRATION.md` দেখুন।

---

## 6. Roles: Superadmin, Admin, User

- **Superadmin**: `.env` এর `ADMIN_EMAIL`/`ADMIN_PASSWORD` দিয়ে সরাসরি
  Sign In করুন। Admin Panel-এর সব ট্যাব দেখতে পায়, এবং একমাত্র সেই:
  - User <-> Admin রোল বদলাতে পারে,
  - প্রতিটা Admin কোন কোন মডিউল (Projects, MPR Numbers, Data Import,
    Reports, Users, Job Recycle, MPR Edit Log, Attendance, Attendance
    Reports, Office Attendance, Holidays, Notices, Claims, Approvals,
    Conveyance, Employees, Tracking) অ্যাক্সেস পাবে তা "Users" ট্যাবের
    Module Access বাটন থেকে সেট করতে পারে।
- **Admin**: Superadmin যাকে Admin বানিয়েছে এবং যেসব module access
  দিয়েছে, শুধু সেই ট্যাবগুলোই দেখতে পাবে।
- **User**: Superadmin/Admin থেকে account তৈরি হয় — কোনো public
  self-registration নেই। Entry Form, Leave Application, Conveyance
  Claim, Remote Attendance ইত্যাদি নিজের অ্যাক্সেস অনুযায়ী ব্যবহার
  করতে পারে।

ডাটাবেজ খালি অবস্থায় শুরু হয় — Project ও MPR No প্রথমে Admin Panel
থেকে যোগ করে দিতে হবে, তারপর User Entry Form এর dropdown এ দেখাবে।

---

## 7. Mobile APK Build (Capacitor & Android Studio)

APK ওয়েব সার্ভারের সাথে সরাসরি কানেক্ট হয় (frontend বান্ডেল করা নেই,
`capacitor.config.ts` এ দেওয়া URL থেকে লাইভ লোড হয়) — তাই বিল্ড করার
আগে `capacitor.config.ts` এ আপনার সার্ভারের ঠিকানা বসাতে হবে:

```ts
const LOCAL_SERVER_URL = 'http://<আপনার-পিসির-LAN-IP>:3000'; // একই WiFi তে টেস্ট করার জন্য
const REAL_SERVER_URL  = 'http://<পাবলিক-IP-বা-ডোমেইন>:3000'; // লাইভ হয়ে গেলে
const USE_REAL_SERVER  = false; // লাইভ হলে true করে রিবিল্ড করুন
```

তারপর:
```bash
npm install @capacitor/core @capacitor/cli @capacitor/android   # প্রথমবার
npm run build
npx cap add android      # প্রথমবার (android/ ফোল্ডার আগে থেকেই থাকলে স্কিপ করুন)
npx cap sync android      # capacitor.config.ts বা build বদলালে প্রতিবার
npx cap open android
```
Android Studio থেকে **Build -> Build Bundle(s) / APK(s) -> Build
APK(s)** ক্লিক করে APK জেনারেট করুন। App আইকন আগে থেকেই বসানো আছে —
বদলাতে চাইলে `assets/icon.png` (1024×1024) বদলে রিজেনারেট করুন:
```bash
npx capacitor-assets generate --android --iconBackgroundColor '#415EB4' --iconBackgroundColorDark '#415EB4'
```

---

## 8. Troubleshooting

| সমস্যা | সমাধান |
|---|---|
| `⚠️ MySQL Connection failed` | XAMPP এ MySQL চালু আছে কিনা, `.env` এর DB_HOST/DB_USER/DB_PASSWORD/DB_NAME/DB_PORT ঠিক আছে কিনা চেক করুন |
| Superadmin দিয়ে লগইন হচ্ছে না | `.env` এ `ADMIN_EMAIL`/`ADMIN_PASSWORD` সেট আছে কিনা দেখুন, সার্ভার রিস্টার্ট করুন — কনসোলে superadmin sync এর লগ দেখুন |
| `Table 'xxx' doesn't exist` কোনো নতুন ফিচারে | `zk_devices`/`zk_attendance_logs` হলে ৫ নং ধাপ অনুসরণ করুন; অন্য টেবিল হলে সার্ভার একবার রিস্টার্ট দিন (self-healing migration আবার চলবে) |
| APK তে লগইন/ডাটা লোড হচ্ছে না | Sign In স্ক্রিনে Server Address ঠিক দিয়েছেন কিনা দেখুন (PC এর LAN IP:PORT, একই WiFi তে থাকা লাগবে), Windows Firewall এ Node.js/পোর্ট 3000 allow করা আছে কিনা চেক করুন |
| Employee Tracking কাজ করছে না (APK) | `capacitor.config.ts` এ `useLegacyBridge: true` আছে কিনা, ফোনে background location permission দেওয়া আছে কিনা দেখুন |
| Port 3000 already in use | `.env` এ `PORT` বদলে অন্য একটা ফ্রি পোর্ট দিন |

---

## 9. Tech Stack Summary

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS v4, Leaflet (maps), jsPDF (PDF export), lottie-react
- **Backend**: Node.js + Express 4 (single `server.ts` + `holidayRoutes.ts`/`profileRoutes.ts`/`Alerts.ts`/`zkSync.ts`), JWT auth (`jsonwebtoken` + `bcryptjs`)
- **Database**: MySQL (`mysql2`), connection pool + dateStrings mode
- **Mobile**: Capacitor 6 (Android) — background geolocation, filesystem, share
- **Office Attendance**: `node-zklib` (ZKTeco device SDK) + `node-cron` (scheduled sync)