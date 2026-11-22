/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Lottie } from './LazyLottie';
import infinityLoaderAnimation from '../assets/infinity-loader.json';

// The Infinity loader painted in the app's own theme colour. The animation file
// is a fixed set of seven colours; here they are swapped for seven shades of
// the current --g-accent (dark to light), so Violet, Orange and Mono each get
// their own loader, and a theme change repaints it. The shared Spinner keeps
// the original colours.

const RE = /"c":\{"a":0,"k":\[([0-9.]+),([0-9.]+),([0-9.]+),1\]/g;
const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

// The file's colours, darkest first, found once.
const SOURCE = JSON.stringify(infinityLoaderAnimation);
const COLOURS: { text: string }[] = (() => {
  const seen = new Map<string, number[]>();
  for (const m of SOURCE.matchAll(RE)) seen.set(m[0], [Number(m[1]), Number(m[2]), Number(m[3])]);
  return [...seen.entries()].sort((a, b) => lum(a[1]) - lum(b[1])).map(([text]) => ({ text }));
})();

// "#7F00FF" or "rgb(…)" -> [0..1, 0..1, 0..1]
function parseColour(value: string): number[] | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const rgb = /^rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i.exec(v);
  return rgb ? [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255] : null;
}

const mix = (c: number[], to: number, amount: number) => c.map((x) => x + (to - x) * amount);

// n shades of one colour: darker than the accent, the accent, then lighter.
function shades(accent: number[], n: number): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1); // 0 darkest … 1 lightest
    if (t < 0.34) return mix(accent, 0, 0.45 * (1 - t / 0.34));
    return mix(accent, 1, 0.7 * ((t - 0.34) / 0.66));
  });
}

function paint(accentText: string): any {
  const accent = parseColour(accentText) || [0.498, 0, 1];
  const ramp = shades(accent, COLOURS.length);
  let out = SOURCE;
  COLOURS.forEach(({ text }, i) => {
    out = out.split(text).join(`"c":{"a":0,"k":[${ramp[i].map((x) => x.toFixed(4)).join(',')},1]`);
  });
  return JSON.parse(out);
}

function readAccent(): string {
  return typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--g-accent');
}

interface Props {
  size?: number;
  className?: string;
}

export const ThemedInfinity: React.FC<Props> = ({ size = 115, className }) => {
  const [accent, setAccent] = useState(readAccent);
  useEffect(() => {
    // Orange / Mono / Violet switch on <html data-ui="…">.
    const watch = new MutationObserver(() => setAccent(readAccent()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui', 'class', 'style'] });
    return () => watch.disconnect();
  }, []);
  const data = useMemo(() => paint(accent), [accent]);
  return (
    <span className={className} style={{ display: 'inline-block', width: size, height: size, lineHeight: 0 }}>
      <Lottie src={data} autoplay loop style={{ width: '100%', height: '100%' }} />
    </span>
  );
};
