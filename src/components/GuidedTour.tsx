/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One guided tour (src/lib/tutorials.ts) over the real screen: opens the
// tour's page, then step by step darkens everything but one element, outlines
// it and explains it in a small liquid-glass card — 1/6 · Back · Next, Skip.
// Steps whose element isn't on screen (no access, phone-only, still empty)
// are left out. Finishing it (the last "Got it") marks it done for the
// account; Skip, Esc or the phone's Back just close it.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Tour, TourStep } from '../lib/tutorials';
import { requestTourSection } from '../lib/tutorials';
import { useBackButtonClose } from '../lib/useBackButtonClose';

type Box = { x: number; y: number; w: number; h: number };

const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
};
const findTarget = (step: TourStep): Element | null => {
  for (const sel of step.sel || []) {
    for (const el of Array.from(document.querySelectorAll(sel))) if (visible(el)) return el;
  }
  return null;
};

export const GuidedTour: React.FC<{ tour: Tour; onClose: (finished: boolean) => void }> = ({ tour, onClose }) => {
  // null while the page is opening and the steps are being worked out.
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [vw, setVw] = useState({ w: window.innerWidth, h: window.innerHeight });
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(150);

  const close = useCallback((finished: boolean) => onClose(finished), [onClose]);
  useBackButtonClose(true, () => close(false));

  // Open the tour's page, give it a moment to draw (its cards load their
  // data), then keep only the steps that have something on screen.
  useEffect(() => {
    requestTourSection(tour.section);
    let alive = true;
    const started = Date.now();
    const settle = () => {
      if (!alive) return;
      const wanted = tour.steps.filter((s) => s.sel?.length);
      const found = wanted.filter((s) => findTarget(s)).length;
      // Wait up to ~3s for the page's elements (lazy pages, data loading).
      if (found < wanted.length && Date.now() - started < 3000) return void setTimeout(settle, 200);
      const list = tour.steps.filter((s) => !s.sel?.length || findTarget(s));
      setSteps(list.length ? list : [{ title: tour.title, text: 'Nothing to show on this screen yet.' }]);
    };
    const t = setTimeout(settle, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tour]);

  const step = steps?.[i];

  // Bring the step's element into view, then follow it (scrolling, cards
  // still growing as their data arrives, the window resizing).
  useEffect(() => {
    if (!step) return;
    const el = findTarget(step);
    if (el && getComputedStyle(el).position !== 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 190) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    let raf = 0;
    let last = '';
    const track = () => {
      const t = findTarget(step);
      const r = t?.getBoundingClientRect();
      const next = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      const key = next ? `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.w)},${Math.round(next.h)}` : '-';
      if (key !== last) {
        last = key;
        setBox(next);
      }
      raf = requestAnimationFrame(track);
    };
    track();
    const onResize = () => setVw({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [step]);

  useLayoutEffect(() => {
    if (tipRef.current) setTipH(tipRef.current.offsetHeight);
  }, [step, box]);

  const last = steps ? steps.length - 1 : 0;
  const go = useCallback(
    (d: number) => {
      if (!steps) return;
      if (i + d > last) return close(true);
      setI(Math.max(0, i + d));
    },
    [steps, i, last, close]
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, close]);

  // Where the card goes: under the element if it fits, else above it, else
  // the bottom of the screen; centred when the step has no element.
  const pad = 8;
  const tipW = Math.min(320, vw.w - 24);
  let tipStyle: React.CSSProperties;
  let arrow: { left: number; top: boolean } | null = null;
  if (box) {
    const below = box.y + box.h + pad + 14 + tipH < vw.h - 8;
    const above = box.y - pad - 14 - tipH > 8;
    const left = Math.min(Math.max(12, box.x + box.w / 2 - tipW / 2), vw.w - tipW - 12);
    const top = below ? box.y + box.h + pad + 12 : above ? box.y - pad - 12 - tipH : vw.h - tipH - 16;
    tipStyle = { left, top, width: tipW };
    if (below || above) arrow = { left: Math.min(Math.max(22, box.x + box.w / 2 - left), tipW - 22), top: below };
  } else {
    tipStyle = { left: (vw.w - tipW) / 2, top: Math.max(16, (vw.h - tipH) / 2), width: tipW };
  }

  return createPortal(
    <div className="fixed inset-0 z-[96]" role="dialog" aria-modal="true" aria-label={tour.title}>
      {/* Catches taps, so the page under the tour isn't used by accident. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />
      {box ? (
        <div
          className="absolute rounded-[20px] pointer-events-none transition-all duration-300 ease-out"
          style={{
            left: box.x - pad,
            top: box.y - pad,
            width: box.w + pad * 2,
            height: box.h + pad * 2,
            boxShadow: '0 0 0 9999px rgba(15,8,35,0.62)',
            outline: '2.5px dashed rgba(255,255,255,0.95)',
            outlineOffset: 3
          }}
        />
      ) : (
        <div className="absolute inset-0 liquid-glass-backdrop pointer-events-none" />
      )}

      {steps && step && (
        <div ref={tipRef} className="absolute transition-[left,top] duration-300 ease-out" style={tipStyle}>
          {arrow && (
            <span
              className="absolute w-3.5 h-3.5 rotate-45 bg-white/90"
              style={{ left: arrow.left - 7, [arrow.top ? 'top' : 'bottom']: -6 }}
              aria-hidden="true"
            />
          )}
          <div key={i} className="liquid-glass liquid-glass-in rounded-[32px] px-5 pt-4 pb-3.5" style={{ background: 'rgba(255,255,255,0.93)' }}>
            <div className="flex items-start gap-2">
              <h3 className="flex-1 text-[15px] font-extrabold text-slate-900">{step.title}</h3>
              <button type="button" onClick={() => close(false)} className="liquid-glass-chip w-7 h-7 rounded-full flex items-center justify-center -mr-1.5 shrink-0" aria-label="Close tour">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[13px] leading-relaxed text-slate-600 mt-1">{step.text}</p>
            <div className="flex items-center justify-between mt-3">
              <span className="text-[13px] font-extrabold text-slate-900">
                {i + 1}
                <span className="text-slate-400">/{steps.length}</span>
                {i < last && (
                  <button type="button" onClick={() => close(false)} className="ml-2 text-xs font-bold text-slate-500 px-1 py-1">
                    Skip
                  </button>
                )}
              </span>
              <span className="flex items-center gap-1">
                {i > 0 && (
                  <button type="button" onClick={() => go(-1)} className="text-xs font-bold text-slate-500 px-2 py-1.5">
                    Back
                  </button>
                )}
                <button type="button" onClick={() => go(1)} className="liquid-glass-button rounded-full px-4 py-1.5 text-[13px] font-bold text-white">
                  {i === last ? 'Got it' : 'Next'}
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
      {!steps && (
        <div className="absolute inset-x-0 bottom-10 flex justify-center pointer-events-none">
          <span className="liquid-glass rounded-full px-4 py-2 text-xs font-semibold text-slate-700" role="status">
            Opening {tour.title}…
          </span>
        </div>
      )}
    </div>,
    document.body
  );
};

export default GuidedTour;
