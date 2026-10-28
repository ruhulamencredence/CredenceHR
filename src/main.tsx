import './lib/polyfills.ts';
import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ChatStandalone from './ChatStandalone.tsx';
import PrivacyPolicy from './components/PrivacyPolicy.tsx';
import VerifyPage from './components/VerifyPage.tsx';
import { OnboardingShell, SESSION_CHANGED_EVENT } from './components/OnboardingShell.tsx';
import type { User } from './types.ts';
import { applyBackgroundTheme, getSavedBackgroundTheme } from './lib/backgroundTheme.ts';
import { Capacitor } from '@capacitor/core';
import './index.css';
import { installCompanyHeader } from './lib/company.ts';
import { installChunkReload } from './lib/chunkReload.ts';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';

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
applyBackgroundTheme(getSavedBackgroundTheme());

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
function Root() {
  const [onb, setOnb] = useState(onboardingSession);
  useEffect(() => {
    const check = () => setOnb(onboardingSession());
    window.addEventListener(SESSION_CHANGED_EVENT, check);
    window.addEventListener('storage', check);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, check);
      window.removeEventListener('storage', check);
    };
  }, []);
  return onb ? <OnboardingShell token={onb.token} user={onb.user} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>{isPrivacyPolicy ? <PrivacyPolicy /> : isVerify ? <VerifyPage /> : isStandaloneChat ? <ChatStandalone /> : <Root />}</AppErrorBoundary>
  </StrictMode>,
);