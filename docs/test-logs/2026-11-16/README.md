# Test log — 16 November 2026

## Sign-in page on a phone: first paint without waiting for the stylesheet or the app

PageSpeed (mobile) on the live site: the sign-in picture is the "largest paint", and it could only start after the
whole app script (~400 KB, ~134 KB compressed) had run; the 326 KB stylesheet also held up the first paint (Lighthouse
on the live site: 59–63, FCP 4.2–5.3 s, LCP 7.1–8.9 s — measured through this environment's proxy, which counts the
files uncompressed, so the live numbers read worse than a phone sees).

- `vite.config.ts` (`non-blocking-app-css`, build only): the app's stylesheet is preloaded (fetched first) but no longer
  blocks the first paint; `main.tsx` waits for it (`cssReady`) before React draws, so nothing shows unstyled.
- `index.html`: a website visitor with no session (not the Android / iOS app, not dark mode, not /chat /privacy /verify
  /sso) sees the top of the sign-in page — page colour, Credence logo, office picture — painted from the HTML itself
  (`#web-signin-shell`), instead of the orange splash. Same image files as AuthScreen (same hashed names).
- `main.tsx` (`shellPainted`): React takes over once that picture is on screen (at most 3 s), so it stays the largest
  paint instead of React drawing a second copy later.

Lighthouse (local production build, simulated mid-range phone on slow 4G):

| | Mobile score | FCP | LCP |
|---|---|---|---|
| before (15 Nov) | 97 | 1.7 s | 2.4 s |
| after | 97 / 100 | 0.6 s | 2.2 / 1.2 s |
| desktop after | 100 | 0.2 s | 0.5 s |

- `scripts/signin-shell.cjs`: the HTML picture vs React's — computer: same place (320,332, 320×320); phone: same size,
  6 px apart vertically (the phone layout centres the picture in the space above the card); the HTML version is gone
  once React draws; with a session (and in the app) the orange splash shows, not the picture. CLS 0.
- `docs/test-logs/2026-11-14/scripts/fast-signin.cjs` on the production build: **22/22** (sign-in, first touch loads the
  app, fresh sign-in lands on the Dashboard, reload keeps the session, /privacy and /verify still open, no page errors).
- QA suites: all passed.
