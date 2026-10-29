# CredenceHR — Architecture ও Security ডকুমেন্টেশন

> তৈরি: ২৫ অক্টোবর ২০২৬। ভিত্তি: কোড, চালু ডাটাবেস ও স্বয়ংক্রিয় টেস্ট। **ইন্টারনেট ছাড়া দেখতে `index.html` ব্রাউজারে খুলুন** (সব ডায়াগ্রামসহ)।

## কী কোথায়

| আপনার প্রয়োজন | ফাইল |
|---|---|
| **ডাটাবেস ডায়াগ্রাম** (<!--n:tables-->২১৮<!--/n--> টেবিল, ১৩ মডিউলে ভাগ) | [`database/README.md`](database/README.md) ও **[`database/full-diagram.html`](database/full-diagram.html) (পুরো ২১২ টেবিল এক ছবিতে)** |
| ডাটাবেসের প্রতিটি টেবিল-কলামের তালিকা | [`database/data-dictionary.md`](database/data-dictionary.md) |
| **পুরো application workflow** (architecture, লগইন, অনুমতি, ছুটি, বেতন, ক্লেইম, ই-স্বাক্ষর, কর্মীর জীবনচক্র…) | [`02-application-workflow.md`](02-application-workflow.md) |
| **কোথায় কোন লাইব্রেরি, কেন, কী সুবিধা** | [`03-technology-and-libraries.md`](03-technology-and-libraries.md) |
| লাইব্রেরির পূর্ণ তালিকা ও লাইসেন্স (৭২৬টি) | [`dependency-sbom.csv`](dependency-sbom.csv) |
| **Application Security** (দাবি + প্রমাণ + সৎ সীমাবদ্ধতা) | [`04-security.md`](04-security.md) |
| কে কোন মডিউলে কী করতে পারে (অনুমতি তালিকা) | [`security/access-control-matrix.md`](security/access-control-matrix.md) |
| **নিরাপত্তা প্রশ্ন করলে উত্তর** (প্রশ্ন-উত্তর, প্রমাণসহ) | [`05-security-questions-and-answers.md`](05-security-questions-and-answers.md) |
| টেস্টের ফল ও লগ | [`../HR-Review-and-Test-Log-2026-10-19.md`](../HR-Review-and-Test-Log-2026-10-19.md), [`../HR-Review-Retest-2026-10-25.md`](../HR-Review-Retest-2026-10-25.md), [`../test-logs/`](../test-logs/) |
| কোড কাঠামো (Laravel/MVC তুলনায়) | [`../CredenceHR-Code-Guide-for-Laravel-Developers-BN.md`](../CredenceHR-Code-Guide-for-Laravel-Developers-BN.md) |

---

## ডকুমেন্ট প্রস্তুতি: প্রশ্ন করলে দেখানোর মতো কী আছে, কী নেই

### ✅ প্রস্তুত (দেখানো যায়)

| ডকুমেন্ট | অবস্থা |
|---|---|
| ডাটাবেস ডায়াগ্রাম ও data dictionary | ✅ নতুন (এই ফোল্ডার) |
| Application workflow ও architecture | ✅ নতুন |
| প্রযুক্তি ও লাইব্রেরি তালিকা + লাইসেন্স (SBOM) | ✅ নতুন |
| Security বিবরণ + Access control matrix | ✅ নতুন |
| নিরাপত্তা প্রশ্ন-উত্তর | ✅ নতুন |
| টেস্ট রিপোর্ট ও লগ (২ বছর/৫ বছর সিমুলেশন, ভাঙার চেষ্টা, UI স্মোক) | ✅ |
| ব্যবহারকারী নির্দেশিকা (বাংলা, ৩৩ পাতা PDF) | ✅ `docs/CredenceHR-User-Manual-Bangla.pdf` |
| প্রজেক্ট README (ইনস্টল, চালানো, APK) | ✅ `README.md` |
| ফিচারের পরিবর্তন লগ | ✅ `CHANGES*.md`, git ইতিহাস |
| Credence Mail পরিকল্পনা | ✅ `docs/CREDENCE_MAIL_PLAN.md` |
| ডিপ্লয়ের নমুনা (Nginx) | ✅ `deploy/nginx.conf.example`, `ecosystem.config.cjs` |
| উন্নয়ন নিয়ম (অনুমতি, popup) | ✅ `CLAUDE.md` |
| Privacy Policy (অ্যাপে পেজ) | ⚠️ আছে; আইনজীবীকে দিয়ে মেলান |

### ❌ নেই বা অসম্পূর্ণ (প্রশ্ন এলে এগুলোর অভাবই ধরা পড়বে)

| ডকুমেন্ট/কাজ | গুরুত্ব | কে করবে | মন্তব্য |
|---|---|---|---|
| **ব্যাকআপ ও ডিজাস্টার রিকভারি পরিকল্পনা** (কত পরপর, কোথায়, কে পুনরুদ্ধার করবে, একবার পরীক্ষা) | 🔴 উচ্চ | IT/হোস্টিং | ফাইলও ডাটাবেসে, তাই MySQL ব্যাকআপই সব। সফটওয়্যারে স্বয়ংক্রিয় ব্যাকআপ নেই |
| **নিরাপত্তা-ঘটনার প্রতিক্রিয়া পরিকল্পনা** (কে কাকে জানাবে, কী করবে) | 🔴 উচ্চ | IT + ম্যানেজমেন্ট | প্রযুক্তিগত হাতিয়ার আছে (`04-security.md` §১২), প্রক্রিয়া লিখতে হবে |
| **বাইরের Penetration Test রিপোর্ট** | 🔴 উচ্চ | বাইরের প্রতিষ্ঠান | আমাদের টেস্ট বাইরের পরীক্ষার বদলি নয় |
| **ডাটা সংরক্ষণ ও মোছার নীতি** (কোন তথ্য কত বছর) | 🟠 মাঝারি | HR + আইন | শ্রম আইন অনুযায়ী বেতন/সেবা-রেকর্ড কত বছর, অ্যাকাউন্ট বন্ধের পর কী |
| **ডাটা শ্রেণিবিন্যাস** (কোনটি গোপনীয়: বেতন, NID, লোকেশন) | 🟠 মাঝারি | HR + IT | কে NID/ফোন দেখবে সিদ্ধান্তসহ |
| **ইনফরমেশন সিকিউরিটি নীতি** (পাসওয়ার্ড, ডিভাইস, অ্যাক্সেস, কর্মী-দায়িত্ব) | 🟠 মাঝারি | IT + ম্যানেজমেন্ট | সফটওয়্যারের কড়াকড়ি নীতির সাথে মেলাতে হবে |
| **অ্যাক্সেস পর্যালোচনা প্রক্রিয়া** (কে কোন Admin অনুমতি পেয়েছে, প্রতি ৩/৬ মাসে দেখা) | 🟠 মাঝারি | HR + Superadmin | `access-control-matrix.md` ভিত্তি; Module Access-এ রিপোর্ট নেই |
| লাইব্রেরি হালনাগাদ ও `npm audit` প্রক্রিয়া | 🟡 নিম্ন–মাঝারি | ডেভেলপার | মাসে একবার, লিখিত |
| হোস্টিং ও নেটওয়ার্ক নিরাপত্তা নথি (ফায়ারওয়াল, TLS, ডিস্ক এনক্রিপশন, SSH) | 🟠 মাঝারি | হোস্টিং/IT | সফটওয়্যারের বাইরে |
| API ডকুমেন্টেশন (OpenAPI) | 🟡 নিম্ন | ডেভেলপার | ৭০০+ route; এখন প্রতি ফাইলের শুরুর মন্তব্য |
| ডাটা প্রবাহ ডায়াগ্রাম (ব্যক্তিগত তথ্য কোথা দিয়ে যায়, বাইরের সেবাসহ) | 🟡 নিম্ন–মাঝারি | ডেভেলপার | `04-security.md`-র তৃতীয়-পক্ষ তালিকা ভিত্তি |
| ISO 27001 / SOC 2 ইত্যাদি সার্টিফিকেশন | 🟡 নিম্ন | ম্যানেজমেন্ট | ক্লায়েন্ট চাইলে |

### কয়েকটি দ্রুত কাজ যা প্রশ্নের উত্তর বদলে দেয়

1. লাইভের `.env`-এ `CORS_ORIGINS` সেট করা। 2. পাসওয়ার্ডের নীতি ৮+ অক্ষর ও সাধারণ পাসওয়ার্ড বাদ। 3. ✅ অব্যবহৃত লাইব্রেরি বাদ — GPL-3.0 `@mlightcad/libredwg-web`, `dxf-parser`, `motion` (২৫ অক্টোবর ২০২৬)। 4. ডাটাবেস ব্যাকআপ চালু করে **একবার পুনরুদ্ধার পরীক্ষা**। 5. Penetration test বুক।

---

## ডকুমেন্ট হালনাগাদ রাখার নিয়ম (স্বয়ংক্রিয় আপডেট)

**নিজে থেকে যা হয়:** `main` বা `claude/nice-fermi-0tale9`-এ কোড, `schema.sql`, `package.json` বা এই ফোল্ডারে কিছু push হলেই GitHub-এর **Docs sync** কাজটি (`.github/workflows/docs-sync.yml`) চলে। এটি:

1. খালি MariaDB-তে সার্ভার একবার চালিয়ে সব টেবিল বানায়, তারপর `information_schema` পড়ে।
2. নতুন করে বানায়: `database/README.md`-এর সংখ্যা ও মডিউল অংশ, `data-dictionary.md`, সব মডিউল ডায়াগ্রাম (`.mmd/.svg/.png`), পুরো ডাটাবেসের ছবি (SVG ও `full-diagram.html`; বড় PNG/PDF শুধু artifact-এ), `credencehr-database.drawio`।
3. `security/access-control-matrix.md` (`src/types.ts` থেকে) আর `dependency-sbom.csv` (`package-lock.json` থেকে) বানায়।
4. সব HTML বানায়, এক-ফাইলের `CredenceHR-Documentation.html` ও `CredenceHR-Full-Workflow.html`-সহ।
5. বদল থাকলে একই ব্রাঞ্চে `docs: auto-sync ...` নামে কমিট করে।
6. এক-ফাইলের দুটো HTML আর পুরো ডাটাবেসের PNG/PDF **repo-তে commit করে না** (প্রতিবার ~১৩MB করে repo বাড়াত)। এগুলো রানের **Artifacts → `CredenceHR-documentation`**-এ থাকে (৯০ দিন), আর নিজের কম্পিউটারে `npm run docs:sync` / `docs:db` চালালে `docs/architecture`-তেই তৈরি হয়। ব্রাউজারে পড়তে repo-র `docs/architecture/index.html` খুলুন (ইন্টারনেট লাগে না)।

একই push-এ **QA tests** কাজটিও (`.github/workflows/qa-tests.yml`) চলে: unit টেস্ট, একসাথে দুবার চাপ, কোম্পানি আলাদা রাখা, তারিখের কিনারা, approval chain, আসল ব্রাউজারে ফর্ম পূরণ, বাংলা PDF/Excel ও ২০০০ কর্মীর গতি — প্রতিটা নতুন খালি ডাটাবেসে (`tests/qa/run-all.sh`)। কোনো টেস্ট ফেল করলে রান লাল হয়; ফল, PDF ও ফেল করা ধাপের ছবি Actions-এর "qa-results"-এ থাকে। নিজের কম্পিউটারে: `bash tests/qa/run-all.sh` (ডাটাবেস `mpr_tracker_db` মুছে নতুন বানায় — আসল ডাটার সার্ভারে চালাবেন না)।

নতুন টেবিল নামের মিল বা FK দেখে নিজেই কোনো মডিউলে বসে (`tools/db/groups.json`)। ভুল মডিউলে গেলে ওই ফাইলে সরিয়ে দিন।

**হাতে যা লিখতে হয়** (Docs sync রানের Summary-তে ও `npm run docs:check`-এ সতর্কবার্তা আসে):
- নতুন লাইব্রেরি হলে: `03-technology-and-libraries.md`-এ এক সারি (কেন, কী সুবিধা)।
- নতুন workflow বা অনুমোদনের নিয়ম বদলালে: `02-application-workflow.md`।
- নিরাপত্তায় বদল হলে: `04-security.md` ও `05-security-questions-and-answers.md`।
- নতুন মডিউলের বর্ণনা: `tools/db/module-notes.json`।

**নিজের কম্পিউটারে চালাতে:**

| কমান্ড | কী করে |
|---|---|
| `npm run docs:check` | কিছু না বদলে দেখায় কী পুরনো হয়েছে |
| `npm run docs:sync` | Access Matrix, SBOM ও সব HTML (ডাটাবেস লাগে না) |
| `npm run docs:db` | সাথে ডাটাবেসের সবকিছু। `DB_*` env-এ একটা **খালি** ডাটাবেস দিন, লাগবে python3 (`pip install markdown`) ও Playwright Chromium |

`README.md`-এর `<!-- AUTO:... -->` ও `<!--n:...-->` চিহ্নের ভেতরের লেখা স্ক্রিপ্ট লেখে, হাতে বদলাবেন না। বাকি সব লেখা হাতে লেখা এবং স্ক্রিপ্ট সেগুলো ছোঁয় না।
