# লোন: টাকা দেওয়া ও কিস্তির পরিকল্পনা — টেস্ট (৯ নভেম্বর ২০২৬)

বিবরণ: [`docs/loans-payout-and-repayment.md`](../../loans-payout-and-repayment.md)।
ডাটাবেস: tutorial ডাটাবেসের কপি (Superadmin, কর্মী Tahmid, Payroll module আছে কিন্তু Accounts Pay নেই এমন একজন Admin)।

## `scripts/loan-payout-plan.mjs` — ৪০/৪০ পাস

| # | যা দেখা হলো |
|---|---|
| L1 | কর্মী "কিস্তি শুরু" মাস দিয়ে আবেদন করেন, মাসটা সেভ হয়; ১২ মাসের বেশি পরে চাইলে বাতিল |
| L2 | Payroll অনুমোদন দিলে লোন "Waiting for payment", কর্মীর চাওয়া মাস থাকে; Accounts "Loan Ready to Pay" Alert পান |
| L3 | টাকা দেওয়ার আগে বেতন থেকে কিছু কাটা হয় না |
| L4 | কর্মী আর Accounts Pay-ছাড়া Payroll Admin টাকা দিতে পারেন না (403); Bank-এ reference ছাড়া, ভবিষ্যতের তারিখ বাতিল |
| L5 | একসাথে ৩ বার "Mark as paid" — একবারই হয়; কর্মী একবারই Alert পান |
| L6 | শুরুর মাসের আগে ০, শুরুর মাসে ৩,০০০ (১২,০০০ / ৪) |
| L7–L12 | কর্মী পরিকল্পনা বদলাতে পারেন না; Month by month-এর মোট না মিললে বাতিল, মিললে মাস ধরে ঠিক পরিমাণ; skip-এর মাসে ০; settle-এর মাসে বাকি সব; All at once; টাকা দেওয়ার আগের মাস থেকে শুরু বাতিল |
| L13–L14 | M1-এর বেতনে ৩,০০০ কাটা, বেতন Paid হলে লোনে ৩,০০০ জমা ও History-তে "Taken from salary" |
| L15–L17 | Accounts Pay-ছাড়া কেউ নগদ ফেরত লিখতে পারেন না; বাকির বেশি বাতিল; একসাথে দুবার — একবারই গোনা; বাকি সব দিলে Completed |
| L18–L19 | টাকা দেওয়া লোন মোছা যায় না; HR-এর লেখা লোনও "Waiting for payment", টাকা দেওয়ার আগে মোছা যায় |
| L20–L21 | কর্মী নিজের লোনে টাকা দেওয়ার তারিখ, মাধ্যম ও History দেখেন; Payroll-এর loan detail খুলতে পারেন না |
| L22 | আগের নিয়মে তৈরি লোন আগের মতোই প্রতি মাসে কাটে |

Browser-এ (Superadmin ডেস্কটপ, কর্মী ফোন): To Pay তালিকা, Mark as paid popup, Plan popup (Month by month, skip, settle, আগামী মাস, History), কর্মীর My Loan / Advance — কোনো JS error বা server error নেই।

চালানো: ফাইলের শুরুর মন্তব্যে env দেওয়া আছে (BASE, DB, SA_*, EMP_*, ADMIN_*)।
