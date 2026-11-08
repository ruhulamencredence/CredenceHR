/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Welcome slides — shown once to an account on its first sign-in, on the
// website and in the app (WelcomeSlidesRoutes.ts decides; App.tsx asks).
// Four slides: Welcome, Check in from anywhere, Leave in two taps, You're all
// set. Skip (jumps to the last slide), Back, → or a swipe; "Get started"
// (or closing it) marks it seen for this account on every device.
// Phone: full screen. Wider screens: a phone-sized card over the dimmed page.
// Pictures are the app's own animations (the login illustration — already
// kept on the device — GPS, beach, plan).

import React, { useEffect, useRef, useState } from 'react';
import { Lottie, useLottieJson } from './LazyLottie';
import { loadAuthHero } from '../lib/authHeroAsset';

const loadGps = () => import('../assets/gps-navigation.json');
const loadBeach = () => import('../assets/Beach.json');
const loadPlan = () => import('../assets/business-plan.json');

interface Slide {
  load: () => Promise<{ default: any }>;
  title: React.ReactNode;
  text: string;
  chips: { icon: string; text: string; style: React.CSSProperties }[];
}

const SLIDES: Slide[] = [
  {
    load: loadAuthHero,
    title: (
      <>
        Welcome to
        <br />
        CredenceHR
      </>
    ),
    text: 'Your attendance, leave and pay — all in one place.',
    chips: [
      { icon: '🕘', text: 'In 09:02', style: { left: '-6%', top: '64%' } },
      { icon: '✅', text: 'Leave approved', style: { right: '-8%', top: '6%' } }
    ]
  },
  {
    load: loadGps,
    title: (
      <>
        Check in from
        <br />
        anywhere
      </>
    ),
    text: 'One tap. Your location is saved — office or project site.',
    chips: [
      { icon: '📍', text: 'Office', style: { left: '-6%', top: '6%' } },
      { icon: '✓', text: 'Checked in', style: { right: '-8%', top: '76%' } }
    ]
  },
  {
    load: loadBeach,
    title: (
      <>
        Leave in
        <br />
        two taps
      </>
    ),
    text: 'See your balance, apply, and follow the approval.',
    chips: [
      { icon: '🗓️', text: 'Your balance', style: { left: '-6%', top: '8%' } },
      { icon: '📨', text: 'Sent for approval', style: { right: '-10%', top: '78%' } }
    ]
  },
  {
    load: loadPlan,
    title: "You're all set!",
    text: 'Everything you need is on your Dashboard.',
    chips: []
  }
];

const SlideArt: React.FC<{ slide: Slide; active: boolean }> = ({ slide, active }) => {
  const data = useLottieJson(slide.load, active);
  return (
    <div className="relative flex-1 min-h-0 grid place-items-center -mx-2">
      {/* Picture, glow and chips together, so the chips stay by the picture on any screen height. */}
      <div className="relative w-[72vmin] max-w-[270px] aspect-square grid place-items-center">
        <div
          className="absolute w-[84%] aspect-square opacity-70"
          style={{ borderRadius: '44% 56% 52% 48%', background: 'radial-gradient(circle at 35% 30%, #efe2ff, #d8c6ff 55%, #c4b0ff)' }}
        />
        {data ? <Lottie src={data} loop autoplay className="relative w-full h-full" /> : <div className="relative w-full h-full" />}
        {slide.chips.map((c) => (
          <div
            key={c.text}
            className="absolute flex items-center gap-1.5 bg-white/95 rounded-[14px] px-3 py-1.5 text-[11.5px] font-bold text-slate-800 whitespace-nowrap shadow-[0_12px_26px_-12px_rgba(80,30,160,0.45)]"
            style={c.style}
          >
            <span className="text-[13px]">{c.icon}</span>
            {c.text}
          </div>
        ))}
      </div>
    </div>
  );
};

export const WelcomeSlides: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [i, setI] = useState(0);
  const last = SLIDES.length - 1;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (d: number) => setI((n) => Math.min(last, Math.max(0, n + d)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = SLIDES[i];
  return (
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop md:flex md:items-center md:justify-center md:p-6" role="dialog" aria-modal="true" aria-label="Welcome to CredenceHR">
      <div
        className="relative w-full h-full md:w-[390px] md:h-[min(760px,92vh)] md:rounded-[36px] md:shadow-[0_40px_80px_-30px_rgba(60,20,120,0.6)] overflow-hidden flex flex-col px-6"
        style={{
          background: 'linear-gradient(175deg, #fff7fb 0%, #f6f0ff 55%, #efe7ff 100%)',
          paddingTop: 'max(1.25rem, calc(env(safe-area-inset-top) + 0.75rem))',
          paddingBottom: 'max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem))'
        }}
        onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t) return;
          const dx = e.changedTouches[0].clientX - t.x;
          const dy = e.changedTouches[0].clientY - t.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
        }}
      >
        <div className="flex items-center justify-between h-8">
          {i < last ? (
            <button
              type="button"
              onClick={() => setI(last)}
              className="rounded-full px-4 py-1.5 text-xs font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #2a0f5c, #5b21b6)' }}
            >
              Skip
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-1.5" aria-label={`Slide ${i + 1} of ${SLIDES.length}`}>
            {SLIDES.map((_, j) => (
              <span
                key={j}
                className="h-1 rounded-full transition-all duration-300"
                style={{ width: j === i ? 28 : 12, background: j === i ? 'linear-gradient(90deg, #6d28d9, #c026d3)' : '#d6cdee' }}
              />
            ))}
          </div>
        </div>

        <div key={i} className="flex-1 min-h-0 flex flex-col animate-[welcomeIn_.35s_ease-out]">
          <SlideArt slide={s} active />
          <h2 className="text-[28px] leading-[1.15] font-extrabold tracking-tight text-[#1b1338]">{s.title}</h2>
          <p className="text-[14px] leading-relaxed text-slate-500 mt-2">{s.text}</p>
        </div>

        {i < last ? (
          <div className="flex items-center justify-between mt-6">
            {i > 0 ? (
              <button type="button" onClick={() => go(-1)} className="text-sm font-bold text-slate-400 px-1 py-2">
                Back
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next"
              className="w-14 h-14 rounded-full text-white text-2xl flex items-center justify-center shadow-[0_14px_26px_-8px_rgba(124,58,237,0.6)] active:scale-95 transition-transform"
              style={{ background: 'linear-gradient(135deg, #6d28d9, #c026d3)' }}
            >
              →
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onDone}
            className="mt-6 w-full rounded-full py-3.5 text-[15px] font-extrabold text-white shadow-[0_14px_26px_-10px_rgba(124,58,237,0.6)] active:scale-[0.98] transition-transform"
            style={{ background: 'linear-gradient(135deg, #6d28d9, #c026d3)' }}
          >
            Get started
          </button>
        )}
      </div>
      <style>{'@keyframes welcomeIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}'}</style>
    </div>
  );
};

export default WelcomeSlides;
