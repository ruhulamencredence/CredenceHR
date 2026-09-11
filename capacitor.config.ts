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

// Your PC's LAN IP, for testing on a phone connected to the same WiFi.
const LOCAL_SERVER_URL = 'http://192.168.0.209:3000';

// Your real deployed domain or public IP — fill this in once it's live, e.g.
// 'https://mpr.yourcompany.com' or 'http://<public IP>:3000'.
const REAL_SERVER_URL = 'http://203.95.222.58:3000';

// Flip this to true once REAL_SERVER_URL above is filled in and live, then
// rebuild + re-sync as noted above.
const USE_REAL_SERVER = false;

const ACTIVE_SERVER_URL = USE_REAL_SERVER ? REAL_SERVER_URL : LOCAL_SERVER_URL;

const config = {
  appId: 'com.mprtracker.app',
  appName: 'Monthly Budget Optimization',
  webDir: 'dist',
  server: {
    url: ACTIVE_SERVER_URL,
    // Allows plain http:// (not just https://). Only matters if
    // ACTIVE_SERVER_URL above uses http:// — harmless to leave on otherwise.
    cleartext: true,
    androidScheme: 'https'
  },
  // Employee Tracking (@capacitor-community/background-geolocation) stops
  // getting location updates after ~5 minutes backgrounded on stock Android
  // unless the WebView runs on Capacitor's older/legacy bridge instead of the
  // default one. See the plugin's README +
  // https://github.com/capacitor-community/background-geolocation/issues/89.
  android: {
    useLegacyBridge: true
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
