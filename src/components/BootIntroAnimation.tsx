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
 */
import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import tileImg from '../assets/boot/tile.png';
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
const T = {
  tileOut: 150, tileOutDur: 380,
  letters: 420, letterDur: 620, letterStagger: 40,
  wedge: 1000, wedgeDur: 480,
  track: 1150, trackDur: 250,
  bar: 1200, barDur: 2300,
  dot: 1350, dotDur: 600,
  fill: 1950, fillDur: 750,
  hr: 2350, hrDur: 650,
  tag: 2700, tagDur: 700,
  exit: 3700, exitDur: 450,
};
const DONE_MS = T.exit + T.exitDur;

const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
const EASE_IN_OUT = 'cubic-bezier(.45,0,.55,1)';

function anim(name: string, dur: number, delay: number, ease = EASE_OUT) {
  return `${name} ${dur}ms ${ease} ${delay}ms both`;
}

export function BootIntroAnimation({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    // Start fetching the signature font now; the slogan only appears ~2.7s in.
    try {
      const face = new FontFace('CredenceSignature', `url(${signatureFont}) format('woff')`);
      document.fonts.add(face);
      void face.load();
    } catch {
      /* the @font-face rule below is the fallback */
    }
    const finish = setTimeout(onDone, DONE_MS);
    return () => clearTimeout(finish);
  }, [onDone]);

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
    const path = (d: string) => `path('${d}')`;
    const linePath = path(`M0 ${lineTop} Q${W / 2} ${lineTop} ${W} ${lineTop} L${W} ${lineBot} L0 ${lineBot} Z`);
    const shallowPath = path(`M0 ${shallowEdge} Q${W / 2} ${2 * low - shallowEdge} ${W} ${shallowEdge} L${W} ${H} L0 ${H} Z`);
    const smilePath = path(`M0 ${edge} Q${W / 2} ${2 * low - edge} ${W} ${edge} L${W} ${H} L0 ${H} Z`);
    const dot = 26 * s;
    const line = 6 * s;
    return {
      scale: s,
      keyframes: `
@font-face{font-family:'CredenceSignature';src:url(${signatureFont}) format('woff');font-display:block}
@keyframes chrTileOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.82)}}
@keyframes chrRise{from{transform:translateY(110%)}to{transform:translateY(0)}}
@keyframes chrWedge{0%{opacity:0;transform:translate(-6px,-26px) rotate(-90deg) scale(.5)}62%{opacity:1;transform:translate(0,1px) rotate(6deg) scale(1.04);animation-timing-function:${EASE_IN_OUT}}100%{opacity:1;transform:none}}
@keyframes chrFadeIn{from{opacity:0}to{opacity:1}}
@keyframes chrFadeOut{from{opacity:1}to{opacity:0}}
@keyframes chrBar{from{width:0}to{width:120px}}
@keyframes chrDot{0%{left:${W / 2}px;top:${low}px;width:0;height:0;opacity:1;animation-timing-function:cubic-bezier(.34,1.4,.64,1)}25%{left:${W / 2 - dot / 2}px;top:${low - dot / 2}px;width:${dot}px;height:${dot}px;opacity:1;animation-timing-function:cubic-bezier(.65,0,.35,1)}100%{left:0;top:${lineTop}px;width:${W}px;height:${line}px;opacity:1}}
@keyframes chrFill{0%{clip-path:${linePath};opacity:1;animation-timing-function:cubic-bezier(.4,0,.6,1)}30%{clip-path:${shallowPath};animation-timing-function:${EASE_OUT}}100%{clip-path:${smilePath};opacity:1}}
@keyframes chrSoft{from{opacity:0;transform:translateY(12px);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}
@keyframes chrTag{from{opacity:0;transform:translateY(8px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
`,
    };
  }, []);

  return (
    <div
      onClick={() => setLeaving(true)} // let an impatient user tap through
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        overflow: 'hidden',
        background: 'linear-gradient(160deg, #ff9238 0%, #f47920 45%, #e2600e 100%)',
        animation: leaving ? 'chrFadeOut 300ms ease-out both' : anim('chrFadeOut', T.exitDur, T.exit, EASE_IN_OUT),
      }}
    >
      <style>{css.keyframes}</style>

      {/* Cream smile fill (full screen width) */}
      <div style={{ position: 'absolute', inset: 0, filter: 'drop-shadow(0 -8px 16px rgba(150,50,0,0.32))' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0, // hidden until the dot has become the line
            background: 'linear-gradient(180deg, #ffffff 50%, #fff4ea 68%, #fdeadb 100%)',
            // 'forwards', not 'both': before it starts it must stay hidden,
            // not show the thin line it opens from.
            animation: `chrFill ${T.fillDur}ms ${EASE_OUT} ${T.fill}ms forwards`,
          }}
        />
      </div>
      {/* Dot that stretches into the line the smile opens from */}
      <div
        style={{
          position: 'absolute',
          width: 0,
          height: 0,
          opacity: 0,
          borderRadius: 13 * css.scale,
          background: '#ffffff',
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
        <div style={{ position: 'absolute', left: 0, right: 0, top: 486, display: 'flex', justifyContent: 'center', opacity: 0, animation: anim('chrSoft', T.hrDur, T.hr, 'cubic-bezier(.37,0,.63,1)') }}>
          <img src={hrImg} alt="" style={{ width: 104, height: 'auto', display: 'block' }} />
        </div>

        {/* Slogan lockup */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 556, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0, animation: anim('chrTag', T.tagDur, T.tag, 'cubic-bezier(.33,0,.2,1)') }}>
          <p style={{ margin: 0, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 9.5, fontWeight: 700, letterSpacing: 5, paddingLeft: 5, color: '#c2510a', whiteSpace: 'nowrap' }}>
            OUR PEOPLE &nbsp;·&nbsp; OUR PRIDE
          </p>
          <p style={{ margin: '2px 0 0', fontFamily: "'CredenceSignature', cursive", fontSize: 58, lineHeight: 1.1, color: '#a8440a', whiteSpace: 'nowrap', WebkitTextStroke: '0.3px #a8440a' }}>
            Credence Family..
          </p>
        </div>

        {/* CREDENCE: letters rise from a hidden baseline, then the wedge flips on */}
        <div style={{ position: 'absolute', left: 55, top: 305, width: 250, height: 50, filter: 'drop-shadow(0 6px 10px rgba(150,50,0,0.3))' }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            {LETTERS.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                style={{ position: 'absolute', inset: 0, width: 250, height: 50, display: 'block', transform: 'translateY(110%)', animation: anim('chrRise', T.letterDur, T.letters + i * T.letterStagger) }}
              />
            ))}
          </div>
          <img
            src={wedgeImg}
            alt=""
            style={{ position: 'absolute', inset: 0, width: 250, height: 50, display: 'block', opacity: 0, transformOrigin: '125px 18px', animation: anim('chrWedge', T.wedgeDur, T.wedge, 'cubic-bezier(.33,0,.2,1)') }}
          />
        </div>

        {/* Loading line, under CREDENCE */}
        <div style={{ position: 'absolute', top: 396, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 120, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.25)', overflow: 'hidden', opacity: 0, animation: anim('chrFadeIn', T.trackDur, T.track, 'ease-out') }}>
            <div style={{ height: 3, width: 0, borderRadius: 2, background: '#ffffff', animation: anim('chrBar', T.barDur, T.bar, EASE_IN_OUT) }} />
          </div>
        </div>

        {/* The icon from the splash, centred; melts away first */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={tileImg} alt="" style={{ width: 112, height: 112, display: 'block', animation: anim('chrTileOut', T.tileOutDur, T.tileOut, EASE_IN_OUT) }} />
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
