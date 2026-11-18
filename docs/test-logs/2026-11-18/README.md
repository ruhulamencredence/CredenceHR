# Test log — 18 November 2026

## App-এর ভেতর থেকেই APK update (Android)

"Update available"-এ **Update now** চাপলে নতুন APK এখন app নিজেই নামায় (`AppUpdaterPlugin.java`, `src/lib/appUpdater.ts`, `AppUpdatePrompt.tsx`)। নামানোর সময় % আর MB দেখায়। প্রথমবার Android-এর "Allow from this source" চালু করতে বলে, তারপর Android-এর Install পর্দা খোলে। নতুন version-এ চালু হলে "CredenceHR updated to …" দেখায়। নামানো ব্যর্থ হলে Try again আর Download in browser। এই plugin ছাড়া পুরনো APK আগের মতোই browser-এ পাঠায়।

- `scripts/in-app-update-ui.cjs`: **20/20** (Pixel 7 Chromium, ভুয়া Android bridge যা `App.getInfo` আর `AppUpdater`-এর উত্তর দেয়; `/api/app/android-latest` নতুন version দেখায়)।
  - **ok:** popup দেখায়; নামানোর সময় "48%, 11.4 / 23.8 MB", Later নেই, Cancel আছে; একবারের অনুমতি চায়; এই server-এর পুরো APK link নামায়; অনুমতির পর installer খোলে; browser লাগে না; কোন version বসছে মনে রাখে; page error নেই।
  - **allowed:** অনুমতি আগে থেকে থাকলে সোজা installer।
  - **fail:** কারণ দেখায় (HTTP 503), Download in browser আছে, Later ফিরে আসে।
  - **old:** plugin ছাড়া APK-তে Update now আছে, app-এর ভেতরে নামানোর চেষ্টা হয় না।
  - **restart:** "CredenceHR updated to 2.4.1" একবার দেখায়, নিজে সরে যায়।
- আসল ফোনে চালানো হয়নি। Java অংশ GitHub-এর Android build compile করে।
