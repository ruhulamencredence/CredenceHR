/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// jsPDF with Bangla. jsPDF's own fonts have no Bengali letters, and jsPDF
// can't arrange them anyway (conjuncts, vowel signs before the consonant), so
// a name like "রহিম উদ্দিন" came out as gibberish in every PDF. Every PDF in
// the app imports jsPDF from here instead of 'jspdf': text that contains
// Bengali is drawn by the browser (which shapes it properly) onto a canvas and
// placed as a picture at the same spot, size, colour, alignment and baseline;
// everything else is drawn by jsPDF exactly as before. Width measuring
// (getTextWidth / splitTextToSize) uses the same browser measure, so right
// alignment and wrapping still work. jspdf-autotable draws its cells through
// doc.text, so tables are covered too.
import jsPDF from 'jspdf';

const BENGALI = /[ঀ-৿]/;
const FONT_STACK = '"Noto Sans Bengali", "Hind Siliguri", "Nirmala UI", "Vrinda", "Shonar Bangla", "Kohinoor Bangla", "Bangla Sangam MN", sans-serif';
const SCALE = 4; // canvas px per PDF pt — sharp when printed

let measureCtx: CanvasRenderingContext2D | null = null;
const ctx2d = (): CanvasRenderingContext2D | null => {
  if (typeof document === 'undefined') return null;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
};
const cssFont = (doc: any, px: number) => {
  const style = String(doc.getFont?.().fontStyle || '').toLowerCase();
  return `${style.includes('italic') ? 'italic ' : ''}${style.includes('bold') ? 'bold ' : ''}${px}px ${FONT_STACK}`;
};
// Width of `text` in the document's units at the current font size.
const widthUnits = (doc: any, text: string): number => {
  const c = ctx2d();
  if (!c) return 0;
  const pt = doc.getFontSize();
  c.font = cssFont(doc, pt * SCALE);
  return c.measureText(text).width / SCALE / doc.internal.scaleFactor;
};

function patch(doc: any): any {
  if (!doc || doc.__bangla) return doc;
  doc.__bangla = true;
  const origText = doc.text;
  const origUnitWidth = doc.getStringUnitWidth;

  doc.getStringUnitWidth = function (text: string, options?: any) {
    if (typeof text === 'string' && BENGALI.test(text) && ctx2d()) {
      // jsPDF's unit: width divided by font size (in pt).
      return (widthUnits(this, text) * this.internal.scaleFactor) / this.getFontSize();
    }
    return origUnitWidth.call(this, text, options);
  };

  doc.text = function (text: any, x: any, y: any, options?: any, ...rest: any[]) {
    // Older call shape text(x, y, text) and anything without Bengali: unchanged.
    const lines: string[] | null = typeof text === 'string' ? text.split('\n') : Array.isArray(text) && text.every((t) => typeof t === 'string') ? text : null;
    if (!lines || typeof x !== 'number' || typeof y !== 'number' || !lines.some((l) => BENGALI.test(l)) || !ctx2d()) {
      return origText.call(this, text, x, y, options, ...rest);
    }
    const opts = options && typeof options === 'object' ? options : {};
    const k = this.internal.scaleFactor; // pt per unit
    const pt = this.getFontSize();
    const lineH = (pt * (this.getLineHeightFactor?.() || 1.15)) / k;
    const px = pt * SCALE;
    const color = typeof this.getTextColor === 'function' ? this.getTextColor() : '#000000';
    const align = opts.align || 'left';
    const baseline = opts.baseline || 'alphabetic';
    const ascent = (pt * 0.95) / k; // Noto Sans Bengali: ~0.95 em above the baseline
    const descent = (pt * 0.45) / k;
    lines.forEach((line, i) => {
      const lineY = y + i * lineH;
      if (!BENGALI.test(line)) {
        origText.call(this, line, x, lineY, { ...opts, maxWidth: undefined });
        return;
      }
      const c = document.createElement('canvas');
      const g = c.getContext('2d');
      if (!g) return;
      g.font = cssFont(this, px);
      const w = Math.max(1, Math.ceil(g.measureText(line).width));
      const h = Math.ceil(px * 1.5);
      c.width = w + 4;
      c.height = h;
      g.font = cssFont(this, px);
      g.fillStyle = /^#|^rgb/.test(String(color)) ? String(color) : '#000000';
      g.textBaseline = 'alphabetic';
      const basePx = Math.round(px * 1.05);
      g.fillText(line, 2, basePx);
      const wU = c.width / SCALE / k;
      const hU = h / SCALE / k;
      const left = align === 'right' ? x - wU : align === 'center' ? x - wU / 2 : x;
      const baseU = basePx / SCALE / k;
      const top =
        baseline === 'top' || baseline === 'hanging'
          ? lineY - (baseU - ascent)
          : baseline === 'middle'
          ? lineY - baseU + (ascent - descent) / 2
          : baseline === 'bottom'
          ? lineY - baseU - descent
          : lineY - baseU;
      this.addImage(c.toDataURL('image/png'), 'PNG', left, top, wU, hU, undefined, 'FAST');
    });
    return this;
  };
  return doc;
}

// Used exactly like jsPDF (`new jsPDF({...})`), and as its type.
class BanglaJsPDF extends jsPDF {
  constructor(...args: any[]) {
    super(...(args as []));
    // jsPDF's constructor hands back its own object; patch that one.
    return patch(this);
  }
}

export default BanglaJsPDF;
export { BanglaJsPDF as jsPDF };
