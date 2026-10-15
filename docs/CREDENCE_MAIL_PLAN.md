# Credence Mail → CredenceHR: একত্র করার পরিকল্পনা

**উৎস:** https://github.com/ruhulamencredence/credence-mail (commit `df9f376`)
**লক্ষ্য:** Mail-এর জন্য আলাদা কোনো app লাগবে না। "Credence Mail" CredenceHR-এর ভেতরেই একটা module হিসেবে চলবে, Ollama AI বাদে বাকি সব ফিচার নিয়ে।

---

## ১. Credence Mail-এ এখন কী আছে

| বিষয় | বিবরণ |
|---|---|
| প্রযুক্তি | React 19 + Express + MySQL (mysql2) + Tailwind 4। CredenceHR-এর সাথে মেলে। |
| Mail server | cPanel `credencehousinglimited.com`। IMAP 993 দিয়ে পড়া, SMTP 465 দিয়ে পাঠানো। Gmail, Outlook, Yahoo, Zoho-র preset-ও আছে। |
| Package | `imapflow`, `mailparser`, `nodemailer`, `dompurify`, `recharts`, `motion`, `lucide-react` |
| আকার | প্রায় ৯,০০০ লাইন। server ~২,২০০, App.tsx ~১,২০০, component ১০টা। |

**ফিচার:**
- **Mail:** Inbox, Sent, Draft, Spam, Trash, Starred / Important, label আর category। mail পড়া, খোঁজা, পড়া / না-পড়া, একসাথে অনেকগুলোর কাজ (batch), মুছে ফেলা।
- **লেখা:** Compose, Reply / Forward, attachment, draft রাখা, নির্দিষ্ট সময়ে পাঠানো।
- **Signature:** ছবি / logo সহ HTML।
- **ব্যবস্থাপনা:** Template, Filter / Rules, Contacts, Task, Calendar event।
- **Settings:** vacation responder, blocked senders, layout, ভাষা, timezone।
- **Analytics:** mail-এর হিসাব আর chart।
- **Live notification:** নতুন mail এলে সাথে সাথে জানানো।
- **Sync:** প্রতি ৩০ সেকেন্ডে background sync, প্রতিটা mailbox-এর জন্য সারাক্ষণ খোলা IMAP সংযোগ (IDLE), প্রতি মিনিটে schedule করা mail পাঠানো।

**যা আনা হবে না:** `server-ai.ts` আর এর সব `/api/ai/*` route (smart reply, compose, summary, tone, grammar, translate, categorize, reply draft, template generation)। এগুলো Ollama দিয়ে চলে। UI-র AI বোতামগুলোও বাদ যাবে।

---

## ২. যে সমস্যাগুলো পাওয়া গেছে (আনার সময় ঠিক করা হবে)

1. **অন্যের mail পড়া যায়:** `GET /api/emails?account=<অন্য email>`-এ শুধু দেখা হয় account-টা আছে কিনা, সেটা নিজের কিনা দেখা হয় না। তাই login করা যে কেউ অন্যের inbox পড়তে পারে।
2. **Encryption key দুর্বল:** `.env`-এ `ENCRYPTION_KEY` না থাকলে code-এ লেখা একটা ডিফল্ট key দিয়ে mail password encrypt হয়। Repo public, তাই সেই key সবাই দেখতে পায়।
3. **দুর্বল hash:** login-এর password hash-এ একটা নির্দিষ্ট salt দেওয়া SHA-256 ব্যবহার হয়েছে। CredenceHR-এ এর দরকারই পড়বে না, কারণ CredenceHR-এর নিজের login থাকবে।
4. **`requireAuth` অব্যবহৃত:** লেখা আছে কিন্তু কোথাও ব্যবহার হয়নি। প্রতিটা route নিজে token দেখে, ফলে কোথাও ভুলের সুযোগ থাকে।
5. **১৫০০ জনের জন্য টিকবে না:**
   - প্রতিটা mailbox-এর জন্য সারাক্ষণ একটা IMAP সংযোগ খোলা থাকে।
   - প্রতি ৩০ সেকেন্ডে সবার mail sync হয়।
   - cPanel (Dovecot) এক IP থেকে এত সংযোগ সাধারণত আটকে দেয়।
6. **PM2 cluster-এ চলবে না:** SSE live notification প্রতিটা process-এর নিজের memory-তে থাকে। Session-ও memory-তে থাকে।
7. **ডিস্কে ফাইল:** Signature logo `uploads/` ফোল্ডারে রাখা হয়।
8. **নাম মিলে যায়:** `tasks`, `events`, `settings`, `accounts`, `sessions` নামের table। CredenceHR-এ `tasks` নামে table আগে থেকেই আছে।

---

## ৩. CredenceHR-এ কীভাবে বসবে

### Login আর mailbox যুক্ত করা
- Credence Mail-এর আলাদা login বা session থাকবে না। CredenceHR-এর login (JWT, `authenticateToken`) দিয়েই চলবে।
- প্রথমবার Credence Mail খুললে **"আপনার mailbox যুক্ত করুন"** আসবে। email আর password দিলে IMAP দিয়ে যাচাই হবে, তারপর encrypt করে রাখা হবে।
- Password AES-256-GCM দিয়ে encrypt হবে। Key আসবে `.env`-এর `MAIL_ENCRYPTION_KEY` থেকে।
  - Key না থাকলে mailbox যুক্ত করা বন্ধ থাকবে, আর পরিষ্কার error দেখাবে। কোনো ডিফল্ট key থাকবে না।
- প্রতিটা mailbox CredenceHR-এর একজন user-এর (`users.id`)। একজন একাধিক mailbox যুক্ত করতে পারবেন।
- প্রতিটা query user দিয়ে ছাঁকা হবে। অন্যের mailbox কোনোভাবেই দেখা যাবে না।

### অনুমতি (CLAUDE.md-এর নিয়ম অনুযায়ী)
- **Self Service feature:** `users.can_use_mail` switch।
  - শুরুতে বন্ধ থাকবে।
  - চালু হবে Admin Panel → Users → Module Access থেকে।
  - Superadmin-এর সবসময় চালু।
- প্রতিটা `/api/mail/*` route এই switch দেখবে, আর menu-র "Credence Mail" শুধু তখনই দেখা যাবে।

### Database (সব table-এর নাম `mail_` দিয়ে শুরু)
| table | কাজ |
|---|---|
| `mail_accounts` | user_id, email, provider, IMAP / SMTP host-port, encrypt করা password, শেষ sync-এর সময় |
| `mail_messages` | user_id, account_id, IMAP UID / folder, thread, from / to / cc, subject, body, snippet, তারিখ, flag, label, category, attachment-এর তথ্য |
| `mail_attachments` | message_id, নাম, ধরন, আকার, ডেটা (দরকার হলে IMAP থেকে আনা) |
| `mail_drafts` / `mail_scheduled` | draft আর পরে পাঠানোর জন্য রাখা mail |
| `mail_templates`, `mail_filters`, `mail_contacts`, `mail_tasks`, `mail_events` | user ধরে |
| `mail_settings` | প্রতি user-এর signature, vacation responder, blocked senders, layout, ভাষা, timezone |
| `mail_signature_images` | signature logo, ডিস্কের বদলে database-এ |

- table তৈরি হবে CredenceHR-এর বিদ্যমান migration পদ্ধতিতে (`ensure…Schema`)। `memoryDbFallback.ts`-এও যোগ হবে।
- Index থাকবে (user_id, account_id, folder, date)। তালিকা আসবে পাতা ধরে।

### Sync (১৫০০ জনের উপযোগী)
- **খোলা সংযোগ:** IMAP সংযোগ খোলা থাকবে শুধু যিনি এখন Credence Mail-এ online আছেন, তাঁর জন্য (Socket.IO দিয়ে বোঝা যাবে)। চলে গেলে কয়েক মিনিট পর বন্ধ হবে।
- **বাকিরা:** তাঁদের mail sync হবে Credence Mail খুললে বা refresh চাপলে।
- **একসাথে সংযোগের সীমা:** পুরো server থেকে একসাথে সর্বোচ্চ কতটা IMAP সংযোগ খুলবে, সেটা Settings-এ ঠিক করা যাবে।
- **Background কাজ:** schedule করা mail পাঠানো আর vacation responder-এর মতো কাজ `jobRunner.ts` দিয়ে শুধু একটা worker-এ চলবে।
- **Notification:** নতুন mail এলে CredenceHR-এর Socket.IO দিয়ে `user:<id>`-কে জানানো হবে। এটা cluster আর Redis-এ কাজ করে।
  - Alert ঘণ্টাতেও দেখাতে চাইলে `createAlert` ব্যবহার হবে, তবে সেটা ঐচ্ছিক।

### Screen
- **কোথায় থাকবে:** CredenceHR-এর Self Service menu-তে "Credence Mail"।
- **Layout:**
  - ডেস্কটপে তিন ভাগ: ফোল্ডার, তালিকা, mail।
  - মোবাইলে এক ভাগ করে দেখাবে।
  - Capacitor app-এ চলবে।
- **CredenceHR-এর নিয়ম অনুযায়ী:**
  - সব popup liquid-glass ধাঁচে: Compose, Rules, Settings, Contacts, event, task।
  - নিশ্চিত হতে প্রশ্ন করবে `confirmDialog` দিয়ে, `window.confirm` নয়।
  - লোড হওয়ার সময় skeleton দেখাবে।
- **নিরাপত্তা:** HTML mail দেখানোর আগে DOMPurify দিয়ে পরিষ্কার করা হবে। বাইরের ছবি ডিফল্টে বন্ধ থাকবে, "ছবি দেখাও" চাপলে আসবে।
- **CredenceHR-এর সাথে যোগ:** Compose-এ address লেখার সময় CredenceHR-এর Employee Directory থেকেও নাম আসবে।

---

## ৪. ধাপে ধাপে কাজ

প্রতিটা ধাপের শেষে tsc (৫৭টা error, আগের মতো) আর `vite build` চলবে। তারপর একটা নকল IMAP / SMTP server দিয়ে API আর Playwright পরীক্ষা, DB আগের অবস্থায় ফেরানো, commit আর `claude/nice-fermi-0tale9`-এ push। শেষে বাংলায় রিপোর্ট।

### ধাপ ১: Server
- [ ] `MailRoutes.ts`: schema আর migration, `can_use_mail` switch (users column, Module Access route, UserManagement), অনুমতির middleware
- [ ] Mailbox যুক্ত করা, পরীক্ষা করা, সরানো (IMAP যাচাই, encrypt করে রাখা, provider preset)
- [ ] Sync: Inbox / Sent / অন্য folder (UID ধরে কেবল নতুনগুলো), mail parse, attachment-এর তথ্য
- [ ] তালিকা (folder, label, category, খোঁজা, পাতা), একটা mail, flag / label বদলানো, batch, মুছে ফেলা (IMAP-এও)
- [ ] পাঠানো (SMTP, attachment, signature), draft, schedule (jobRunner)
- [ ] Socket.IO দিয়ে নতুন mail-এর খবর, online user-দের জন্য IDLE, একসাথে সংযোগের সীমা
- [ ] নিরাপত্তা: প্রতিটা query user দিয়ে ছাঁকা, ডিফল্ট key নেই, rate limit

### ধাপ ২: মূল screen
- [ ] menu-তে জায়গা আর অনুমতি, mailbox যুক্ত করার পাতা
- [ ] folder-এর তালিকা, mail-এর তালিকা, mail পড়া (DOMPurify), Compose / Reply / Forward, attachment
- [ ] মোবাইল layout, skeleton, liquid-glass popup

### ধাপ ৩: বাকি ফিচার
- [ ] Settings: signature আর logo, vacation responder, blocked senders, layout, ভাষা, timezone
- [ ] Template, Filter / Rules, Contacts, Task, Calendar event
- [ ] Analytics, Notification panel
- [ ] CredenceHR Employee Directory থেকে address বেছে নেওয়া

---

## ৫. আপনাদের যা করতে হবে

1. **Repo private করা:** `credence-mail` repo → Settings → Danger Zone → Change visibility → **Private**।
2. **Encryption key দেওয়া:** CredenceHR server-এর `.env`-এ `MAIL_ENCRYPTION_KEY=<৬৪ অক্ষরের random hex>` লিখুন। key বানানো যাবে `openssl rand -hex 32` দিয়ে।
   - এই key হারালে সবাইকে আবার mailbox যুক্ত করতে হবে।
3. **cPanel-এর সীমা:** এক IP থেকে কতটা IMAP সংযোগ চলে, hosting-কে জিজ্ঞেস করুন। দরকার হলে বাড়িয়ে নিন।
4. **আসল mailbox দিয়ে পরীক্ষা:** এই পরিবেশ থেকে বাইরের mail server-এ সংযোগ করা যায় না, তাই আসল mailbox দিয়ে প্রথম পরীক্ষা আপনাদেরই করতে হবে।

## ৬. যা যাচাই করা যাবে না
- আসল `credencehousinglimited.com` mail server-এ login, পাঠানো আর পাওয়া।
- cPanel-এর সংযোগের সীমায় আসল আচরণ।
- ফোনে notification পৌঁছানো।
