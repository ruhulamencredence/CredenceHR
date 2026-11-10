# Admin Panel on a phone — test (10 নভেম্বর ২০২৬)

পরিকল্পনা ও কী হয়েছে: [`docs/plans/admin-panel-mobile.md`](../../plans/admin-panel-mobile.md)।
ডাটাবেস: tutorial ডাটাবেসের কপি, Superadmin হিসেবে; ফোন = ৩৯০ × ৮৪৪, desktop = ১৪৪০ × ৯০০।

| যাচাই | ফল |
|---|---|
| ৪৬টা module ফোনে খোলা (`scripts/admin-phone-sweep.mjs`) | পাতা পাশে সরে না ০/৪৬, JS error ০; কাটা-পড়া table শুধু ২টা grid (Duty Roster, Monthly Attendance Report — ইচ্ছাকৃত, নাম স্থির রেখে পাশে সরে) |
| কার্ডের বোতাম (`scripts/phone-card-actions.mjs`) | ৮/৮ — Departments edit, Employees popup, Approvals Approve, Users Manage |
| Sheet ও ভাঁজ (`scripts/phone-sheet-actions.mjs`) | ১৭/১৭ — sheet থেকে Department যোগ (save হয়, sheet বন্ধ, নতুন কার্ড), edit-এ sheet খোলে ও Close-এ বাতিল, Project / User Add, Remote Attendance filter Apply-এ বন্ধ ও সংখ্যা দেখায়, PEPM filter, ব্যাখ্যা খোলে; desktop-এ ফর্ম ও filter আগের জায়গায়, কিছু ভাঁজ নেই |
| Grid (`scripts/phone-grid-check.mjs`) | ৮/৮ — নাম স্থির, ≤ ১২০ px, দিন পাশে সরে, পাতা সরে না, Duty Roster-এ দিন চাপলে রং বসে |
| Desktop: প্রতিটা module-এর পুরো পাতার ছবি, কাজের আগে বনাম পরে (pixel) | layout একই; পার্থক্য শুধু header-এর তারিখ/আবহাওয়া, live ডাটা (Active Users-এর session, Dashboard সংখ্যা, Tracking মানচিত্র), test-এ যোগ করা Department আর রং-করা roster ঘর, আর অক্ষরের কিনারার কয়েক pixel |
| Typecheck, build, docs:check | পাস |
| QA suite | প্রতি ধাপে e2e-forms ১৩/১৩, pickers ৮/৮; শেষে পুরো suite **১৩/১৩ পাস** (unit, Bangla Excel / e-sign / PDF, concurrency ৯, companies ১৮, Group HR ২১, dates ১৫, month-reconcile ৩০, supervisor chain ৩৬, e2e-forms ১৩, pickers ৮, bigdata ১৫) |

চালানো: script-গুলো ফোনের ঠিকানা `http://localhost:3200` আর Superadmin `admin@credence.test` / `ProbePass123` ধরে লেখা (ডাটাবেসের কপিতে বসানো); Playwright-এর path ফাইলের প্রথম লাইনে।
