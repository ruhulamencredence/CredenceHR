# 2026-11-22 — App open animation made smoother

## What changed
- **The app under the animation draws nothing while it plays.** `<html data-boot-intro>`
  (set in main.tsx before the first render, removed as the fade-out starts) hides
  everything but the animation (index.css). The sign-in screen's Lottie picture was
  redrawn every frame behind it (style + layout + paint each frame) and took the
  frames the animation needed. Its animation now starts after the intro
  (`chr-boot-intro-done`, src/lib/bootIntro.ts); the still picture shows meanwhile.
- **Animation itself:** no blur in the HR / slogan fade-ins; the CREDENCE shadow
  is on each letter's own layer instead of over the whole word (it was redrawn
  every frame while the letters moved); every moving part on its own GPU layer
  (`will-change`); softer cubic ease-out and slightly longer moves (3.9 s + 0.5 s
  fade, was 3.7 + 0.45); it starts on the first quiet moment after the app's
  first render (at most 350 ms).
- **Sign-in picture swap:** AuthHeroLottie now says "ready" only once the player
  has put its picture in the page (it loads lazily after the data). Before, the
  still faded out ~200 ms before the animation appeared — hidden behind the intro
  until now.

## Measured (production build, Chromium, CPU slowed 4x, first 6.5 s, 3 runs)
`scripts/boot-intro-frames.cjs`

| | repaints | dropped frames |
|---|---|---|
| before | 490–567 | 106–148 |
| after  | 134–173 | 14–27 |

The dropped frames left are before the animation starts (still splash frame) and
after it ends (sign-in picture starting) — 1 during the animation itself.

## Tests
- `boot-intro-smooth-ui.txt` — 12/12 (app hidden under the intro and shown after
  it, sign-in and signed in; picture animation waits; tap to skip).
- 2026-11-18 in-app-update-ui — all pass.
