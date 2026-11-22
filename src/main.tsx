import './lib/polyfills.ts';
import {StrictMode, Suspense, lazy, useCallback, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import { AuthScreen } from './components/AuthScreen.tsx';
import { clearScreenCache } from './lib/screenCache.ts';
import { OnboardingShell, SESSION_CHANGED_EVENT } from './components/OnboardingShell.tsx';
import type { User } from './types.ts';
import { applyBackgroundTheme, applyHeaderGlow, getSavedBackgroundTheme, getSavedHeaderGlow } from './lib/backgroundTheme.ts';
import { Capacitor } from '@capacitor/core';
import './index.css';
import { installCompanyHeader } from './lib/company.ts';
import { applyColorMode, getSavedColorMode } from './lib/colorMode.ts';
import { installChunkReload, retryImport } from './lib/chunkReload.ts';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import { BootIntroAnimation, shouldShowBootIntro } from './components/BootIntroAnimation.tsx';
import { markBootIntroPlaying } from './lib/bootIntro';

// The whole app (App.tsx: sidebar, chat, calls…) is its own download. A
// visitor who isn't signed in on the website gets only the sign-in screen
// first (WebSignIn below) — the app's code follows once they start typing
// or sign in — so the sign-in page opens fast (PageSpeed). Signed in, or in
// the Android / iOS app, it starts downloading at once, as before.
const loadApp = (() => {
  let p: Promise<typeof import('./App.tsx')> | null = null;
  return () => (p ||= retryImport(() => import('./App.tsx'))().catch((err) => {
    p = null;
    throw err;
  }));
})();
const App = lazy(loadApp);
const ChatStandalone = lazy(retryImport(() => import('./ChatStandalone.tsx')));
const PrivacyPolicy = lazy(retryImport(() => import('./components/PrivacyPolicy.tsx')));
const VerifyPage = lazy(retryImport(() => import('./components/VerifyPage.tsx')));
const hasSession = () => {
  try {
    return !!localStorage.getItem('mpr_token');
  } catch {
    return false;
  }
};

// Website, not signed in: only the sign-in screen. On success it does what
// App.tsx's own sign-in does (save the session, nothing from an earlier
// sign-in shown), waits for the app's code, then hands over to <App freshLogin>.
function WebSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  useEffect(() => {
    // Typing / tapping on the page: fetch the app meanwhile.
    const warm = () => void loadApp().catch(() => undefined);
    const evs = ['pointerdown', 'keydown', 'focusin'] as const;
    evs.forEach((e) => window.addEventListener(e, warm, { once: true, passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, warm));
  }, []);
  return (
    <AuthScreen
      onLoginSuccess={(newToken: string, newUser: User) => {
        clearScreenCache();
        localStorage.setItem('mpr_token', newToken);
        localStorage.setItem('mpr_user', JSON.stringify(newUser));
        // A new joiner's temporary login opens only My Onboarding.
        if (newUser?.is_onboarding) {
          window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
          return;
        }
        void loadApp()
          .then((m) => m.dashboardCodeReady(1500))
          .catch(() => undefined)
          .then(onSignedIn);
      }}
    />
  );
}

// Multi-company: every /api call carries the picked company (src/lib/company.ts).
installCompanyHeader();
// A tab left open across a deploy reloads once instead of going white.
installChunkReload();

// Applied here, before the first paint, rather than in a useEffect once
// App has mounted — otherwise the default background gradient would flash
// briefly before swapping to the account's saved choice.
// The app (APK / iOS) or an iPhone "Add to Home Screen": a few things look
// app-like there (index.css html[data-app-shell]).
try {
  const standalone = (navigator as any).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  if (Capacitor.isNativePlatform() || standalone) document.documentElement.dataset.appShell = '1';
} catch {
  // not available — website look
}
// The Android app: lighter "glass" so popups and sheets scroll smoothly. A
// frosted blur repaints everything behind it on every frame, and the Android
// WebView does that on the CPU on many phones (a measured More sheet: 30 fps
// with the full blur, 53 without). index.css html[data-lite-glass] makes the
// blurs smaller (the same look, lighter); a low-end phone (4 cores or fewer,
// or 4 GB of memory or less) gets them smaller still.
// The website and the iPhone app keep the full look.
try {
  if (Capacitor.getPlatform() === 'android') {
    const cores = Number(navigator.hardwareConcurrency || 8);
    const memory = Number((navigator as any).deviceMemory || 8);
    document.documentElement.dataset.liteGlass = cores <= 4 || memory <= 4 ? 'low' : '1';
  }
} catch {
  // not available — full look
}
applyBackgroundTheme(getSavedBackgroundTheme());
// Light / Dark / Like this device (colorMode.ts; index.html already set it before the first paint).
applyColorMode(getSavedColorMode());
applyHeaderGlow(getSavedHeaderGlow());

// /chat is Chat's own standalone tab (see App.tsx's openChat, which
// window.open()s this exact path on the web instead of showing Chat inside
// the main app tab) — the server's catch-all route (server.ts) serves this
// same index.html for it, so it's this pathname check that decides which
// root component actually mounts. Every other path renders the normal app.
const isStandaloneChat = window.location.pathname === '/chat';
// /privacy is the public Privacy Policy (the link given to Google Play) —
// readable without signing in, so it skips <App /> and its sign-in screen.
const isPrivacyPolicy = /^\/privacy\/?$/.test(window.location.pathname);
if (isPrivacyPolicy) document.title = 'Privacy Policy · CredenceHR';
// /verify and /verify/<code> — the public check of an e-signed document
// (VerifyPage.tsx, ESignRoutes.ts): opened from a signed PDF's QR code by
// people who have no account, so it skips <App /> like /privacy.
const isVerify = /^\/verify(\/[A-Za-z0-9-]+)?\/?$/.test(window.location.pathname);
// /sso/consume/<token> — opened from 360 ERP to come in already signed in
// (SsoConsume.tsx, Erp360InboundSsoRoutes.ts). Its own small chunk.
const ssoToken = /^\/sso\/consume\/([0-9a-fA-F]{64})\/?$/.exec(window.location.pathname)?.[1]?.toLowerCase() || null;
const SsoConsume = lazy(() => import('./components/SsoConsume.tsx'));
// The Android app opened by a credencehr://sso/consume/<token> link (a phone
// browser's "Open in the CredenceHR app" on that page): go to the page above
// inside the app. Each link only once — a reload must not reuse it.
if (Capacitor.isNativePlatform()) {
  const openSsoLink = (url?: string | null) => {
    const t = /^credencehr:\/\/sso\/consume\/([0-9a-fA-F]{64})/i.exec(String(url || ''))?.[1]?.toLowerCase();
    if (!t) return;
    try {
      if (sessionStorage.getItem('sso_link_done') === t) return;
      sessionStorage.setItem('sso_link_done', t);
    } catch {
      // storage unavailable
    }
    window.location.replace(`/sso/consume/${t}`);
  };
  void import('@capacitor/app')
    .then(({ App }) => {
      void App.getLaunchUrl().then((r) => openSsoLink(r?.url)).catch(() => undefined);
      void App.addListener('appUrlOpen', (e) => openSsoLink(e.url));
    })
    .catch(() => undefined);
}

// A new joiner's temporary login (HR Operations -> Onboarding -> New Joiners)
// gets only "My Onboarding", never the normal app — so none of the app's
// background calls run for it. App.tsx's sign-in hands over by saving the
// session and firing SESSION_CHANGED_EVENT.
const onboardingSession = (): { token: string; user: User } | null => {
  try {
    const token = localStorage.getItem('mpr_token');
    const user = JSON.parse(localStorage.getItem('mpr_user') || 'null');
    return token && user?.is_onboarding ? { token, user } : null;
  } catch {
    return null;
  }
};
// The app's launch animation (BootIntroAnimation.tsx), over the normal app:
// once per app start — not again when the page reloads itself (account
// switch, a new deploy), which keeps the same session storage.
const BOOT_INTRO_KEY = 'chr_boot_intro_played';
let bootIntroDecided: boolean | undefined; // asked once (StrictMode asks twice)
const bootIntroDue = () => {
  if (bootIntroDecided !== undefined) return bootIntroDecided;
  bootIntroDecided = shouldShowBootIntro();
  if (bootIntroDecided) {
    try {
      if (sessionStorage.getItem(BOOT_INTRO_KEY)) bootIntroDecided = false;
      else sessionStorage.setItem(BOOT_INTRO_KEY, '1');
    } catch {
      // storage unavailable — play it
    }
  }
  // Hide the app under it from the very first render (lib/bootIntro.ts).
  if (bootIntroDecided) markBootIntroPlaying();
  return bootIntroDecided;
};
function Root() {
  const [intro, setIntro] = useState(bootIntroDue);
  const endIntro = useCallback(() => setIntro(false), []);
  const [onb, setOnb] = useState(onboardingSession);
  // Website without a session: the light sign-in screen until signed in.
  const [signedIn, setSignedIn] = useState(() => Capacitor.isNativePlatform() || hasSession());
  const [freshLogin, setFreshLogin] = useState(false);
  useEffect(() => {
    const check = () => setOnb(onboardingSession());
    window.addEventListener(SESSION_CHANGED_EVENT, check);
    window.addEventListener('storage', check);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, check);
      window.removeEventListener('storage', check);
    };
  }, []);
  return (
    <>
      {onb ? (
        <OnboardingShell token={onb.token} user={onb.user} />
      ) : signedIn ? (
        <Suspense fallback={null}>
          <App freshLogin={freshLogin} />
        </Suspense>
      ) : (
        <WebSignIn
          onSignedIn={() => {
            setFreshLogin(true);
            setSignedIn(true);
          }}
        />
      )}
      {intro && <BootIntroAnimation onDone={endIntro} />}
    </>
  );
}

// The service worker (public/sw.js) — push notifications and the map tiles
// kept on the device. Registered on every start, not only when push is
// turned on, so the map cache works for everyone (web and the APK).
try {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined), { once: true });
  }
} catch {
  // no service worker here — the map just loads from the network
}
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        {ssoToken ? (
          <Suspense fallback={null}>
            <SsoConsume token={ssoToken} />
          </Suspense>
        ) : isPrivacyPolicy || isVerify || isStandaloneChat ? (
          <Suspense fallback={null}>{isPrivacyPolicy ? <PrivacyPolicy /> : isVerify ? <VerifyPage /> : <ChatStandalone />}</Suspense>
        ) : (
          <Root />
        )}
      </AppErrorBoundary>
    </StrictMode>,
  );
// The stylesheet loads without holding up index.html's first frame
// (vite.config.ts "non-blocking-app-css"): React draws only once it is in, so
// nothing shows unstyled. No such link in development (Vite injects the CSS).
const cssReady = (): Promise<void> => {
  const link = document.querySelector<HTMLLinkElement>('link[data-app-css]');
  if (!link || link.sheet) return Promise.resolve();
  return new Promise((done) => {
    const go = () => done();
    link.addEventListener('load', go, { once: true });
    link.addEventListener('error', go, { once: true });
    window.setTimeout(go, 10_000);
  });
};
// Website sign-in: index.html already shows the sign-in page's picture
// (#web-signin-shell). React takes over once that picture is on screen, so
// the picture people see first stays the page's "largest paint" (PageSpeed)
// instead of React drawing a second copy of it later. At most 3 s.
const shellPainted = (): Promise<void> => {
  const img = document.querySelector<HTMLImageElement>('html[data-web-signin] #web-signin-shell .ws-hero');
  if (!img) return Promise.resolve();
  const loaded = img.complete
    ? Promise.resolve()
    : new Promise<void>((done) => {
        img.addEventListener('load', () => done(), { once: true });
        img.addEventListener('error', () => done(), { once: true });
      });
  const painted = loaded.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return Promise.race([painted, new Promise<void>((done) => window.setTimeout(done, 3000))]);
};
// Signed in: keep index.html's "Loading…" screen up until the Dashboard's
// code is ready (from the phone's cache that is a fraction of a second; never
// more than 1.5 s), then draw — no skeleton flash on every open.
if (!ssoToken && !isPrivacyPolicy && !isVerify && !isStandaloneChat && !onboardingSession() && (Capacitor.isNativePlatform() || hasSession()))
  void loadApp()
    .then((m) => m.dashboardCodeReady(1500))
    .catch(() => undefined)
    .then(cssReady)
    .then(render);
else void Promise.all([cssReady(), shellPainted()]).then(render);