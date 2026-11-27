const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
// The sign-in picture painted from index.html vs where React draws it (production build).
const D=process.argv[2], B=process.argv[3]||'http://localhost:3300';
(async()=>{const b=await chromium.launch();
for (const [tag,opt] of [['phone',devices['Pixel 7']],['desk',{viewport:{width:1440,height:900}}]]) {
  const c1=await b.newContext({...opt}); const p1=await c1.newPage(); await p1.route(/\.js$/,r=>r.abort());
  await p1.goto(B+'/'); await p1.waitForTimeout(1500);
  const r1=await p1.locator('#web-signin-shell .ws-hero').boundingBox(); await p1.screenshot({path:`${D}/shell-${tag}.png`});
  const c2=await b.newContext({...opt}); const p2=await c2.newPage(); await p2.goto(B+'/'); await p2.waitForSelector('text=Welcome'); await p2.waitForTimeout(800);
  const r2=await p2.locator('.hero-art img').first().boundingBox(); await p2.screenshot({path:`${D}/react-${tag}.png`});
  console.log(tag,'shell',JSON.stringify(r1),'react',JSON.stringify(r2),'shell left in DOM:',await p2.locator('#web-signin-shell').count());
  // signed in: the orange splash, not the sign-in picture
  const c3=await b.newContext({...opt}); await c3.addInitScript(()=>localStorage.setItem('mpr_token','x')); const p3=await c3.newPage(); await p3.route(/\.js$/,r=>r.abort()); await p3.goto(B+'/'); await p3.waitForTimeout(800);
  console.log(tag,'with a session -> splash visible:',await p3.locator('#mpr-boot-spinner').isVisible(),'shell visible:',await p3.locator('#web-signin-shell').isVisible());
}
await b.close();})();
