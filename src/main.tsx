import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ChatStandalone from './ChatStandalone.tsx';
import PrivacyPolicy from './components/PrivacyPolicy.tsx';
import './index.css';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPrivacyPolicy ? <PrivacyPolicy /> : isStandaloneChat ? <ChatStandalone /> : <App />}
  </StrictMode>,
);