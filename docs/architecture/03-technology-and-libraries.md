# প্রযুক্তি ও লাইব্রেরি: কোথায় কোনটি, কেন, কী সুবিধা

> ভিত্তি: `package.json`, `node_modules` ও সোর্স কোডের import (২৫ অক্টোবর ২০২৬)। "কত ফাইলে" = কোডে কতগুলো ফাইল import করে (যাচাই করা)। পুরো তালিকা (ট্রানজিটিভ সহ ৭২৬টি প্যাকেজ, লাইসেন্স সহ): [`dependency-sbom.csv`](dependency-sbom.csv)।

## ১. প্রযুক্তি স্ট্যাক এক লাইনে

| স্তর | ব্যবহৃত | কেন |
|---|---|---|
| ভাষা | **TypeScript** (সার্ভার ও ফ্রন্টএন্ড একই ভাষা) | একই টাইপ দুই দিকে; ভুল আগেই ধরা পড়ে |
| সার্ভার | **Node.js ≥ 22 + Express 4** | ছোট, সরল; Chat (WebSocket) ও API একই প্রসেসে |
| ডাটাবেস | **MySQL / MariaDB** (InnoDB) | প্রতিষ্ঠিত, ACID, HR/payroll-এর সম্পর্কযুক্ত ডাটার উপযুক্ত |
| ফ্রন্টএন্ড | **React 19 + Vite + Tailwind 4** | দ্রুত UI, এক কোডে সব পেজ |
| মোবাইল | **Capacitor 8** (Android/iOS) | ওয়েব কোডই অ্যাপ হয়; GPS, পুশ, fingerprint-এর plugin |
| রিয়েলটাইম | **Socket.IO** (+ Redis ঐচ্ছিক) | Chat, কল সংকেত |
| চালানো | **PM2 cluster + Nginx** | একাধিক CPU কোর, HTTPS, auto-restart |

## ২. লাইব্রেরি তালিকা

### Backend

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@google/genai` | 2.31.0 | Apache-2.0 | 1 | `AiAssistantRoutes.ts` | AI Assistant-এ Gemini | ঐচ্ছিক। চালু থাকলে প্রশ্ন ও ফলাফল Google-এ যায়, তাই বন্ধ রাখার সুইচ আছে। |
| `@signpdf/placeholder-pdf-lib` | 3.4.0 | MIT | 1 | `ESignCertificate.ts` | PDF-এ স্বাক্ষরের জায়গা রাখা | pdf-lib-এর সাথে জোড়া। |
| `@signpdf/signer-p12` | 3.4.0 | MIT | 1 | `ESignCertificate.ts` | .p12 সার্টিফিকেট দিয়ে স্বাক্ষর | কেনা সার্টিফিকেট ব্যবহারের পথ। |
| `@signpdf/signpdf` | 3.4.0 | MIT | 1 | `ESignCertificate.ts` | PDF-এ PKCS#7 ডিজিটাল স্বাক্ষর | Adobe Reader-এ "Signed" দেখায়; এক বাইট বদলালেও ধরা পড়ে। |
| `@simplewebauthn/server` | 14.0.3 | MIT | 1 | `FingerprintRoutes.ts` | Passkey (WebAuthn) যাচাই | পাসওয়ার্ড ছাড়া fingerprint/Windows Hello লগইন; ফিশিং-প্রতিরোধী। |
| `@socket.io/redis-adapter` | 8.3.0 | MIT | 1 | `server.ts` | একাধিক worker-এ Chat মেসেজ ছড়ানো | PM2 cluster-এ ব্যবহারকারী যে worker-এই থাকুক মেসেজ পৌঁছায়। |
| `bcryptjs` | 3.0.3 | BSD-3-Clause | 9 | `AuthRoutes.ts`, `CompanyRoutes.ts` | পাসওয়ার্ড hash (bcrypt, cost 10) | ধীর ও salt-যুক্ত hash: ডাটাবেস চুরি গেলেও পাসওয়ার্ড বের করা কঠিন। Pure JS, ইনস্টলে সমস্যা নেই। |
| `compression` | 1.8.2 | MIT | 1 | `server.ts` | HTTP উত্তর gzip করা | ৩MB-এর JS বান্ডেল প্রায় ১/৪ হয়ে যায়; ধীর মোবাইল নেটে লগইন পেজ দ্রুত খোলে। |
| `cors` | 2.8.6 | MIT | 1 | `WebSecurity.ts` | কোন ওয়েবসাইট API ডাকতে পারবে তা ঠিক করা | `CORS_ORIGINS` দিয়ে শুধু নিজের ঠিকানা অনুমোদন। |
| `dotenv` | 17.4.2 | BSD-2-Clause | 1 | `server.ts` | `.env` ফাইল থেকে কনফিগ পড়া | গোপন মান (ডাটাবেস পাসওয়ার্ড, চাবি) কোডের বাইরে থাকে। |
| `express` | 4.22.3 | MIT | 74 | `AccountBlock.ts`, `ActiveUsersRoutes.ts` | Web server ও API routing | সবচেয়ে প্রচলিত Node framework; middleware (auth, CORS, JSON) জোড়া সহজ; ছোট, দ্রুত শেখা যায়। (Laravel-এর Route + Middleware) |
| `firebase-admin` | 14.5.0 | Apache-2.0 | 1 | `PushNotificationService.ts` | মোবাইল অ্যাপে পুশ নোটিফিকেশন (FCM) | অ্যাপ বন্ধ থাকলেও নোটিফিকেশন। |
| `imapflow` | 2.9.1 | MIT | 1 | `MailRoutes.ts` | IMAP-এ মেইল পড়া/সিঙ্ক | Credence Mail-এর ইনবক্স আসে মেইল সার্ভার থেকে। |
| `jsonwebtoken` | 9.0.3 | MIT | 3 | `AuthRoutes.ts`, `ChatRoutes.ts` | লগইন token (JWT) তৈরি ও যাচাই | সার্ভারে সেশন-ডাটা না রেখেই কে লগইন তা প্রমাণ; ওয়েব ও মোবাইল একই পদ্ধতি। |
| `mailparser` | 3.12.4 | MIT | 1 | `MailRoutes.ts` | আসা মেইল (MIME) বিশ্লেষণ | বিষয়, বডি, সংযুক্তি আলাদা করা। |
| `mysql2` | 3.24.6 | MIT | 3 | `schemaMigrations.ts`, `server.ts` | MySQL/MariaDB সংযোগ, prepared statement, connection pool | `?` প্যারামিটারে SQL injection রোধ; pool-এ একসাথে অনেক রিকোয়েস্ট; দ্রুত। |
| `node-cron` | 4.6.0 | ISC | 1 | `zkSync.ts` | নির্ধারিত কাজ (ZK ডিভাইস sync) | ক্রন-ধাঁচের সময়সূচি সহজে। |
| `node-forge` | 1.4.0 | (BSD-3-Clause OR GPL-2.0) | 1 | `ESignCertificate.ts` | কোম্পানির self-signed সার্টিফিকেট, .p12 খোলা | ডিজিটাল স্বাক্ষরের সার্টিফিকেট তৈরি/পড়া। |
| `node-zklib` | 1.3.0 | ISC | 1 | `zkSync.ts` | ZKTeco বায়োমেট্রিক ডিভাইসের সাথে কথা বলা | অফিসের fingerprint মেশিন থেকে punch টেনে আনা, আলাদা সফটওয়্যার ছাড়াই। |
| `nodemailer` | 10.2.1 | MIT-0 | 2 | `MailRoutes.ts`, `mailer.ts` | SMTP-তে ইমেইল পাঠানো | Forgot-password কোড, OTP, রিপোর্ট ইমেইল, Credence Mail। |
| `pdf-lib` | 1.17.1 | MIT | 2 | `ESignCertificate.ts`, `ESignRoutes.ts` | PDF তৈরি/সম্পাদনা (স্বাক্ষর, সার্টিফিকেট পাতা) | Pure JS, নির্ভরতা কম। |
| `qrcode` | 1.5.4 | MIT | 1 | `ESignRoutes.ts` | QR কোড (স্বাক্ষর যাচাই লিংক) | সার্টিফিকেট পাতায় /verify লিংক। |
| `redis` | 4.7.1 | MIT | 1 | `server.ts` | Redis সংযোগ (Socket.IO adapter-এর জন্য) | শুধু একাধিক worker চালালে লাগে; এক প্রসেসে বাধ্যতামূলক নয়। |
| `sanitize-html` | 2.18.1 | MIT | 1 | `NoticeSafety.ts` | Notice-এর HTML পরিষ্কার (স্ক্রিপ্ট, onerror বাদ) | Stored XSS রোধ। সার্ভারে সংরক্ষণ ও পড়া, দুবারই। |
| `socket.io` | 4.8.4 | MIT | 6 | `AssistantSupportRoutes.ts`, `CallRoutes.ts` | রিয়েলটাইম Chat, কল সংকেত | WebSocket + fallback; রুম, পুনঃসংযোগ নিজে সামলায়। |
| `web-push` | 3.6.7 | MPL-2.0 | 1 | `WebPushService.ts` | ব্রাউজারে Web Push | ওয়েব ব্যবহারকারীকেও alert পাঠানো (VAPID)। |

### Backend (অব্যবহৃত)

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@mlightcad/libredwg-web` | 0.7.17 | GPL-3.0 | 0 | — | DWG ফাইল পড়া (আগে Measurement Sheet-এ) | ⚠ ফিচারটি সরানো হয়েছে, কোডে আর ব্যবহার নেই। লাইসেন্স **GPL-3.0**, তাই বাদ দেওয়া উচিত (নিচে "পরিষ্কার করার তালিকা")। |
| `dxf-parser` | 1.1.2 | MIT | 0 | — | DXF ফাইল পড়া (আগে Measurement Sheet-এ) | ⚠ কোডে আর ব্যবহার নেই। বাদ দেওয়া যায়। |

### Frontend

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@simplewebauthn/browser` | 14.0.0 | MIT | 1 | `fingerprint.ts` | ব্রাউজারে Passkey তৈরি/ব্যবহার | WebAuthn API সহজ করে। |
| `dompurify` | 3.4.17 | (MPL-2.0 OR Apache-2.0) | 2 | `MailBody.tsx`, `noticeHtml.ts` | HTML পরিষ্কার (Notice, Mail বডি) | সার্ভারের পরিষ্কারের পরে ব্রাউজারে দ্বিতীয় স্তর (defence in depth)। |
| `jspdf` | 4.2.1 | MIT | 29 | `AdminPanel.tsx`, `ConveyanceBillPanel.tsx` | ব্রাউজারে PDF বানানো (payslip, bill, voucher, রিপোর্ট) | সার্ভারে লোড না ফেলে ব্যবহারকারীর ব্রাউজারেই PDF। |
| `jspdf-autotable` | 5.0.9 | MIT | 22 | `AdminPanel.tsx`, `ConveyanceBillPanel.tsx` | PDF-এ টেবিল | রিপোর্ট ও বিলের সারি-কলাম সহজে। |
| `leaflet` | 1.9.4 | BSD-2-Clause | 10 | `AttendanceMapConfirm.tsx`, `ClaimLocationMap.tsx` | মানচিত্র (উপস্থিতি, ক্লেইম, ট্র্যাকিং) | ওপেন-সোর্স, হালকা; ট্যাইল CARTO। |
| `lottie-react` | 3.1.2 | MIT | 9 | `AuthHeroLottie.tsx`, `BookRideCard.tsx` | অ্যানিমেশন (লগইন, কার্ড) | ছোট JSON অ্যানিমেশন, ভিডিওর চেয়ে হালকা। |
| `lucide-react` | 0.546.0 | ISC | 209 | `App.tsx`, `AccessTemplatesModal.tsx` | আইকন | হালকা, একরকম স্টাইল; ২০৯ ফাইলে ব্যবহৃত। |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | 2 | `DocReader.tsx`, `PdfPreviewModal.tsx` | PDF দেখানো (DocReader, preview) | ব্রাউজারে PDF পাতা আঁকা, ডাউনলোড ছাড়াই। |
| `react` | 19.3.1 | MIT | 242 | `App.tsx`, `ChatStandalone.tsx` | UI লাইব্রেরি (কম্পোনেন্ট, state) | বড় ইকোসিস্টেম; পেজ ছোট ছোট অংশে ভাগ করা যায়; JSX-এ লেখা ডিফল্টে escape হয় (XSS কম)। (Blade-এর বদলে) |
| `react-dom` | 19.3.1 | MIT | 32 | `AlertsBell.tsx`, `AttendanceCorrectionModal.tsx` | React-কে ব্রাউজারে আঁকা | React-এর অংশ। |
| `socket.io-client` | 4.8.4 | MIT | 1 | `chatSocket.ts` | Chat-এর ক্লায়েন্ট | socket.io সার্ভারের সাথে জোড়া। |

### Frontend (অব্যবহৃত)

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `motion` | 12.43.0 | MIT | 0 | — | অ্যানিমেশন লাইব্রেরি | ⚠ কোডে import নেই; বাদ দেওয়া যায়। |

### Frontend + Backend

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `xlsx` | 0.18.5 | Apache-2.0 | 22 | `HrOpsReportsRoutes.ts`, `AdminPanel.tsx` | Excel পড়া ও লেখা (import/export) | HR ডাটা import, রিপোর্ট export, Budget import। নতুন সংস্করণ অফিসিয়াল SheetJS 0.20.3 (tarball)। |

### Mobile

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@capacitor-community/background-geolocation` | 1.3.1 | MIT | 0 | — | ব্যাকগ্রাউন্ডে লোকেশন (Employee Tracking) | অ্যাপ বন্ধ থাকলেও (সম্মতি নিয়ে) ট্র্যাকিং। |
| `@capacitor/app` | 8.1.2 | MIT | 3 | `App.tsx`, `TrackingNoticeCard.tsx` | অ্যাপের জীবনচক্র (back button, resume) |  |
| `@capacitor/core` | 8.5.3 | MIT | 49 | `App.tsx`, `AdminPanel.tsx` | ওয়েব অ্যাপকে Android/iOS অ্যাপ বানানোর ভিত্তি | একই কোড ওয়েব ও মোবাইলে; আলাদা native কোড কম। |
| `@capacitor/device` | 8.0.3 | MIT | 1 | `device.ts` | ডিভাইস ID (একটি ফোন নিয়ম) | ডিভাইস সীমাবদ্ধতার জন্য স্থির ID। |
| `@capacitor/filesystem` | 8.1.5 | MIT | 3 | `assistantReportExport.ts`, `mailApi.ts` | ফাইল সংরক্ষণ (PDF, রিপোর্ট) |  |
| `@capacitor/geolocation` | 8.2.4 | MIT | 8 | `AttendanceCard.tsx`, `AttendanceMapConfirm.tsx` | GPS লোকেশন | উপস্থিতি/ক্লেইমে অবস্থান যাচাই। |
| `@capacitor/keyboard` | 8.0.6 | MIT | 3 | `AuthScreen.tsx`, `ChatPanel.tsx` | কীবোর্ড খোলা-বন্ধে লেআউট ঠিক রাখা |  |
| `@capacitor/push-notifications` | 8.1.3 | MIT | 1 | `pushNotifications.ts` | পুশ নোটিফিকেশন গ্রহণ | Firebase-এর সাথে। |
| `@capacitor/share` | 8.0.3 | MIT | 3 | `assistantReportExport.ts`, `mailApi.ts` | শেয়ার (PDF/ফাইল অন্য অ্যাপে) |  |
| `@capacitor/status-bar` | 8.0.4 | MIT | 1 | `App.tsx` | স্ট্যাটাস বার রং |  |
| `@capgo/capacitor-native-biometric` | 8.9.1 | MPL-2.0 | 1 | `fingerprint.ts` | ফোনের fingerprint/face + Keystore/Keychain | সিক্রেট ফোনের নিরাপদ স্টোরে, fingerprint ছাড়া খোলে না। |
| `capacitor-voice-recorder` | 7.0.6 | MIT | 1 | `ChatPanel.tsx` | Chat-এ ভয়েস মেসেজ রেকর্ড |  |

### Build

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@vitejs/plugin-react` | 5.2.0 | MIT | 1 | `vite.config.ts` | Vite-এ React সমর্থন | Fast refresh। |
| `vite` | 6.4.5 | MIT | 2 | `server.ts`, `vite.config.ts` | ডেভ সার্ভার ও ফ্রন্টএন্ড build | খুব দ্রুত রিলোড; production-এ ছোট বান্ডেল। |
| `esbuild` | 0.25.12 | MIT | 0 | — | সার্ভার কোড এক ফাইলে (dist/server.cjs) | খুব দ্রুত bundle; production এ ছোট শুরু সময়। |

### Build/UI

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `@tailwindcss/vite` | 4.3.3 | MIT | 1 | `vite.config.ts` | Tailwind-এর Vite প্লাগইন | দ্রুত CSS তৈরি। |
| `autoprefixer` | 10.6.1 | MIT | 0 | — | পুরোনো ব্রাউজারের জন্য CSS prefix | সামঞ্জস্য। |
| `tailwindcss` | 4.3.3 | MIT | 0 | — | Utility CSS framework | HTML-এই স্টাইল; আলাদা CSS ফাইল ছোট থাকে; liquid-glass ডিজাইন এর উপর। |

### Dev

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `tsx` | 4.23.15 | MIT | 0 | — | TypeScript সরাসরি চালানো (dev server) | আলাদা compile ছাড়া। |
| `typescript` | 5.8.3 | Apache-2.0 | 0 | — | টাইপ চেক (`npm run lint`) | রানটাইমের আগে ভুল ধরা; ২৫ অক্টোবর পরিষ্কার। |

### Ops

| প্যাকেজ | সংস্করণ | লাইসেন্স | কত ফাইলে | কোথায় (উদাহরণ) | কী কাজে | কেন / সুবিধা |
|---|---|---|---|---|---|---|
| `pm2` | 5.4.3 | AGPL-3.0 | 0 | — | production-এ একাধিক worker, auto-restart | মাল্টি-কোর ব্যবহার; ক্র্যাশে নিজে চালু। ⚠ লাইসেন্স AGPL-3.0 (সরঞ্জাম হিসেবে চালানো, কোডে মেশানো নয়)। |

## ৩. পরিষ্কার করার তালিকা (গুরুত্বপূর্ণ)

| সমস্যা | ঝুঁকি | করণীয় |
|---|---|---|
| `@mlightcad/libredwg-web` **GPL-3.0**, কোডে আর ব্যবহার নেই (Measurement Sheet সরানোর পর) | বাণিজ্যিক/বন্ধ-কোড সফটওয়্যারে GPL থাকা আইনি প্রশ্ন তোলে | `package.json` থেকে বাদ দিন |
| `dxf-parser`, `motion` ব্যবহার নেই | অকারণ আকার, নিরাপত্তা-হালনাগাদের বোঝা | বাদ দিন |
| `pm2` **AGPL-3.0** | সরঞ্জাম হিসেবে চালালে সমস্যা নেই; কোডে import নেই (শুধু devDependency) | ঠিক আছে, তবে লাইসেন্স তালিকায় উল্লেখ রাখুন |
| `node-forge` দ্বৈত লাইসেন্স (BSD-3-Clause **অথবা** GPL-2.0) | আমরা BSD বেছে নিই | উল্লেখ রাখুন |
| `xlsx` SheetJS tarball `cdn.sheetjs.com` থেকে নামে | CDN বন্ধ থাকলে `npm install` ব্যর্থ | ঠিকানা CI/মিররে রাখুন বা `.tgz` সংরক্ষণ |
| লাইসেন্স অজানা: `cli-tableau` (pm2-এর ভেতরের) | ছোট | pm2-এর অংশ |

## ৪. নিরাপত্তায় যে লাইব্রেরি ভূমিকা রাখে

`bcryptjs` (পাসওয়ার্ড) · `jsonwebtoken` (token) · `sanitize-html` + `dompurify` (XSS) · `mysql2` prepared statement (SQL injection) · `@simplewebauthn/*` (passkey) · `@signpdf/*` + `node-forge` + `pdf-lib` (ডিজিটাল স্বাক্ষর) · `cors` (অন্য সাইট) · `node:crypto` (AES-256-GCM মেইল পাসওয়ার্ড, SHA-256 হ্যাশ)। বিস্তারিত: `04-security.md`।
