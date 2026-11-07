# পুরো অ্যাপের টেস্ট — ৭ নভেম্বর ২০২৬

একজন software tester-এর মতো পুরো CredenceHR টেস্ট করা হয়েছে। প্রথমে কোনো code বদলানো হয়নি; পরে শুধু
দুটো মাঝারি সমস্যা (M1, M2) আর টেস্টে ধরা পড়া একটা ভুল (Task Status Overview) ঠিক করা হয়েছে। ছোট
সমস্যাগুলোর জন্য নিচে পরিকল্পনা আছে — সেগুলো এখনো বদলানো হয়নি।

টেস্টের ডাটাবেস: tutorial ডাটাবেসের কপি (প্রতিটা টেস্ট আলাদা কপিতে), আর QA suite নিজের নতুন খালি ডাটাবেস।

## ১. কী টেস্ট হয়েছে, ফল

| টেস্ট | ফল |
|---|---|
| Typecheck (`tsc --noEmit`) আর production build (vite + esbuild) | পাস |
| QA suite ১৩টা (`tests/qa/run-all.sh`) — মোট ২৬৯টা check | **১৩/১৩ পাস** |
| — unit (onboarding, hr-linkage, fingerprint, apk) | ৯০ পাস |
| — বাংলা Excel / e-sign / PDF | ৫ / ১ / ৪ পাস |
| — একসাথে চাপ (concurrency), কোম্পানি আলাদা, Group HR | ৯ / ১৮ / ২১ পাস |
| — তারিখের কিনারা, মাসের হিসাব মেলানো, Supervisor chain | ১৫ (+৩ INFO) / ৩০ / ৩৬ পাস |
| — ফর্মে টাইপ-ক্লিক, picker, ২০০০ কর্মীর বড় ডাটা | ১৩ / ৮ / ১৫ পাস |
| ৯৬৪টা API route (`02-api-sweep-964-routes.json`): login ছাড়া, সাধারণ কর্মী, module-ছাড়া admin, ভুল ইনপুট | login ছাড়া খোলে শুধু ৩টা ইচ্ছাকৃত public; কোনো 500 নেই; ১.৫ সে.-র বেশি ধীর নেই |
| ৫৫২ বার পাতা খোলা (`01-page-crawl-552.json`) — Superadmin, Duty-Roster admin, কর্মী, সাধারণ user × কম্পিউটার ও ফোন | JS error ০, পাশে স্ক্রল (overflow) ০, server error ০, ৮ সে.-র বেশি ০ |
| হাতে-কলমে নিরাপত্তা (`scripts/probes*.mjs`) | অন্যের claim/payslip দেখা-মোছা যায় না; বদলানো ও alg-none token বাতিল; profile থেকে role বাড়ে না; ৫ বার ভুল password-এ আটকায়; ঋণাত্মক/শূন্য/ভবিষ্যতের বিল বাতিল; শেষ তারিখ শুরুর আগে হলে ছুটি বাতিল; security header আছে |

টীকা: crawl-এর "সন্দেহজনক লেখা" check-এ যে ৬২টা পাতা উঠেছিল সেগুলো ভুল সংকেত — `NaN` খুঁজতে গিয়ে
"Fi**nan**ce", "Sulta**na**"-র মতো শব্দ ধরেছিল। আসল `NaN` / `undefined` / `[object Object]` কোথাও নেই।

## ২. যা পাওয়া গেছে

### মাঝারি — ঠিক করা হয়েছে

| # | সমস্যা | যা করা হয়েছে |
|---|---|---|
| M1 | PEPM-এর Budget, budget item, MPR No, Job-এর API অনুমতি দেখত না: কারো Budget switch বন্ধ থাকলেও যেকোনো login করা account এগুলো পড়তে পারত (menu শুধু লুকাত) | নতুন `requireBudgetRead` (server.ts): Superadmin, Budget switch চালু, Job Edit, বা PEPM module (Imports, MPR Nos, Reports, Projects) থাকা Admin — বাকিরা 403। আটটা GET route-এ বসানো। Admin Panel Budget / MPR তালিকা এখন শুধু Imports, MPR Nos, Reports tab-এ আনে |
| M2 | Admin Dashboard অনুমতি-ছাড়া module-এর tile ও card দেখাত ("—") আর প্রতিবার ১৩টা আটকানো request পাঠাত | প্রতিটা tile / card / request এখন নিজের module থাকলে তবেই (`AdminDashboard.tsx`, `AdminDashboardWatch.tsx`)। Duty-Roster-only admin: ০ বিদেশি tile, ০ আটকানো request; Superadmin: আগের মতো ১২টা tile, সব card |
| — | টেস্টে ধরা: Task Status Overview-এর "Check in/out" সারি আসলে অপেক্ষমাণ **Bill Claim** গুনত, Check In/Out module চাইত আর Check In/Out tab খুলত; "Monthly Claim Amount" tile-ও Check In/Out tab খুলত; Stuck তালিকায় Bill Claim-এর নাম "Conveyance bill" | সারির নাম "Bill Claim", module `bill_claim`, tab Bill Claim; tile এখন Bill Claim tab খোলে; Stuck-এ "Bill Claim" |

### ছোট — পরিকল্পনা (এখনো বদলানো হয়নি)

| # | সমস্যা | ঝুঁকি | পরিকল্পনা | কাজের পরিমাণ |
|---|---|---|---|---|
| L1 | Bill Claim-এর সংযুক্তি ফাইলের ভেতর যাচাই হয় না — HTML-কে "PDF" নাম দিলে জমা হয় (ফেরত দেয় PDF হিসেবে, `nosniff` সহ, তাই browser চালায় না) | নিম্ন | Payroll ফাইলের মতো `looksLikeType` (প্রথম কয়েক byte দেখে PDF/JPG/PNG/WebP চেনা) Bill Claim জমা ও edit-এ বসানো; না মিললে "That file isn't really a PDF / picture of that type." | ছোট — একটা ফাংশন দুই জায়গায় |
| L2 | এক বিলে ৳৯,৯৯,৯৯,৯৯৯ পর্যন্ত জমা যায়, যদি HR category-তে সর্বোচ্চ না দেয় | নিম্ন (approval লাগে) | Bill Claim Policy-তে একটা কোম্পানি-জুড়ে "এক বিলের সর্বোচ্চ" (ডিফল্ট ধরুন ৳১,০০,০০০), category-র নিজের সীমা থাকলে সেটাই; সীমার বাইরে হলে জমা বাতিল | মাঝারি — policy-তে একটা ঘর + server check |
| L3 | বছর পার হওয়া ছুটি (৩০ ডিসে.–২ জানু.) পুরোটা এই বছরের balance থেকে কাটে | নিম্ন–মাঝারি (বছর শেষে হিসাব) | ছুটির দিনগুলো বছর অনুযায়ী ভাগ করে প্রতিটা বছরের balance থেকে কাটা; বছর-শেষের carry-forward হিসাবের সাথে মিলিয়ে দেখা। HR-এর নিয়ম আগে নিশ্চিত করতে হবে (কোন বছরের balance থেকে কাটবে) | মাঝারি — leave হিসাব + টেস্ট |
| L4 | ৫ বার ভুল password-এ account ১৫ মিনিট বন্ধ, তখন সঠিক password-ও চলে না → কারো email/ID জানলে যে কেউ তাঁকে ১৫ মিনিট আটকে রাখতে পারে; এক network থেকে ৩০ বার ভুলে পুরো অফিসের network আটকে যায় | নিম্ন | বন্ধ হওয়া account-এ শুধু **অন্য network** থেকে আসা চেষ্টা আটকানো, যে network থেকে আগে সফল login হয়েছে সেখান থেকে সঠিক password চলবে; IP-সীমা অফিসের পরিচিত IP-র জন্য বাড়ানো (`.env`-এ) | মাঝারি — `LoginGuard.ts` |
| L5 | Vehicle পাতা "saved places" অনুমতি না থাকলেও চায় → 403 (কোনো ক্ষতি নেই) | খুব নিম্ন | পাতা আগে `requireSavePlaces`-এর মতো access flag জেনে নেবে, না থাকলে request পাঠাবে না | ছোট |
| L6 | `node-forge`-এ একটা high (RSA স্বাক্ষর *যাচাই*) — অ্যাপ যাচাই করে না; বাকি ৫টা moderate অন্য package-এর ভেতরে | নিম্ন | `npm audit fix` (breaking ছাড়া যতটা হয়), forge-এর নতুন সংস্করণ এলে আপডেট; মাসে একবার audit | ছোট |
| L7 | Mail template editor HTML পরিষ্কার না করে দেখায় — template শুধু নিজের | খুব নিম্ন (নিজের) | `sanitizeMailHtml` দিয়ে দেখানো, যেমন signature-এ করা আছে | ছোট |
| L8 | কয়েকটা JS ফাইল বড় (অফিসের illustration animation ৮৬৮ KB, দুটো ~৭৫০ KB) | কার্যকারিতা | animation-টা হালকা করা বা ছবি দিয়ে বদলানো; বড় chunk দুটো ভাগ করা — আগে-পরে প্রথম লোড মাপা | মাঝারি |
| — | INFO: advance notice ০ দিন হলে ৪০ দিন আগের তারিখেও ছুটি নেওয়া যায় | নীতি অনুযায়ী | HR চাইলে policy-তে "কত দিন আগের তারিখ পর্যন্ত" সীমা যোগ | — |

ক্রম (প্রস্তাব): L1 → L5 → L7 → L6 (ছোট, ঝুঁকি কম) → L2 → L4 → L3 (HR-এর সিদ্ধান্ত লাগবে) → L8।

## ৩. ফাইল

- `01-page-crawl-552.json` — প্রতিটা পাতা: কোথায় গেল, কত সময়, JS error, 4xx/5xx, overflow
- `02-api-sweep-964-routes.json` — login-ছাড়া / কম-অনুমতিতে কী খোলে, ভুল ইনপুটে 500
- `qa/*.json` — QA suite-এর ফল
- `scripts/crawl.mjs`, `scripts/probes.mjs`, `scripts/probes2.mjs` — চালানোর script (ডাটাবেসের কপি আর port নিজের মতো দিন)

পরিবেশের টীকা: টেস্টের container চলার মাঝে দুবার নিজে restart হয়েছিল, তখন MySQL বন্ধ হয়ে যায়; MySQL আবার চালু করে
ওই টেস্টগুলো আবার চালানো হয়েছে। এটা অ্যাপের সমস্যা নয়।
