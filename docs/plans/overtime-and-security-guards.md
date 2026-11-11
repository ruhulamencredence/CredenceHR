# পরিকল্পনা: Overtime (OT) নিজে হিসাব, Roster-এ OT, Payroll — আর Security Guard

অবস্থা: **তৈরি** (2026-11-11) — আগের ৩টা প্রশ্ন system-এর setting। কীভাবে চলে: `docs/architecture/02-application-workflow.md` → "Overtime (OT) আর Security Guard"। তারিখ: 2026-11-11।

## এখন কী আছে

- **Duty Roster** (`RosterRoutes.ts`): shift (নাম, কোড, শুরু-শেষ, grace), প্রতি কর্মী প্রতি দিনে একটা shift বা Off।
- **Attendance report** (`PayrollRoutes.ts` custom report): প্রতিদিন `overtime_minutes` = shift শেষ হওয়ার পর যতক্ষণ ছিলেন; Off দিনে পুরো কাজের সময়। শুধু report-এ দেখায়।
- **Payroll**: Run Payroll-এ OT ঘণ্টা আর rate **হাতে লিখতে হয়** (`RunPayrollWizard.tsx`), "Attendance & OT" tab-এ হাতে বদলানো যায়। কে OT পাবেন, rate কত — কোনো নিয়ম নেই; OT-র কোনো অনুমোদন নেই।
- **Site Attendance** (টিম, Supervisor muster) আছে; Guard-এর post, ১২ ঘণ্টার shift, রাতের shift, relief — আলাদা কিছু নেই।

## কী চাই

1. OT **নিজে হিসাব** হবে (punch / app check-in / muster থেকে)।
2. **Roster-এ** ঠিক করা যাবে কে OT পাবেন, কোন দিন কত ঘণ্টা OT ধরা আছে।
3. **Rate**-এর নিয়ম থাকবে, আর অনুমোদিত OT **Payroll-এ নিজে বসবে**।
4. **Security Guard**: post, shift, roster, হাজিরা, relief, OT — সব এক জায়গায়।

## ১. OT নিয়ম (Payroll → Settings → Overtime)

| ঘর | প্রস্তাবিত শুরুর মান | মানে |
|---|---|---|
| **Rate-এর ধরন** (setting, বেছে নেওয়া যায়) | **শ্রম আইন**: মূল বেতন ÷ ২০৮ × ২ প্রতি ঘণ্টা | অথবা **নির্দিষ্ট টাকা / ঘণ্টা**, অথবা **gross ÷ ২০৮ × গুণক** |
| ভাগ করার সংখ্যা | ২০৮ (৮ ঘণ্টা × ২৬ দিন) | বদলানো যায় |
| সাধারণ দিনের গুণক | ২× | |
| ছুটি / Off দিনের গুণক | ২× (চাইলে বেশি) | Off দিনে বা সরকারি ছুটিতে কাজ |
| কত মিনিট পর থেকে ধরা | ৩০ মিনিট | তার কম হলে OT নয় |
| গোল করা | নিচের দিকে ৩০ মিনিটে | ১ ঘ ৪৫ মি → ১ ঘ ৩০ মি |
| দিনে সর্বোচ্চ | ২ ঘণ্টা (সাধারণ), Off দিনে পুরো shift | তার বেশি হলে "অনুমোদন লাগবে" |
| মাসে সর্বোচ্চ | (ফাঁকা = নেই) | |
| **কে অনুমোদন দেবেন** (setting) | টিম Supervisor | অথবা Roster manager, অথবা "যেকোনো একজন", অথবা "দুজনই, একের পর এক" — অনুমোদিত না হলে Payroll-এ যায় না |

**নিজের rate (পদ বা কর্মী ধরে)**: নিয়মের rate-এর উপরে আলাদা rate বসানো যায় — যেমন "Security Guard: ৳১০০ / ঘণ্টা, Off দিনে ৳১৫০", "Driver: শ্রম আইন"। কর্মীর নিজের rate > পদের rate > সাধারণ নিয়ম।

উদাহরণ (শ্রম আইন): মূল বেতন ১২,০০০ → ঘণ্টাপ্রতি ১২,০০০ ÷ ২০৮ = ৫৭.৬৯ → OT ২× = **১১৫.৩৮ টাকা / ঘণ্টা**।

## ২. কে OT পাবেন — Roster-এ

- কর্মীর **OT পাবেন / পাবেন না** সুইচ (Employee-এ, Duty Roster-এর তালিকাতেও এক ক্লিকে)। শুরুতে বন্ধ; Guard, Driver, factory staff-এর মতো পদে একসাথে চালু করা যাবে।
- কর্মীর নিজের rate বদলানো যায় (নির্দিষ্ট টাকা / ঘণ্টা) — না দিলে নিয়মের rate।
- **Shift-এ "স্বাভাবিক সময়" আর "তার বেশি সময়" (setting, প্রতি shift-এ)**: প্রতিটা shift-এ বেছে নেওয়া যায় —
  - **OT হিসেবে টাকা**: যেমন Guard-এর ১২ ঘণ্টার shift, স্বাভাবিক ৮ ঘণ্টা → প্রতিদিন **৪ ঘণ্টা OT ধরা আছে**, আলাদা করে চাইতে হয় না;
  - **বেতনের মধ্যেই**: স্বাভাবিক = ১২ ঘণ্টা, OT নেই (শুধু shift-এর পরে থাকলে OT)।
  এক company এক নিয়ম, অন্য company অন্য নিয়ম রাখতে পারে।
- **দিনের ঘরে OT**: Roster-এর কোনো দিনে "+২ ঘ OT" বসানো যায় (আগে থেকে অনুমোদিত)। তার বেশি থাকলে বাড়তিটা অনুমোদনের অপেক্ষায়।

## ৩. হিসাব কীভাবে

প্রতিদিন প্রতি কর্মীর জন্য (রাতের shift পরের দিন সকালে শেষ হলে সেই shift-এর দিনেই ধরা):
1. কাজের সময় = প্রথম In থেকে শেষ Out (office device, app check-in/out, বা site muster-এর In/Out)।
2. সাধারণ দিনে OT = shift-এর স্বাভাবিক সময়ের পরে যতক্ষণ; Off দিন / ছুটিতে = পুরো কাজের সময় (ছুটির গুণকে)।
3. "কত মিনিট পর থেকে" আর "গোল করা" লাগানো; দিনের সর্বোচ্চ পার হলে বাড়তিটা আলাদা লাইনে "অনুমোদন লাগবে"।
4. Roster-এ আগে থেকে বসানো OT পর্যন্ত নিজে **অনুমোদিত**; বাকিটা **অপেক্ষায়**।
5. OT পান না এমন কর্মীর বাড়তি সময় শুধু report-এ দেখায়, টাকা হয় না।

নতুন টেবিল `ot_entries` (কর্মী, তারিখ, হিসাবকৃত মিনিট, অনুমোদিত মিনিট, ধরন সাধারণ/ছুটি, অবস্থা, কে অনুমোদন দিলেন) — রোজ রাতে (আর punch এলে) নতুন করে হিসাব, অনুমোদিত ঘর বদলায় না।

## ৪. অনুমোদন

- **কে অনুমোদন দেবেন** — OT নিয়মের setting থেকে (টিম Supervisor / Roster manager / যেকোনো একজন / দুজনই পরপর)। দুজনই হলে প্রথমজন দিলে দ্বিতীয়জনের কাছে যায়; এক টিমের OT অন্য টিমের Supervisor-এর কাছে যায় না।
- **OT Approval** (Duty Roster-এর ভেতরে, layer `ot_approve`): নিজের টিম / Department-এর অপেক্ষমাণ OT — দিন ধরে, পাশে punch-এর সময়; টিক দিয়ে একসাথে Approve, কমানো (trim), বাতিল।
- Payroll চালানোর আগে Payroll-এ সতর্কতা: "এই মাসে ১২টা OT অনুমোদনের অপেক্ষায়"।

## ৫. Payroll-এ

- Run Payroll: প্রতিটা সারিতে **OT ঘণ্টা, rate, টাকা নিজে বসে** — অনুমোদিত OT থেকে (সাধারণ আর ছুটি আলাদা গুণকে)। পাশে "কোথা থেকে" খুললে দিন ধরে তালিকা।
- হাতে বদলানো যায়, কিন্তু কারণ লিখতে হয় (activity log-এ থাকে)।
- Payslip-এ "Overtime: ১৮ ঘ × ১১৫.৩৮ = ২,০৭৬.৯২"।
- "See salary amounts" না থাকলে rate আর টাকা `*****` (আগের নিয়মেই)।

## ৬. Security Guard

**Post** (Duty Roster → Posts, layer `guard_posts`): Project / site, post-এর নাম (Main Gate, Store, Night Patrol), কোন shift-এ কতজন লাগবে (যেমন Day ২, Night ২)। Post শুধু "কে কোথায় ডিউটিতে" দেখানোর জন্য — হাজিরার জন্য আলাদা কিছু লাগে না।

**Shift**: Guard Day ০৮:০০–২০:০০, Guard Night ২০:০০–০৮:০০ (পরের দিন) — বাড়তি ৪ ঘণ্টা OT হবে নাকি বেতনের মধ্যে, সেটা shift-এর setting (উপরে ২ নং)।

**Roster**: post × দিন × shift-এ guard বসানো। **ঘোরানোর ছক** (pattern): যেমন "৬ দিন ডিউটি, ১ দিন Off", "প্রতি সপ্তাহে Day ↔ Night বদল" — এক ক্লিকে মাসভর বসানো। খালি post লাল দেখায়।

**হাজিরা — সব কর্মীর মতোই**: guard অন্য সবার মতো app-এ **Check In / Check Out** দেন (আগের নিয়মেই: project-এর location-এর ভেতরে), অথবা office device punch, অথবা site Supervisor **Site Attendance (muster)**-এ হাজিরা দেন — যেটাই হোক, OT সেখান থেকেই হিসাব হয়। Guard-এর জন্য আলাদা GPS / QR / টহল **নেই**।

**Relief / Double duty**: কেউ না এলে Supervisor একজন relief guard বসান (এক ক্লিকে, যাঁরা Off আছেন তাঁদের তালিকা থেকে)। পরপর দুই shift (২৪ ঘণ্টা) করলে দ্বিতীয় shift পুরোটা OT (অনুমোদনের অপেক্ষায়)।

**Report**: post coverage (কোন post কতবার খালি ছিল), guard-ভিত্তিক হাজিরা, OT ঘণ্টা ও টাকা, relief-এর হিসাব।

## অনুমতি (CLAUDE.md)

- Payroll → নতুন layer **`ot_rules`** (OT নিয়ম বদলানো) — explicit-only।
- Duty Roster → নতুন layer **`ot_approve`** (OT অনুমোদন) আর **`guard_posts`** (post বানানো / বদলানো) — explicit-only; Department Access আগের মতো (নিজের Department-এর লোক)।
- Self Service → **My OT** (নিজের OT, অবস্থা) — `users.can_view_my_ot`, শুরুতে বন্ধ।
- টাকা সবখানে "See salary amounts" মেনে।

## ধাপ

1. OT নিয়ম (rate-এর ধরন, কে অনুমোদন দেবেন, পদ / কর্মী ধরে rate) + কর্মীর OT সুইচ + shift-এর স্বাভাবিক সময় ও "বাড়তি সময় OT না বেতনে" (ডাটা, API, Settings পাতা)।
2. দৈনিক হিসাব `ot_entries` (রাতের shift সহ) + Roster-এ দিনের OT।
3. OT Approval পাতা (টিক দিয়ে একসাথে)।
4. Payroll-এ নিজে বসা + কারণসহ বদল + payslip।
5. Guard: Post, ঘোরানোর ছক, coverage, relief (হাজিরা আগের Check In / Site Attendance থেকেই)।
6. My OT (Self Service)।
7. টেস্ট: শ্রম আইনের rate; রাতের shift মধ্যরাত পার; Off দিনে কাজ; দিনের সর্বোচ্চ; গোল করা; অনুমোদিত ছাড়া Payroll-এ না যাওয়া; Guard-এর ১২ ঘণ্টায় ৪ ঘণ্টা (OT setting) আর ০ ঘণ্টা (বেতনে setting); muster থেকে OT; অনুমোদনকারী setting বদলালে ঠিক লোকের কাছে যাওয়া; relief-এর ২৪ ঘণ্টা; অনুমতিহীন কেউ API দিয়ে অনুমোদন দিতে পারেন না।
8. Docs: 02 (OT ধারা), 04/05 (কে অনুমোদন, টাকা), groups.json।

## আগের প্রশ্নগুলো — এখন setting

| প্রশ্ন | কোথায় বদলাবেন | শুরুর মান |
|---|---|---|
| Rate-এর ধরন | Payroll → Settings → Overtime → Rate-এর ধরন (+ পদ / কর্মী ধরে নিজের rate) | শ্রম আইন (মূল ÷ ২০৮ × ২) |
| Guard-এর ১২ ঘণ্টার বাড়তি ৪ ঘণ্টা OT কিনা | Duty Roster → Shifts → প্রতি shift-এ "স্বাভাবিক সময়" আর "বাড়তি সময়: OT হিসেবে টাকা / বেতনের মধ্যেই" | OT হিসেবে টাকা |
| কে OT অনুমোদন দেবেন | Payroll → Settings → Overtime → কে অনুমোদন দেবেন | টিম Supervisor |
| Guard-এর check-in | আলাদা কিছু নয় — সবার মতো Check In / Out, বা Site Attendance muster | — |

মকআপ: https://claude.ai/artifact/C4Eu92Py9JYKFBpCVzCjkW (বোর্ড ০ = পুরোটা এক পাতায়)।
