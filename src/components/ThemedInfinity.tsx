/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import infinityLoaderSvg from '../assets/infinity-loader.svg?raw';

// The Infinity loader — the app's own loader (assets/infinity-loader.svg, the
// SVG export of infinity-loader.json) — painted in the theme colour. It is
// plain SVG that animates itself, so it needs no animation player and draws
// the moment the page does. Its seven stroke colours are read from CSS
// (--il-1 darkest … --il-7 lightest, made from --g-accent in index.css), so
// Orange / Violet / Mono each get their own and a theme change repaints it.
const STROKES = Array.from(new Set(infinityLoaderSvg.match(/stroke="#[0-9a-f]{6}"/gi) || []));
const lum = (h: string) => {
  const v = h.slice(-7, -1);
  return 0.3 * parseInt(v.slice(0, 2), 16) + 0.59 * parseInt(v.slice(2, 4), 16) + 0.11 * parseInt(v.slice(4, 6), 16);
};
const MARKUP = (() => {
  let out = infinityLoaderSvg.replace(/ id="i\d+"/g, '').replace(' xmlns:xlink="http://www.w3.org/1999/xlink"', '');
  STROKES.sort((a, b) => lum(a) - lum(b)).forEach((s, i) => {
    out = out.split(s).join(`style="stroke:var(--il-${i + 1})"`);
  });
  return out.replace('<svg ', '<svg class="chr-il" aria-hidden="true" ');
})();

interface Props {
  size?: number;
  className?: string;
}

export const ThemedInfinity: React.FC<Props> = ({ size = 115, className }) => (
  <span
    className={className}
    style={{ display: 'inline-block', width: size, height: size, lineHeight: 0 }}
    dangerouslySetInnerHTML={{ __html: MARKUP }}
  />
);
