// A stand-in for the Android side of the app, for browser tests.
//
// It loads Capacitor's real Android bridge script (native-bridge.js — the one
// the APK injects into its WebView) and answers the calls it posts the way the
// APK's plugins would, so the app runs its Android code paths in a browser:
//   Geolocation.*           permission 'granted'; getCurrentPosition = the fix
//   LocationAccess.*        getCurrentFix = the fix (+ mock false), getStatus,
//                           warmUp / stopWarm (recorded)
//   everything else         an empty answer
// The fix is controlled from the test:
//   await page.evaluate((f) => (window.__fake.fix = f), { latitude, longitude, accuracy });
//   window.__fake.queue = [{...}, {...}]  one entry per reading, the last one stays
//                                         (a cold GPS getting better)
//   window.__fake.calls                   every plugin call, in order
const fs = require('fs');
const path = require('path');
const BRIDGE = path.join(__dirname, '../../../../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js');

const SETUP = `
(() => {
  const st = (window.__fake = { fix: { latitude: 23.8, longitude: 90.4, accuracy: 10 }, queue: [], calls: [], delayMs: 150, precise: true });
  const H = (name, methods) => ({ name, methods: methods.map((m) => (typeof m === 'string' ? { name: m, rtype: 'promise' } : m)) });
  const cb = (name) => ({ name, rtype: 'callback' });
  window.Capacitor = { PluginHeaders: [
    H('Geolocation', ['checkPermissions', 'requestPermissions', 'getCurrentPosition', cb('watchPosition'), 'clearWatch']),
    H('LocationAccess', ['getStatus', 'requestForeground', 'requestBackground', 'getCurrentFix', 'openLocationSettings', 'warmUp', 'stopWarm', 'requestBatteryExemption', 'openAppSettings']),
    H('App', ['getInfo', 'getState', 'getLaunchUrl', 'exitApp', 'minimizeApp', 'removeAllListeners', 'removeListener', cb('addListener')]),
    H('Device', ['getId', 'getInfo', 'getBatteryInfo', 'getLanguageCode']),
    H('Keyboard', ['show', 'hide', 'removeAllListeners', 'removeListener', cb('addListener')]),
    H('StatusBar', ['setStyle', 'setBackgroundColor', 'setOverlaysWebView', 'show', 'hide']),
    H('SplashScreen', ['show', 'hide']),
    H('PushNotifications', ['checkPermissions', 'requestPermissions', 'register', 'unregister', 'removeAllListeners', 'removeListener', cb('addListener')]),
    H('Share', ['share', 'canShare']),
    H('Filesystem', ['writeFile', 'readFile', 'getUri', 'deleteFile']),
    H('AppUpdater', ['getInfo', 'check', 'install']),
    H('CallAudio', ['start', 'stop', 'setSpeaker']),
    H('BackgroundGeolocation', ['openSettings', cb('addWatcher'), 'removeWatcher']),
  ] };
  const pos = (f) => ({ timestamp: Date.now(), coords: { latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy, altitude: null, altitudeAccuracy: null, speed: null, heading: null } });
  const take = () => { const f = st.queue.length > 1 ? st.queue.shift() : st.queue.length === 1 ? st.queue[0] : st.fix; return { ...st.fix, ...f }; };
  const answer = (m) => {
    const o = m.options || {};
    switch (m.pluginId + '.' + m.methodName) {
      case 'Geolocation.checkPermissions':
      case 'Geolocation.requestPermissions': return { location: 'granted', coarseLocation: 'granted' };
      case 'Geolocation.getCurrentPosition': return pos(take());
      case 'LocationAccess.getCurrentFix': { const f = take(); return { latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy, time: Date.now(), mock: f.mock === true }; }
      case 'LocationAccess.getStatus':
      case 'LocationAccess.requestForeground':
      case 'LocationAccess.requestBackground': return { foreground: true, background: true, precise: st.precise, locationOn: true };
      case 'Device.getId': return { identifier: 'test-device-1' };
      case 'Device.getInfo': return { platform: 'android', operatingSystem: 'android', osVersion: '14', model: 'Test', manufacturer: 'Test', isVirtual: false };
      case 'App.getInfo': return { name: 'CredenceHR', id: 'com.mprtracker.app', build: '1', version: '1.0.0' };
      case 'App.getState': return { isActive: true };
      case 'PushNotifications.checkPermissions':
      case 'PushNotifications.requestPermissions': return { receive: 'denied' };
      default: return {};
    }
  };
  window.androidBridge = { postMessage(raw) {
    const m = JSON.parse(raw);
    st.calls.push({ plugin: m.pluginId, method: m.methodName, options: m.options, at: Date.now() });
    const isCb = m.methodName === 'addListener' || m.methodName === 'watchPosition' || m.methodName === 'addWatcher';
    setTimeout(() => {
      try {
        const data = answer(m);
        window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, save: isCb, success: true, data: isCb ? {} : data }) });
      } catch (e) { /* page gone */ }
    }, /getCurrent(Fix|Position)/.test(m.methodName) ? st.delayMs : 0);
  } };
})();
`;

async function install(ctx) {
  await ctx.addInitScript({ content: SETUP });
  await ctx.addInitScript({ content: fs.readFileSync(BRIDGE, 'utf8') });
}

module.exports = { install };
