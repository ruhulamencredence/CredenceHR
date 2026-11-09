// The APK build no longer bundles the frontend locally. Instead it points the
// WebView straight at a server URL — the app opens exactly like a browser
// hitting that URL, so it always loads the latest deployed version and every
// relative /api/... call already resolves to the right backend (see
// src/lib/api.ts) with zero extra configuration.
//
// The app opens the DOMAIN only (https), never the server's IP address.
// Chat calls and voice messages need the microphone, and the WebView only
// hands that out on a secure origin: https:// with a domain name (the
// certificate belongs to the domain, not to an IP). A plain http://<ip>
// address loads the app but calls fail, so it is refused here at build time.
//
// To build against a different server, set CAP_SERVER_URL (the cloud builds,
// .github/workflows/ios.yml and android.yml, do this). It must be
// https://<domain>; the only other form allowed is http://localhost:<port>
// for testing on a phone connected by USB (run `adb reverse tcp:3000
// tcp:3000` first) — localhost counts as secure, so calls work there too.
// Each change needs a rebuild + re-sync:
//   npm run build
//   npx cap sync android

// The live server. The same address the iPhone app and the website use.
const SERVER_DOMAIN_URL = 'https://hr.credencegroupbd.com';

function checkedServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CAP_SERVER_URL "${raw}" is not a valid URL — use https://<domain> (no trailing slash).`);
  }
  if (url.protocol === 'http:' && url.hostname === 'localhost') return url;
  if (url.protocol !== 'https:') {
    throw new Error(`CAP_SERVER_URL "${raw}" must start with https:// — the app opens the domain only (calls need a secure address).`);
  }
  // IPv4 (203.95.222.58) or IPv6 ([::1]) instead of a domain name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith('[')) {
    throw new Error(`CAP_SERVER_URL "${raw}" is an IP address — use the domain (${SERVER_DOMAIN_URL}) so chat calls can use the microphone.`);
  }
  return url;
}

const SERVER = checkedServerUrl(process.env.CAP_SERVER_URL || SERVER_DOMAIN_URL);
const ACTIVE_SERVER_URL = SERVER.origin;

const config = {
  appId: 'com.credencehr.app',
  appName: 'CredenceHR',
  webDir: 'dist',
  server: {
    url: ACTIVE_SERVER_URL,
    // Plain http:// is allowed only for the localhost test address above;
    // the live (https) build refuses it.
    cleartext: SERVER.protocol === 'http:',
    androidScheme: 'https',
    // The WebView stays on the server's own domain. A link to any other
    // origin (an IP address, another site) opens in the phone's browser
    // instead of inside the app — so the app can't be pointed at a server's
    // IP from within.
    allowNavigation: [SERVER.hostname]
  },
  // Employee Tracking (@capacitor-community/background-geolocation) stops
  // getting location updates after ~5 minutes backgrounded on stock Android
  // unless the WebView runs on Capacitor's older/legacy bridge instead of the
  // default one. See the plugin's README +
  // https://github.com/capacitor-community/background-geolocation/issues/89.
  android: {
    useLegacyBridge: true
  },
  // iPhone build (ios/, built on a cloud Mac — see .github/workflows/ios.yml).
  // Employee Tracking is Android-only: iOS reviews "Always" background
  // location strictly, so the background-geolocation plugin is left out of
  // the iOS app entirely (src/lib/backgroundTracking.ts also skips iOS).
  // Every other native plugin is listed here — add new ones to this list too.
  ios: {
    contentInset: 'never',
    includePlugins: [
      '@capacitor/app',
      '@capacitor/device',
      '@capacitor/filesystem',
      '@capacitor/geolocation',
      '@capacitor/keyboard',
      '@capacitor/push-notifications',
      '@capacitor/share',
      '@capacitor/status-bar',
      'capacitor-voice-recorder'
    ]
  },
  plugins: {
    // Android: the app draws edge-to-edge itself (MainActivity.java) and
    // hands the page the real status / navigation bar heights
    // (--native-safe-area-inset-*), which the header, bottom nav and every
    // full-screen page already leave room for. Capacitor 8's own SystemBars
    // handling ("css", its default) would ALSO pad the whole WebView below
    // the status bar and above the navigation bar whenever the phone's
    // Android System WebView is older than Chromium 140 (many Vivo / Oppo /
    // Xiaomi phones): dark bars at the top and bottom, and the room left
    // twice — a big gap under the status bar. So it is turned off here.
    SystemBars: {
      insetsHandling: 'disable'
    },
    // Tells Android to shrink the WebView's own viewport when the on-screen
    // keyboard opens (instead of just drawing the keyboard on top of the page
    // at its current size), which is what makes `scrollIntoView` on the
    // focused input (see src/lib/keyboardScrollFix.ts) actually land the
    // field above the keyboard rather than behind it.
    Keyboard: {
      resize: 'body'
    }
  }
};

export default config;
