const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
(async () => {
  const b = await chromium.launch();
  const warm = await b.newContext({ viewport: { width: 390, height: 844 } });
  const w = await warm.newPage(); await w.goto('http://localhost:3201/'); await w.waitForTimeout(3000); await warm.close();
  const res = [];
  for (let run = 0; run < 3; run++) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { window.androidBridge = { postMessage() {} }; });
    const p = await ctx.newPage();
    const c = await ctx.newCDPSession(p);
    await c.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await b.startTracing(p, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] });
    await p.goto('http://localhost:3201/'); await p.waitForTimeout(6500);
    const t = JSON.parse((await b.stopTracing()).toString()).traceEvents;
    const n = (name) => t.filter((e) => e.name === name).length;
    res.push({ paint: n('Paint'), dropped: n('DroppedFrame'), frames: n('DrawFrame'), raster: n('RasterTask') });
    await ctx.close();
  }
  console.log(JSON.stringify(res)); await b.close();
})();
