/**
 * Fullscreen open animation for the native app (APK / iPhone build only —
 * the website never shows it). Mounted from main.tsx right over the app, so
 * the app (login or Home) is already rendered underneath and is revealed
 * when this fades out.
 *
 * It picks up exactly where the native splash leaves off: orange gradient
 * with the CredenceHR icon in the middle (drawable/splash.png and the
 * native-boot loading screen in index.html draw the same frame). Then:
 *   icon melts away -> CREDENCE rises letter by letter -> the wedge flips
 *   onto the D -> a dot stretches into a line and opens into the smile
 *   curve -> HR and "Credence Family.." fade in -> fades out into the app.
 * A thin loading line runs under CREDENCE the whole time. Tap to skip.
 *
 * Plain CSS keyframes, no animation library. Sizes are laid out on a
 * 360 x 780 stage (the design board) that is scaled to the phone; the cream
 * smile fill spans the real screen width, so its keyframes are built from
 * the window size when the component mounts.
 *
 * Smooth on slow phones: the app itself is starting underneath at the same
 * moment and keeps the phone's main thread busy, so every moving part only
 * animates transform / opacity, each on its own GPU layer (will-change), which
 * the GPU runs by itself. No blur and no shadow over a moving part: those
 * are redrawn on the main thread every frame. The CREDENCE shadow is drawn
 * into each letter's own layer once instead of over the whole word. Nothing animates width, left/top or a clip-path, which would have to
 * be redrawn on the busy main thread every frame and stutter. The smile is a
 * picture drawn once (shadow included) and stretched open.
 * The timeline also waits (at most PRELOAD_MAX_MS) until the pictures and
 * the font have arrived and are decoded, holding the splash frame meanwhile,
 * so nothing pops in halfway through.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { markBootIntroDone as showApp, markBootIntroPlaying } from '../lib/bootIntro';
// Inlined (data URL), so the first frame is there at once, like index.html's.
import tileImg from '../assets/boot/app-icon-336.webp?inline';
import hrImg from '../assets/boot/hr.png';
import wedgeImg from '../assets/boot/wedge.png';
import letter0 from '../assets/boot/letter-0.png';
import letter1 from '../assets/boot/letter-1.png';
import letter2 from '../assets/boot/letter-2.png';
import letter3 from '../assets/boot/letter-3.png';
import letter4 from '../assets/boot/letter-4.png';
import letter5 from '../assets/boot/letter-5.png';
import letter6 from '../assets/boot/letter-6.png';
import letter7 from '../assets/boot/letter-7.png';
import signatureFont from '../assets/boot/manchester-signature.woff';

const LETTERS = [letter0, letter1, letter2, letter3, letter4, letter5, letter6, letter7];

// Timeline, in ms from mount.
// A little longer and softer than before, so each move eases in and out
// instead of snapping; the dot still hands over to the fill exactly
// (fill = dot + dotDur).
const T = {
  tileOut: 150, tileOutDur: 460,
  letters: 430, letterDur: 760, letterStagger: 50,
  wedge: 1060, wedgeDur: 560,
  track: 1180, trackDur: 300,
  bar: 1220, barDur: 2450,
  dot: 1400, dotDur: 680,
  fill: 2080, fillDur: 860,
  hr: 2480, hrDur: 760,
  tag: 2850, tagDur: 820,
  exit: 3900, exitDur: 520,
};
const DONE_MS = T.exit + T.exitDur;
// Longest the splash frame is held while the pictures / font load.
const PRELOAD_MAX_MS = 1500;
// Longest it then waits for the app's first render to settle.
const IDLE_MAX_MS = 350;

// Cubic ease-out: starts gently enough not to jump, lands softly.
const EASE_OUT = 'cubic-bezier(.33,1,.68,1)';
// CREDENCE shadow, drawn into each letter's own layer (see header).
const SHADOW = 'drop-shadow(0 6px 10px rgba(150,50,0,0.3))';
const EASE_IN_OUT = 'cubic-bezier(.45,0,.55,1)';

function anim(name: string, dur: number, delay: number, ease = EASE_OUT) {
  return `${name} ${dur}ms ${ease} ${delay}ms both`;
}

export function BootIntroAnimation({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  // false: the splash frame is held (no keyframes yet, so every part sits in
  // its first-frame state); true: the keyframes go in and the timeline runs.
  const [go, setGo] = useState(false);
  const decoded = useRef<HTMLImageElement[]>([]);

  useEffect(() => {
    let alive = true;
    const waits: Promise<unknown>[] = [];
    try {
      const face = new FontFace('CredenceSignature', `url(${signatureFont}) format('woff')`);
      document.fonts.add(face);
      waits.push(face.load());
    } catch {
      /* the @font-face rule below is the fallback */
    }
    for (const src of [...LETTERS, wedgeImg, hrImg]) {
      const img = new Image();
      img.src = src;
      decoded.current.push(img); // kept, so the decoded picture stays cached
      waits.push(typeof img.decode === 'function' ? img.decode() : new Promise((r) => (img.onload = r)));
    }
    const settled = Promise.all(waits.map((w) => w.catch(() => undefined)));
    const capped = new Promise((r) => setTimeout(r, PRELOAD_MAX_MS));
    void Promise.race([settled, capped]).then(() => {
      // Wait for the first quiet moment (the app's own first render underneath
      // is the heaviest work of the start; at most IDLE_MAX_MS), then two
      // frames, so the first animated frame isn't the one React just built
      // and the opening moves don't drop frames.
      const start = () => requestAnimationFrame(() => requestAnimationFrame(() => alive && setGo(true)));
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(start, { timeout: IDLE_MAX_MS });
      else setTimeout(start, 60);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!go) return;
    const finish = setTimeout(onDone, DONE_MS);
    // The app shows again as the fade-out starts, so it is revealed as before.
    const reveal = setTimeout(showApp, T.exit);
    return () => {
      clearTimeout(finish);
      clearTimeout(reveal);
    };
  }, [go, onDone]);

  // The app underneath is hidden (html[data-boot-intro], index.css) while the
  // intro covers it: its own moving parts (the sign-in picture, page
  // animations) would otherwise be redrawn every frame behind the intro and
  // take the frames the intro needs.
  useEffect(() => {
    markBootIntroPlaying();
    return showApp;
  }, []);
  useEffect(() => {
    if (leaving) showApp();
  }, [leaving]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDone, 300);
    return () => clearTimeout(t);
  }, [leaving, onDone]);

  // Geometry of the cream smile fill, in real screen pixels.
  const css = useMemo(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cy = H / 2;
    const s = Math.min(1.25, Math.max(0.85, W / 360));
    const edge = cy + 2 * s; // where the curve meets the screen sides
    const low = cy + 72 * s; // lowest point of the curve, above HR
    const lineTop = cy + 69 * s;
    const lineBot = cy + 75 * s;
    const shallowEdge = cy + 56 * s;
    // The cream fill = everything below the curve. It is built from two
    // pieces that only scale vertically (GPU work only):
    //  - "base": the part below the curve's lowest point (low .. bottom),
    //    growing down from a thin strip;
    //  - "cap": the two horns between the curve and that lowest point,
    //    drawn once as a picture (gradient + upward shadow) and stretched up
    //    from y = low. Scaling a parabola about its lowest point gives the
    //    same family of curves the old clip-path keyframes stepped through:
    //    flat line -> shallow curve -> the full smile.
    const depth = low - edge; // full height of the horns
    const pad = 40; // room above the curve for its shadow
    const capTop = edge - pad;
    const capH = pad + depth + 1; // +1 px overlaps the base, no seam
    const capSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${capH}" viewBox="0 0 ${W} ${capH}">` +
      `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="${-capTop}" x2="0" y2="${H - capTop}">` +
      `<stop offset=".5" stop-color="#ffffff"/><stop offset=".68" stop-color="#fff4ea"/><stop offset="1" stop-color="#fdeadb"/></linearGradient>` +
      `<filter id="f" filterUnits="userSpaceOnUse" x="-40" y="0" width="${W + 80}" height="${capH}">` +
      `<feDropShadow dx="0" dy="-8" stdDeviation="8" flood-color="rgb(150,50,0)" flood-opacity="0.32"/></filter></defs>` +
      `<path filter="url(#f)" fill="url(#g)" d="M0 ${pad} Q${W / 2} ${pad + 2 * depth} ${W} ${pad} L${W} ${capH} L0 ${capH} Z"/></svg>`;
    const capSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(capSvg)}`;
    const capStart = Math.max(0.01, (low - lineTop) / depth); // the thin line
    const capShallow = (low - shallowEdge) / depth; // the shallow curve
    const baseTop = low - 1;
    const baseH = H - baseTop;
    const baseStart = Math.max(0.005, (lineBot - baseTop) / baseH);
    const dot = 26 * s;
    const line = 6 * s;
    return {
      scale: s,
      W,
      H,
      capSrc,
      capTop,
      capH,
      capOrigin: pad + depth,
      baseTop,
      baseH,
      dot,
      keyframes: `
@font-face{font-family:'CredenceSignature';src:url(${signatureFont}) format('woff');font-display:block}
@keyframes chrTileOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.86)}}
@keyframes chrRise{from{transform:translate3d(0,140%,0)}to{transform:translate3d(0,0,0)}}
@keyframes chrWedge{0%{opacity:0;transform:translate(-6px,-26px) rotate(-90deg) scale(.5)}62%{opacity:1;transform:translate(0,1px) rotate(6deg) scale(1.04);animation-timing-function:${EASE_IN_OUT}}100%{opacity:1;transform:none}}
@keyframes chrFadeIn{from{opacity:0}to{opacity:1}}
@keyframes chrFadeOut{from{opacity:1}to{opacity:0}}
@keyframes chrBar{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes chrDot{0%{transform:translate(${W / 2}px,${low}px) scale(0);opacity:1;animation-timing-function:cubic-bezier(.34,1.4,.64,1)}25%{transform:translate(${W / 2 - dot / 2}px,${low - dot / 2}px) scale(1);opacity:1;animation-timing-function:cubic-bezier(.65,0,.35,1)}100%{transform:translate(0px,${lineTop}px) scale(${W / dot},${line / dot});opacity:1}}
@keyframes chrCap{0%{transform:scaleY(${capStart});opacity:1;animation-timing-function:cubic-bezier(.4,0,.6,1)}30%{transform:scaleY(${capShallow});animation-timing-function:${EASE_OUT}}100%{transform:scaleY(1);opacity:1}}
@keyframes chrBase{0%{transform:scaleY(${baseStart});opacity:1;animation-timing-function:cubic-bezier(.4,0,.6,1)}30%{transform:scaleY(1)}100%{transform:scaleY(1);opacity:1}}
@keyframes chrSoft{from{opacity:0;transform:translate3d(0,12px,0)}to{opacity:1;transform:translate3d(0,0,0)}}
@keyframes chrTag{from{opacity:0;transform:translate3d(0,10px,0) scale(.985)}to{opacity:1;transform:translate3d(0,0,0) scale(1)}}
`,
    };
  }, []);

  return (
    <div
      onClick={() => setLeaving(true)} // let an impatient user tap through
      aria-hidden="true"
      className="boot-intro"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        overflow: 'hidden',
        contain: 'strict',
        willChange: 'opacity',
        background: 'linear-gradient(160deg, #ff9238 0%, #f47920 45%, #e2600e 100%)',
        animation: leaving ? 'chrFadeOut 300ms ease-out both' : anim('chrFadeOut', T.exitDur, T.exit, EASE_IN_OUT),
      }}
    >
      {/* Until everything has loaded there are no keyframes, so every part
          stays in its first-frame state: the splash. */}
      {(go || leaving) && <style>{css.keyframes}</style>}

      {/* Cream smile fill (full screen width). Hidden until the dot has
          become the line; 'forwards', not 'both', so before it starts it
          stays hidden instead of showing the thin line it opens from. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: css.baseTop,
          width: css.W,
          height: css.baseH,
          opacity: 0,
          transformOrigin: '50% 0',
          willChange: 'transform, opacity',
          background: 'linear-gradient(180deg, #ffffff 50%, #fff4ea 68%, #fdeadb 100%)',
          backgroundSize: `${css.W}px ${css.H}px`,
          backgroundPosition: `0 ${-css.baseTop}px`,
          backgroundRepeat: 'no-repeat',
          animation: `chrBase ${T.fillDur}ms ${EASE_OUT} ${T.fill}ms forwards`,
        }}
      />
      <img
        src={css.capSrc}
        alt=""
        style={{
          position: 'absolute',
          left: 0,
          top: css.capTop,
          width: css.W,
          height: css.capH,
          display: 'block',
          opacity: 0,
          transformOrigin: `50% ${css.capOrigin}px`,
          willChange: 'transform, opacity',
          animation: `chrCap ${T.fillDur}ms ${EASE_OUT} ${T.fill}ms forwards`,
        }}
      />
      {/* Dot that stretches into the line the smile opens from */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: css.dot,
          height: css.dot,
          opacity: 0,
          borderRadius: '50%',
          background: '#ffffff',
          transformOrigin: '0 0',
          willChange: 'transform, opacity',
          animation: `${anim('chrDot', T.dotDur, T.dot, 'linear')}, ${anim('chrFadeOut', 80, T.fill + 60, 'linear')}`,
        }}
      />

      {/* 360 x 780 design stage, centred and scaled to the phone */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 360,
          height: 780,
          marginLeft: -180,
          marginTop: -390,
          transform: `scale(${css.scale})`,
        }}
      >
        {/* HR */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 486, display: 'flex', justifyContent: 'center', opacity: 0, willChange: 'transform, opacity', animation: anim('chrSoft', T.hrDur, T.hr, 'cubic-bezier(.37,0,.63,1)') }}>
          <img src={hrImg} alt="" style={{ width: 104, height: 'auto', display: 'block' }} />
        </div>

        {/* Slogan lockup */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 556, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0, willChange: 'transform, opacity', animation: anim('chrTag', T.tagDur, T.tag, 'cubic-bezier(.33,0,.2,1)') }}>
          <p style={{ margin: 0, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 9.5, fontWeight: 700, letterSpacing: 5, paddingLeft: 5, color: '#c2510a', whiteSpace: 'nowrap' }}>
            OUR PEOPLE &nbsp;·&nbsp; OUR PRIDE
          </p>
          <p style={{ margin: '2px 0 0', fontFamily: "'CredenceSignature', cursive", fontSize: 58, lineHeight: 1.1, color: '#a8440a', whiteSpace: 'nowrap', WebkitTextStroke: '0.3px #a8440a' }}>
            Credence Family..
          </p>
        </div>

        {/* CREDENCE: letters rise from a hidden baseline, then the wedge flips on */}
        <div style={{ position: 'absolute', left: 55, top: 305, width: 250, height: 50 }}>
          {/* clip box reaches 16px lower, so the letters' shadow isn't cut off;
              the letters wait 70px down (140%), below it */}
          <div style={{ position: 'absolute', left: -12, right: -12, top: 0, bottom: -16, overflow: 'hidden' }}>
            {LETTERS.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                style={{ position: 'absolute', left: 12, top: 0, width: 250, height: 50, display: 'block', filter: SHADOW, transform: 'translate3d(0,140%,0)', willChange: 'transform', animation: anim('chrRise', T.letterDur, T.letters + i * T.letterStagger) }}
              />
            ))}
          </div>
          <img
            src={wedgeImg}
            alt=""
            style={{ position: 'absolute', inset: 0, width: 250, height: 50, display: 'block', opacity: 0, filter: SHADOW, transformOrigin: '125px 18px', willChange: 'transform, opacity', animation: anim('chrWedge', T.wedgeDur, T.wedge, 'cubic-bezier(.33,0,.2,1)') }}
          />
        </div>

        {/* Loading line, under CREDENCE */}
        <div style={{ position: 'absolute', top: 396, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 120, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.25)', overflow: 'hidden', opacity: 0, willChange: 'opacity', animation: anim('chrFadeIn', T.trackDur, T.track, 'ease-out') }}>
            <div style={{ height: 3, width: 120, borderRadius: 2, background: '#ffffff', transform: 'scaleX(0)', transformOrigin: '0 50%', willChange: 'transform', animation: anim('chrBar', T.barDur, T.bar, EASE_IN_OUT) }} />
          </div>
        </div>

        {/* The icon from the splash, centred; melts away first */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={tileImg} alt="" style={{ width: 112, height: 112, display: 'block', willChange: 'transform, opacity', animation: anim('chrTileOut', T.tileOutDur, T.tileOut, EASE_IN_OUT) }} />
        </div>
      </div>
    </div>
  );
}

/** True only inside the built app — false on the plain website build — and
 *  skipped when the phone asks for reduced motion. */
export function shouldShowBootIntro() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/** Renders the intro once per app start, then removes itself. */
export function BootIntroGate() {
  const [show, setShow] = useState(shouldShowBootIntro);
  return show ? <BootIntroAnimation onDone={() => setShow(false)} /> : null;
}
