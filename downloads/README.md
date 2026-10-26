# downloads — the Android app for the login page

Put the Android app here **on the server**, named `CredenceHR.apk`:

```
CredenceHR/downloads/CredenceHR.apk
```

The login page's "Android (APK)" button downloads it from
`/downloads/CredenceHR.apk` (AndroidApkRoute.ts).

- Any name works: with no `CredenceHR.apk` here, the button sends the
  newest `.apk` in this folder, or the APK inside the newest GitHub zip
  (Actions → Android build → Artifacts → `CredenceHR-android-debug.zip`),
  and the phone always saves it as `CredenceHR.apk`. Keep only the version
  you want people to get.
- Git ignores everything in this folder except this file, so a `git pull`
  or a new build never deletes the APK, and the APK never goes into the
  repository.
- Check: `curl -I https://<your-domain>/downloads/CredenceHR.apk` should
  answer `Content-Type: application/vnd.android.package-archive`.

---

বাংলায়: সার্ভারে এই ফোল্ডারে APK (বা GitHub থেকে নামানো zip) রাখুন। নাম
বদলানো লাগবে না: login পাতার বোতাম এখানকার সবচেয়ে নতুন APK নামায়, ফোনে
নাম হয় `CredenceHR.apk`। শুধু যে version দিতে চান সেটাই রাখুন। git এই
ফোল্ডারের APK নেয় না, মোছেও না।
