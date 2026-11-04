/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A drawn phone (titanium edge, side buttons, Dynamic Island, status bar,
// home bar) for live previews, slightly turned in 3D; it turns to face you
// on hover so the screen can be read. Pure CSS — no picture files.

import React, { useState } from 'react';

// How thick the phone is, in px (layers of its outline).
const DEPTH = 22;

const StatusBar: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const c = dark ? '#0f172a' : '#ffffff';
  return (
    <div className="absolute inset-x-0 top-0 h-[38px] z-30 flex items-center justify-between px-[22px] pointer-events-none" aria-hidden="true">
      <span className="text-[11.5px] font-semibold tracking-tight" style={{ color: c }}>
        9:41
      </span>
      <span className="flex items-center gap-[5px]">
        {/* signal */}
        <svg width="16" height="10" viewBox="0 0 16 10" fill={c}>
          <rect x="0" y="6.5" width="3" height="3.5" rx="0.8" />
          <rect x="4.3" y="4.5" width="3" height="5.5" rx="0.8" />
          <rect x="8.6" y="2.3" width="3" height="7.7" rx="0.8" />
          <rect x="12.9" y="0" width="3" height="10" rx="0.8" />
        </svg>
        {/* wifi */}
        <svg width="14" height="10" viewBox="0 0 14 10" fill={c}>
          <path d="M7 2.2c1.9 0 3.7.7 5 2l1-1C11.4 1.6 9.3.8 7 .8S2.6 1.6 1 3.2l1 1c1.3-1.3 3.1-2 5-2Z" />
          <path d="M7 5c1.1 0 2.2.4 3 1.2l1-1C9.9 4.1 8.5 3.6 7 3.6S4.1 4.1 3 5.2l1 1C4.8 5.4 5.9 5 7 5Z" />
          <path d="M7 7.6c.5 0 1 .2 1.3.5L7 9.4 5.7 8.1c.3-.3.8-.5 1.3-.5Z" />
        </svg>
        {/* battery */}
        <span className="relative flex items-center">
          <span className="w-[22px] h-[11px] rounded-[3.5px] p-[1.5px]" style={{ border: `1px solid ${dark ? 'rgba(15,23,42,0.4)' : 'rgba(255,255,255,0.55)'}` }}>
            <span className="block h-full w-[78%] rounded-[2px]" style={{ background: c }} />
          </span>
          <span className="w-[1.5px] h-[4px] rounded-r-sm ml-[1px]" style={{ background: dark ? 'rgba(15,23,42,0.4)' : 'rgba(255,255,255,0.55)' }} />
        </span>
      </span>
    </div>
  );
};

export const PhoneMockup: React.FC<{
  children: React.ReactNode;
  // Screen size in px (the content is drawn at this size).
  width?: number;
  height?: number;
  // Status bar text colour over the top of the screen.
  statusDark?: boolean;
  tilt?: boolean;
  className?: string;
}> = ({ children, width = 262, height = 540, statusDark = false, tilt = true, className = '' }) => {
  // Turned in 3D until the pointer is over it (or it is tapped).
  const [face, setFace] = useState(false);
  return (
  <div
    className={`flex justify-center py-6 rounded-[28px] bg-gradient-to-b from-[#f4f4f6] to-[#ececf0] border border-white ${className}`}
    style={{ perspective: 1400 }}
    onMouseEnter={() => setFace(true)}
    onMouseLeave={() => setFace(false)}
    onClick={() => setFace((f) => !f)}
  >
    <div
      className="relative transition-transform duration-500 ease-out"
      // Upright, turned so its right side comes towards you (that edge shows).
      style={{ transform: tilt && !face ? 'rotateY(-30deg)' : 'rotateY(0deg)', transformStyle: 'preserve-3d' }}
    >
      {/* The phone's body: copies of its outline stacked behind the front,
          so turning it shows a real rounded titanium side (corners too). */}
      {Array.from({ length: DEPTH }).map((_, k) => {
        const d = k + 1;
        // Bright along the middle of the side, darker towards the back.
        // The side is flat titanium: light in the middle, rounding off darker at the front and back.
        const t = d / DEPTH;
        const tone = d === DEPTH ? '#3a3a3c' : t < 0.12 || t > 0.88 ? '#8e8e93' : t < 0.25 || t > 0.75 ? '#aeaeb2' : '#c7c7cc';
        return (
          <div
            key={d}
            aria-hidden="true"
            className="absolute inset-0 rounded-[50px]"
            style={{
              transform: `translateZ(${-d}px)`,
              background: `linear-gradient(180deg, ${tone}, ${tone} 8%, #e5e5ea 30%, ${tone} 55%, #ffffff 78%, ${tone} 92%)`,
              boxShadow: d === DEPTH ? '-24px 34px 50px -26px rgba(15,23,42,0.55), 0 18px 40px -24px rgba(76,29,149,0.45)' : undefined
            }}
          >
            {/* antenna lines across the side */}
            {(Math.round(DEPTH * 0.3) === d || Math.round(DEPTH * 0.3) + 1 === d || Math.round(DEPTH * 0.7) === d || Math.round(DEPTH * 0.7) + 1 === d) && (
              <>
                <span className="absolute right-0 w-[8px] h-[3px] bg-[#636366]" style={{ top: 64 }} />
                <span className="absolute right-0 w-[8px] h-[3px] bg-[#636366]" style={{ bottom: 64 }} />
              </>
            )}
          </div>
        );
      })}
      {/* buttons: on the side, half way through its depth */}
      {[
        ['left', 92, 22],
        ['left', 132, 40],
        ['left', 180, 40],
        ['right', 150, 62]
      ].map(([side, top, h]) => (
        <span
          key={`${side}${top}`}
          aria-hidden="true"
          className="absolute w-[5px] rounded-full"
          style={{
            [side as string]: -3,
            top: top as number,
            height: h as number,
            transform: `translateZ(${-DEPTH / 2}px)`,
            background: 'linear-gradient(180deg, #8e8e93, #f2f2f7 20%, #aeaeb2 50%, #e5e5ea 80%, #8e8e93)',
            boxShadow: '0 0 0 0.75px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25)'
          }}
        />
      ))}
      {/* titanium band */}
      <div
        className="relative rounded-[50px] p-[3.5px] transition-shadow duration-500"
        style={{
          background: 'linear-gradient(100deg, #8e8e93 0%, #e5e5ea 5%, #a1a1a6 12%, #7c7c80 35%, #8e8e93 60%, #6e6e73 80%, #c7c7cc 92%, #f2f2f7 96%, #8e8e93 100%)',
          boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.35)'
        }}
      >
        {/* black glass bezel */}
        <div className="rounded-[47px] bg-black p-[3px]" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
          {/* screen */}
          <div className="relative rounded-[44px] overflow-hidden bg-[#f3f0fb]" style={{ width, height }}>
            {children}
            <StatusBar dark={statusDark} />
            {/* Dynamic Island */}
            <div className="absolute left-1/2 -translate-x-1/2 top-[9px] w-[78px] h-[23px] rounded-full bg-black z-40 flex items-center justify-end pr-[9px]" aria-hidden="true">
              <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'radial-gradient(circle at 35% 35%, #3b4a7a, #0b0f1e 70%)' }} />
            </div>
            {/* home bar */}
            <div className="absolute left-1/2 -translate-x-1/2 bottom-[6px] w-[96px] h-[4px] rounded-full bg-slate-900/80 z-40" aria-hidden="true" />
            {/* glass glare */}
            <div className="absolute inset-0 pointer-events-none z-50" style={{ background: 'linear-gradient(115deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 32%)' }} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  </div>
);
};
