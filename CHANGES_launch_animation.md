# New app icon + open animation (smile curve)

## What changed
- **App icon** (`android/app/src/main/res/mipmap-*/ic_launcher*.png`): new orange
  Credence icon. CREDENCE on top, a cream "smile" curve, HR below. Adaptive
  icon uses the round-safe layout (`ic_launcher_foreground` / `_background`).
- **Native splash** (`drawable*/splash.png`, all sizes, day + night): orange
  gradient with the new icon in the centre.
  `values/styles.xml`: `windowSplashScreenBackground` = #F47920 so Android 12+
  (which draws its own splash) is orange too, no white flash.
- **Loading screen** (`index.html`): inside the app only (`window.Capacitor`),
  the boot screen shows the same orange + icon (`public/boot/tile.png`). The
  website keeps its usual spinner.
- **Open animation** (`src/components/BootIntroAnimation.tsx`, mounted from
  `src/main.tsx` as `<BootIntroGate />`): native app only, ~4.2 s, tap to skip,
  skipped when the phone asks for reduced motion.
  Icon melts away -> CREDENCE rises -> wedge flips -> dot -> line -> smile curve
  opens -> HR + "OUR PEOPLE · OUR PRIDE / Credence Family.." -> fades into the
  app (login or Home is already rendered underneath).
- Assets: `src/assets/boot/` (letters, wedge, HR, tile, signature font).

## After pulling
    npm run build
    npx cap sync android
then build the APK as usual. The animation itself comes from the server
(the app loads hr.credencegroupbd.com), so deploying the web build updates it;
the icon and splash need a new APK.

## Note
The slogan font (Manchester Signature, typeline studio) has no licence file and
says "All Rights Reserved". Get a commercial licence or swap in a free signature
font before public release.
