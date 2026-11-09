/**
 * Fullscreen open animation ("Option B", design canvas "CredenceHR App Icon
 * v2" -> "Option B in the real app"), shown ONCE right after the native
 * cold-start splash (drawable/splash.png) and index.html's first frame hand
 * off to React. Only runs on the native app (shouldShowBootIntro()); the
 * website never shows it.
 *
 * Its first frame is the same picture as the splash and index.html's
 * #mpr-boot-spinner — orange gradient, app icon 112 px in the middle, empty
 * 120 x 3 loading track 124 px from the bottom — so the hand-off shows no
 * change. Then (6 s timeline, played once, ends at 4.32 s):
 *   0.0–1.0 s  the icon fades and shrinks away
 *   1.0–1.9 s  C-R-E-D-E-N-C-E rise one by one from a hidden baseline
 *   1.5–2.1 s  the grey wedge flips down onto the D
 *   1.7–2.4 s  a white dot pops in and stretches into the HR badge, HR unfolds
 *   2.6–3.5 s  a ring pulses out of the badge
 *   0.1–3.4 s  one loading line fills under it the whole time
 *   3.5–4.3 s  the splash fades out over the app (the logo grows 5 %)
 * Keyframes, timings and easing are the export's (OptionBLive), minus its
 * loop-back. A tap skips it. With "reduce motion" on, nothing moves: the icon
 * cross-fades to the finished logo and the splash fades out (1.2 s).
 */
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
// Inlined (data URL) so the first frame is there at once, like index.html's.
import appIcon from '../assets/boot/app-icon-336.webp?inline';
import letterC from '../assets/boot/letter_0_C.png';
import letterR from '../assets/boot/letter_1_R.png';
import letterE from '../assets/boot/letter_2_E.png';
import letterD from '../assets/boot/letter_3_D.png';
import letterE2 from '../assets/boot/letter_4_E2.png';
import letterN from '../assets/boot/letter_5_N.png';
import letterC2 from '../assets/boot/letter_6_C2.png';
import letterE3 from '../assets/boot/letter_7_E3.png';
import wedge from '../assets/boot/wedge.png';
import hrText from '../assets/boot/hr_text.png';

const LETTERS = [letterC, letterR, letterE, letterD, letterE2, letterN, letterC2, letterE3];
const TIMELINE_MS = 6000; // the export's loop length; percentages below are of this
const DONE_MS = 4320; // 72 %: the splash has faded out
const REDUCED_DONE_MS = 1200;

const CSS = `
.chb-root{position:fixed;inset:0;z-index:9999;background:linear-gradient(160deg,#ff9238 0%,#f47920 45%,#e2600e 100%);-webkit-tap-highlight-color:transparent;user-select:none}
.chb-root img{-webkit-user-drag:none}
.chb-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.chb-tile{width:112px;height:112px;display:block;opacity:0}
.chb-logo{display:flex;flex-direction:column;align-items:center;gap:22px}
.chb-word{position:relative;width:250px;height:50px;filter:drop-shadow(0 6px 10px rgba(150,50,0,.3))}
.chb-clip{position:absolute;inset:0;overflow:hidden}
.chb-letter,.chb-wedge{position:absolute;inset:0;width:250px;height:50px;display:block}
.chb-wedge{transform-origin:125px 18px}
.chb-badge{position:relative;width:130px;height:68px;display:flex;align-items:center;justify-content:center}
.chb-ring{position:absolute;inset:0;border:2px solid #fff;border-radius:34px;opacity:0;box-sizing:border-box}
.chb-pill{height:68px;width:130px;border-radius:34px;background:linear-gradient(180deg,#fff 0%,#fff8f1 100%);box-shadow:0 10px 18px -6px rgba(150,50,0,.45);display:flex;align-items:center;justify-content:center;overflow:hidden}
.chb-hr{width:72px;height:auto;display:block;flex-shrink:0}
.chb-track{position:absolute;bottom:124px;left:50%;width:120px;height:3px;margin-left:-60px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}
.chb-bar{height:3px;width:0;border-radius:2px;background:#fff}

.chb-play{animation:chb-splash ${TIMELINE_MS}ms cubic-bezier(.45,0,.55,1) both}
@keyframes chb-splash{0%,58%{opacity:1}72%,100%{opacity:0}}
.chb-play .chb-tile{animation:chb-tile ${TIMELINE_MS}ms cubic-bezier(.45,0,.55,1) both}
@keyframes chb-tile{0%,9%{opacity:1;transform:scale(1)}17%,100%{opacity:0;transform:scale(.82)}}
.chb-play .chb-letter{animation:chb-rise ${TIMELINE_MS}ms both}
@keyframes chb-rise{0%,17%{transform:translateY(110%);animation-timing-function:cubic-bezier(.22,1,.36,1)}26%,100%{transform:translateY(0)}}
.chb-play .chb-l1{animation-delay:40ms}.chb-play .chb-l2{animation-delay:80ms}.chb-play .chb-l3{animation-delay:120ms}.chb-play .chb-l4{animation-delay:160ms}
.chb-play .chb-l5{animation-delay:200ms}.chb-play .chb-l6{animation-delay:240ms}.chb-play .chb-l7{animation-delay:280ms}
.chb-play .chb-wedge{animation:chb-wedge ${TIMELINE_MS}ms both}
@keyframes chb-wedge{0%,25%{opacity:0;transform:translate(-6px,-26px) rotate(-90deg) scale(.5);animation-timing-function:cubic-bezier(.33,0,.2,1)}31%{opacity:1;transform:translate(0,1px) rotate(6deg) scale(1.04);animation-timing-function:cubic-bezier(.45,0,.55,1)}35%,100%{opacity:1;transform:translate(0,0) rotate(0) scale(1)}}
.chb-play .chb-pill{animation:chb-pill ${TIMELINE_MS}ms both}
@keyframes chb-pill{0%,28%{width:68px;transform:scale(0);animation-timing-function:cubic-bezier(.34,1.3,.64,1)}33%{width:68px;transform:scale(1);animation-timing-function:cubic-bezier(.65,0,.35,1)}40%,100%{width:130px;transform:scale(1)}}
.chb-play .chb-hr{animation:chb-hr ${TIMELINE_MS}ms cubic-bezier(.22,1,.36,1) both}
@keyframes chb-hr{0%,38%{opacity:0;transform:scaleX(.5)}45%,100%{opacity:1;transform:scaleX(1)}}
.chb-play .chb-ring{animation:chb-ring ${TIMELINE_MS}ms cubic-bezier(.22,1,.36,1) both}
@keyframes chb-ring{0%,44%{opacity:0;transform:scale(1)}46%{opacity:.55;transform:scale(1)}58%,100%{opacity:0;transform:scale(1.45)}}
.chb-play .chb-bar{animation:chb-bar ${TIMELINE_MS}ms both}
@keyframes chb-bar{0%,2%{width:0;opacity:1;animation-timing-function:cubic-bezier(.35,0,.25,1)}56%{width:120px;opacity:1;animation-timing-function:ease}64%,100%{width:120px;opacity:0}}
.chb-play .chb-logo{animation:chb-logo ${TIMELINE_MS}ms cubic-bezier(.33,0,.2,1) both}
@keyframes chb-logo{0%,58%{transform:scale(1)}72%,100%{transform:scale(1.05)}}

.chb-still{animation:chb-fade ${REDUCED_DONE_MS}ms linear both}
@keyframes chb-fade{0%,75%{opacity:1}100%{opacity:0}}
.chb-still .chb-tile{animation:chb-out 300ms linear both}
@keyframes chb-out{from{opacity:1}to{opacity:0}}
.chb-still .chb-logo{animation:chb-in 300ms linear 200ms both}
@keyframes chb-in{from{opacity:0}to{opacity:1}}
`;

export function BootIntroAnimation({ onDone }: { onDone: () => void }) {
  const [reduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // Warm the pieces that appear after ~1 s (the icon is already inline).
    [...LETTERS, wedge, hrText].forEach((src) => {
      const img = new Image();
      img.src = src;
    });
    const finish = setTimeout(onDone, reduced ? REDUCED_DONE_MS : DONE_MS);
    return () => clearTimeout(finish);
  }, [onDone, reduced]);

  return (
    <div className={`chb-root ${reduced ? 'chb-still' : 'chb-play'}`} onClick={onDone} role="presentation" aria-hidden="true">
      <style>{CSS}</style>
      <div className="chb-center">
        <img className="chb-tile" src={appIcon} alt="" />
      </div>
      <div className="chb-center">
        <div className="chb-logo">
          <div className="chb-word">
            <div className="chb-clip">
              {LETTERS.map((src, i) => (
                <img key={i} className={`chb-letter${i ? ` chb-l${i}` : ''}`} src={src} alt="" />
              ))}
            </div>
            <img className="chb-wedge" src={wedge} alt="" />
          </div>
          <div className="chb-badge">
            <div className="chb-ring" />
            <div className="chb-pill">
              <img className="chb-hr" src={hrText} alt="" />
            </div>
          </div>
        </div>
      </div>
      <div className="chb-track">
        <div className="chb-bar" />
      </div>
    </div>
  );
}

/** True only inside the built APK — false on the plain website build. */
export function shouldShowBootIntro() {
  return Capacitor.isNativePlatform();
}
