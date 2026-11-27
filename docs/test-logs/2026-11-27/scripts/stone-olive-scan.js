() => {
  // colours that don't belong: violet/purple/indigo/blue/orange hues (not the logo, not status red/amber/green)
  const hue = (c) => { if (/^oklch/.test(c)) { const m=(c.match(/[\d.]+/g)||[]).map(Number); const a=c.includes('/')?m[3]:1; if(a<0.25) return null; const C=m[1], H=m[2]; if(C<0.07) return null; return {h: H>=230&&H<320?250: H>=40&&H<75?25:120, s:1}; } const m = (c.match(/[\d.]+/g) || []).map(Number); if (m.length < 3) return null; if (m.length > 3 && m[3] < 0.25) return null;
    let [r, g, b] = m.slice(0, 3).map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 0.18 || mx < 0.25) return null;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; return { h, s: d / mx }; };
  const bad = (h) => h && h.s > 0.35 && ((h.h >= 200 && h.h < 300) || (h.h >= 15 && h.h < 38));
  const out = {}; let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.top > innerHeight) continue;
    if (el.closest('img,svg[class*="logo"],.leaflet-container,[data-keep]') || el.tagName === 'IMG') continue;
    if (el.closest('a[href*="play.google"],a[href*="apple.com"]')) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const txt = (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30);
    for (const [k, v] of [['bg', cs.backgroundColor], ['text', el.childNodes.length && [...el.childNodes].some(x => x.nodeType === 3 && x.nodeValue.trim()) ? cs.color : ''], ['svg', el.tagName === 'svg' || el.tagName === 'path' ? cs.stroke : '']]) {
      if (!v) continue; const h = hue(v); if (!bad(h)) continue;
      const key = `${k} ${v} → "${txt}"`; out[key] = (out[key] || 0) + 1; n++;
    }
  }
  return { n, items: Object.entries(out).slice(0, 12) };
}
