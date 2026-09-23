import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ChatStandalone from './ChatStandalone.tsx';
import { applyBackgroundTheme, getSavedBackgroundTheme } from './lib/backgroundTheme.ts';
import './index.css';

// Applied here, before the first paint, rather than in a useEffect once
// App has mounted — otherwise the default background gradient would flash
// briefly before swapping to the account's saved choice.
applyBackgroundTheme(getSavedBackgroundTheme());

// /chat is Chat's own standalone tab (see App.tsx's openChat, which
// window.open()s this exact path on the web instead of showing Chat inside
// the main app tab) — the server's catch-all route (server.ts) serves this
// same index.html for it, so it's this pathname check that decides which
// root component actually mounts. Every other path renders the normal app.
const isStandaloneChat = window.location.pathname === '/chat';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStandaloneChat ? <ChatStandalone /> : <App />}
  </StrictMode>,
);