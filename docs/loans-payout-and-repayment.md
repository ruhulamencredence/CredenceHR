# লোন ও Salary Advance: টাকা দেওয়া আর কিস্তির পরিকল্পনা

কর্মীর লোন বা Salary Advance অনুমোদন হওয়ার পর কে টাকা দেবেন, কীভাবে দেবেন, আর বেতন থেকে কবে কত করে কাটা হবে — পুরো ধারা।
কোড: `LoanPlan.ts` (server), `src/components/LoanPayoutPlan.tsx` ও `LoanAdvanceManagementPanel.tsx` (Payroll), `src/components/MyLoans.tsx` (কর্মী)।

## ১. পুরো ধারা এক নজরে

```
কর্মী আবেদন (My Loan / Advance)          HR নিজে লোন লেখেন (New Loan / Advance)
        │  (চাইলে: "কিস্তি শুরু কোন মাস থেকে")              │
        ▼                                                    │
Approval Chain (Supervisor → HR …) / Payroll Approve         │
        │                                                    │
        └──────────────┬─────────────────────────────────────┘
                       ▼
          Approved — "Waiting for payment"   ← এই অবস্থায় বেতন থেকে কিছু কাটা হয় না
                       │   Accounts Alert পান: "Loan Ready to Pay"
                       ▼
     Accounts টাকা দেন → Payroll → Loans & Advances → To Pay → "Mark as paid"
     (তারিখ · Cash / Bank transfer / bKash-Nagad / Cheque / Other · reference · কিস্তি শুরুর মাস)
                       │   কর্মী Alert পান: "Loan Paid to You"
                       ▼
     কিস্তির পরিকল্পনা অনুযায়ী প্রতি মাসের বেতন থেকে কাটা  ← Plan বোতামে যেকোনো সময় বদলানো যায়
     (বেতনের বাইরে নগদ / ব্যাংকে ফেরত দিলে Accounts "Repaid" দেন)
                       ▼
                 সব শোধ → Completed
```

## ২. কে কী করেন

| কাজ | কে | কোথায় | অনুমতি |
|---|---|---|---|
| আবেদন, নিজের লোন / কিস্তি / History দেখা | কর্মী | Self Service → My Loan / Advance | `users.can_view_loan_request` (Module Access-এ, শুরুতে বন্ধ) |
| অনুমোদন | Approval Chain-এর লোক, বা Payroll | Approve Applications / Payroll → Loans & Advances → Approvals | আগের মতো |
| HR নিজে লোন লেখা | HR | Payroll → Loans & Advances → New Loan / Advance | Payroll module |
| **টাকা দেওয়া ("Mark as paid")** | **Accounts** | Payroll → Loans & Advances → **To Pay** (বা তালিকার Pay out) | Payroll → **Accounts Pay** layer (শুরুতে বন্ধ; Superadmin সবসময়) |
| **কিস্তির পরিকল্পনা বদলানো ("Plan")** | HR / Payroll | তালিকার Plan বোতাম | Payroll module |
| **বেতনের বাইরে ফেরত গোনা ("Repaid")** | **Accounts** | তালিকার Repaid বোতাম | Payroll → **Accounts Pay** layer |

Payroll module থাকলেও Accounts Pay layer না থাকলে টাকা দেওয়া বা ফেরত গোনা যায় না (server 403 দেয়, বোতামও দেখায় না — তখন "Waiting for Accounts" লেখা থাকে)।

## ৩. টাকা দেওয়া ("Mark as paid")

- **তারিখ:** আজ বা আগের কোনো দিন (ভবিষ্যতের তারিখ চলে না)।
- **কীভাবে:** Cash, Bank transfer, bKash / Nagad, Cheque, Other। Bank, bKash/Nagad আর Cheque-এ **reference নম্বর বাধ্যতামূলক**।
- **কিস্তি শুরুর মাস:** ডিফল্ট টাকা দেওয়ার পরের বেতন মাস। কর্মী আবেদনে পরের কোনো মাস চেয়ে থাকলে সেটা। Accounts এখানে বদলাতে পারেন, কিন্তু টাকা দেওয়ার মাসের আগে নয়।
- একসাথে দুবার চাপলে (বা দুজন একসাথে) একবারই হয়।
- কর্মী Alert পান: কবে, কীভাবে, reference, আর কীভাবে কাটা হবে।

## ৪. কিস্তির পরিকল্পনা ("Plan")

প্রতিটা লোনের নিজস্ব পরিকল্পনা। popup-এ নিচে "Months to come" — কোন মাসে কত কাটা হবে — আর History দেখায়।

| ঘর | মানে |
|---|---|
| **Start taking from** | প্রথম যে বেতন মাস থেকে কাটা শুরু (যেমন ২ মাস পর থেকে) |
| **Equal installments** | প্রতি মাসে একই পরিমাণ (শেষ মাসে যা বাকি) |
| **All at once** | শুরুর মাসের বেতন থেকেই বাকি সবটা |
| **Month by month** | মাস ধরে আলাদা পরিমাণ, যেমন জানু ১০,০০০ · মার্চ ২০,০০০। **মোট অবশ্যই বাকি টাকার সমান** — না মিললে save হয় না, কত হলো আর কত লাগবে দেখায় |
| **Skip months** | এই মাসগুলোতে কিছু কাটা হবে না (যেমন ঈদের মাস); সমান কিস্তিতে পরিকল্পনা নিজে থেকেই পিছিয়ে যায় |
| **Take everything left in** | এই মাসে বাকি সবটা কেটে আগেই শোধ |

পরিকল্পনা বদলালে কর্মী Alert পান, আর History-তে নতুন পরিকল্পনা লেখা থাকে।

**যে মাসের বেতন আগেই বানানো হয়েছে** সেটার কাটা টাকা আগের মতো থাকে — নতুন পরিকল্পনা দিতে হলে সেই বেতন Edit বা আবার বানাতে হবে। বেতন Paid হলে সেই বেতনে যা কাটা হয়েছিল তার **পুরোটাই** লোনে জমা হয়: আগে পরিকল্পনা অনুযায়ী, বেশি থাকলে সবচেয়ে পুরনো বকেয়া লোনে — টাকা কখনো হারায় না।

## ৫. বেতনের বাইরে ফেরত ("Repaid")

কর্মী নগদে বা ব্যাংকে কিছু বা সব টাকা ফেরত দিলে Accounts লেখেন: পরিমাণ (বাকির বেশি নয়), তারিখ, কীভাবে, reference। সঙ্গে সঙ্গে বাকি কমে; পুরোটা হলে লোন Completed। একসাথে দুবার চাপলে একবারই গোনা হয়।

## ৬. কর্মী কী দেখেন (My Loan / Advance)

- আবেদনে ঐচ্ছিক ঘর: **"Start the installments from"** — এ মাস থেকে ১২ মাসের মধ্যে।
- প্রতিটা লোনে: **Waiting for payment** (Accounts এখনো দেননি — বেতন থেকে কিছু কাটা হচ্ছে না) অথবা **Paid to you** তারিখ ও মাধ্যম; কীভাবে কাটা হবে; আগামী মাসগুলোর কিস্তি; History (অনুমোদন, টাকা দেওয়া, পরিকল্পনা বদল, বেতন থেকে কাটা, নগদ ফেরত)।

## ৭. অন্য জায়গায় প্রভাব

- **Exit / Offboarding-এর পাওনা** আর **HR-এর লোন রিপোর্ট:** শুধু যে লোনের টাকা দেওয়া হয়েছে সেটাই বকেয়া ধরা হয়।
- **মোছা:** টাকা দেওয়া লোন মোছা যায় না (Completed করতে হয়); টাকা দেওয়ার আগে মোছা যায়।
- **আগের লোন:** এই পরিবর্তনের আগের সব লোন "paid out" ধরা হয়, আর আগের মতোই প্রতি মাসে সমান কিস্তি কাটে — কিছু করতে হবে না। চাইলে Plan দিয়ে বদলানো যায়।

## ৮. প্রযুক্তিগত (ডেভেলপারদের জন্য)

- `employee_advances`-এ নতুন: `disbursement_status` (`pending` / `paid`, আগের সারির জন্য ডিফল্ট `paid`), `disbursed_at`, `disbursed_by`, `disbursement_method`, `disbursement_reference`, `repay_start_month` (`YYYY-MM`), `repay_mode` (`equal` / `lump` / `custom`), `repay_schedule` (JSON `{"YYYY-MM": amount}`), `skip_months` (JSON array), `settle_month`।
- `advance_requests.preferred_start_month`; নতুন টেবিল `loan_events` (advance_id, event: `created` / `approved` / `disbursed` / `plan` / `salary` / `repaid`, amount, event_date, method, reference, note, created_by)।
- একটাই নিয়ম `installmentFor(adv, month)` — বেতনের চার হিসাব (preview, bulk, একজনের, edit) আর `settlePaidPayroll` সবাই এটা ব্যবহার করে। `planPreview()` আগামী মাসগুলো (সর্বোচ্চ ৬০ মাস) হিসাব করে।
- API: `GET /api/payroll/advances/:id/detail` (Payroll), `POST …/disburse` (Accounts Pay), `PUT …/plan` (Payroll), `POST …/repay` (Accounts Pay); কর্মীর `GET /api/my-loans` প্রতিটা লোনে পরিকল্পনা, আগামী মাস ও History দেয়।
- টেস্ট: `docs/test-logs/2026-11-09/scripts/loan-payout-plan.mjs` — ৪০/৪০ পাস।
