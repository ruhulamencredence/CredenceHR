# downloads — the Android app for the login page

Put the Android app here **on the server**, named `CredenceHR.apk`:

```
CredenceHR/downloads/CredenceHR.apk
```

The login page's "Android (APK)" button downloads it from
`/downloads/CredenceHR.apk` (AndroidApkRoute.ts).

- From GitHub (Actions → Android build → Artifacts) you get
  `CredenceHR-android-debug.zip`. Unzip it and rename `app-debug.apk` to
  `CredenceHR.apk`, or drop the zip in here as it is: the server sends the
  APK inside it.
- Git ignores everything in this folder except this file, so a `git pull`
  or a new build never deletes the APK, and the APK never goes into the
  repository.
- Check: `curl -I https://<your-domain>/downloads/CredenceHR.apk` should
  answer `Content-Type: application/vnd.android.package-archive`.

---

বাংলায়: সার্ভারে এই ফোল্ডারে APK রাখুন, নাম `CredenceHR.apk`। GitHub থেকে
নামানো zip খুলে ভেতরের `app-debug.apk`-এর নাম বদলে দিন, অথবা zip-টাই
রাখুন। git এই ফোল্ডারের APK নেয় না, মোছেও না।
