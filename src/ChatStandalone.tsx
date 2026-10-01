/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
import { User } from './types';
import { AppLoader } from './components/AppLoader';

// Lazy-loaded the same way App.tsx loads it, so Chat's own Socket.IO client
// stays out of the main app's entry bundle here too — this file is a
// separate Vite entry root (see main.tsx), not something App.tsx imports.
const ChatPanel = lazy(() => import('./components/ChatPanel').then(m => ({ default: m.ChatPanel })));

// Rendered at /chat instead of the full App shell (see main.tsx) — this is
// what opens in the new browser tab the "Chat" nav item launches on the web
// (App.tsx's openChat/window.open). It reads the same session this browser
// already has signed in via localStorage (same origin, so it's shared with
// whichever tab the user actually logged in from) rather than going through
// its own login screen; ChatPanel itself opens its own Socket.IO connection
// (see chatSocket.ts), so this tab works fully independently once mounted.
export default function ChatStandalone() {
  const token = localStorage.getItem('mpr_token');
  const savedUser = localStorage.getItem('mpr_user');
  let user: User | null = null;
  try {
    user = savedUser ? JSON.parse(savedUser) : null;
  } catch {
    user = null;
  }

  if (!token || !user) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'system-ui, sans-serif',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <p style={{ color: '#5f6368', fontSize: 14 }}>
          You need to sign in to CredenceHR first before opening Chat.
        </p>
        <a href="/" style={{ color: '#7F00FF', fontWeight: 600, fontSize: 14 }}>
          Go to CredenceHR
        </a>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <Suspense fallback={<AppLoader />}>
        <ChatPanel
          user={user}
          token={token}
          onBack={() => {
            // This tab only ever exists because the main app opened it via
            // window.open (see App.tsx's openChat) — closing itself is the
            // right "back" action. Browsers refuse to close a tab a script
            // didn't open, so this quietly no-ops there instead of erroring;
            // falling back to the main app is still one click away via the
            // link a failed close would leave on screen.
            window.close();
          }}
        />
      </Suspense>
    </div>
  );
}
