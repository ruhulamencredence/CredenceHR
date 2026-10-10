// The APK build no longer bundles the frontend locally. Instead it points the
// WebView straight at a server URL — the app opens exactly like a browser
// hitting that URL, so it always loads the latest deployed version and every
// relative /api/... call already resolves to the right backend (see
// src/lib/api.ts) with zero extra configuration.
//
// Capacitor can only bake ONE fixed URL into a given APK build — there's no
// native way for a single build to try two URLs. So instead, keep both
// addresses defined below and flip USE_REAL_SERVER when you're ready to
// switch: build with it OFF while testing on your LAN, then flip it ON (and
// rebuild) once the real server is live. Each flip needs a rebuild + re-sync:
//   npm run build
//   npx cap sync android
//
// ⚠️ Both URLs need a scheme (http:// or https://) and no trailing slash —
// Capacitor's server.url silently fails to load ("webpage not available")
// without a valid scheme.

// Local testing on a phone. localhost (not the PC's LAN IP) because the
// WebView only allows the microphone / camera (chat calls, voice messages) on
// https:// or localhost — connect the phone by USB and run
//   adb reverse tcp:3000 tcp:3000
// so the phone's localhost:3000 reaches the server on this PC. (The old LAN
// address, http://192.168.66.11:3001, still loads the app over WiFi but
// calls can't get the microphone there.)
const LOCAL_SERVER_URL = 'http://192.168.66.11:3000';

// The live server. The domain (HTTPS) is the normal address — the iPhone app
// only loads HTTPS pages, so it always uses this one. The public IP (plain
// http) is kept as a fallback for the Android APK only.
const REAL_SERVER_DOMAIN_URL = 'https://hr.credencehousinglimited.com';
const REAL_SERVER_IP_URL = 'http://203.95.222.58:3000';

// Android only: true = build the APK against the IP instead of the domain.
const USE_IP_INSTEAD_OF_DOMAIN = false;
const REAL_SERVER_URL = USE_IP_INSTEAD_OF_DOMAIN ? REAL_SERVER_IP_URL : REAL_SERVER_DOMAIN_URL;

// Flip this to true to build against the live server above instead of your
// PC (LOCAL_SERVER_URL), then rebuild + re-sync as noted above.
const USE_REAL_SERVER = false;

// CAP_SERVER_URL (set by the cloud builds, .github/workflows/ios.yml and android.yml)
// overrides both, so a build can point at any server without editing this file.
const ACTIVE_SERVER_URL = process.env.CAP_SERVER_URL || (USE_REAL_SERVER ? REAL_SERVER_URL : LOCAL_SERVER_URL);

const config = {
  appId: 'com.credencehr.app',
  appName: 'CredenceHR',
  webDir: 'dist',
  server: {
    url: ACTIVE_SERVER_URL,
    // Allows plain http:// (not just https://). Only matters if
    // ACTIVE_SERVER_URL above uses http:// — harmless to leave on otherwise.
    cleartext: true,
    androidScheme: 'https',
    // Without this, navigating to any origin OTHER than ACTIVE_SERVER_URL
    // above (e.g. GlobalSidebar's "Set Server" switcher doing
    // window.location.href = <a different admin-added IP/URL>) gets treated
    // as an "external link" and kicked out to the system browser (Chrome)
    // instead of just loading in this WebView — that's Capacitor's default
    // safety behavior for cross-origin navigation. The server catalog is
    // managed at runtime from the web (Admin Panel -> Servers) so the exact
    // list of IPs/URLs isn't known at build time; '*' allows navigating to
    // any origin from inside the WebView rather than only ACTIVE_SERVER_URL.
    allowNavigation: ['*']
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
