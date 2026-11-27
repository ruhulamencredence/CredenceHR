// The light sign-in page (main.tsx WebSignIn + AuthScreen still picture):
// what loads first, then signing in / out still works. Run against a
// production build (npm run build; node dist/server.cjs), URL in argv[3].
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const D=process.argv[2], B=process.argv[3]||'http://localhost:3300';
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const b=await chromium.launch();
 for(const [label,opts] of [['computer',{viewport:{width:1366,height:850}}],['phone',{...devices['Pixel 7']}]]){
  const ctx=await b.newContext(opts); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  const js=[]; p.on('request',r=>{const u=r.url(); if(/\.js(\?|$)|\.json(\?|$)/.test(u)) js.push(u.replace(B,''));});
  await p.goto(B+'/',{waitUntil:'load'}); await p.waitForTimeout(2500);
  const bodyT=await p.locator('body').innerText();
  ok(/Welcome|Sign in|Next/i.test(bodyT),`${label}: sign-in screen shows`);
  ok(await p.locator('img[src*="office-illustration-still"]').count()===1,`${label}: the illustration shows as a still picture`);
  const lottieEarly=js.some(u=>/lottie|office-illustration.*\.json|anim-/.test(u));
  ok(!lottieEarly,`${label}: no animation player / data downloaded before any touch`);
  const before=js.length; console.log('   scripts before interaction:',js.filter(u=>/\.js/.test(u)).map(u=>u.split('/').pop()).join(', '));
  // touch / type -> animation + app code
  await p.mouse.move(200,200); await p.mouse.move(300,300); await p.locator('input').first().focus(); await p.waitForTimeout(3500);
  ok(js.length>before,`${label}: after the first touch the app code / animation start downloading`);
  ok(await p.locator('.hero-art svg').count()>=1,`${label}: the animation plays after the first touch`);
  await p.screenshot({path:`${D}/fast-${label}-signin.png`});
  // sign in (workspace step first if shown)
  const ws=p.locator('input[placeholder*="credence" i], input[placeholder*="workspace" i], input[placeholder^="e.g." i]').first();
  if(await ws.count() && !(await p.locator('input[type=password]').count())){ await ws.fill('credence'); await p.getByRole('button',{name:/Next/}).click(); await p.waitForTimeout(1500); }
  // a remembered page from an earlier session must not come back on a fresh sign-in
  await p.evaluate(()=>{ try{ localStorage.setItem('mpr_self_service_view_1','myTasks'); }catch{} });
  await p.locator('input:not([type=password]):not([type=hidden])').last().fill('admin@credence.test');
  await p.locator('input[type=password]').fill('ProbePass123');
  await p.locator('input[type=password]').press('Enter'); await p.waitForTimeout(7000);
  let t=await p.locator('body').innerText();
  ok(await p.locator('input[type=password]').count()===0&&/Dashboard|Good (morning|afternoon|evening)|What do you need today|My Attendance/i.test(t),`${label}: signing in opens the app`);
  ok(new URL(p.url()).pathname==='/'||!/my-tasks/.test(p.url()),`${label}: a fresh sign-in lands on the Dashboard (not the remembered page) — ${new URL(p.url()).pathname}`);
  await p.screenshot({path:`${D}/fast-${label}-after.png`});
  // reload while signed in
  await p.reload({waitUntil:'load'}); await p.waitForTimeout(6000);
  t=await p.locator('body').innerText();
  ok(await p.locator('input[type=password]').count()===0&&/My Attendance|What do you need today/i.test(t),`${label}: reload keeps you signed in`);
  // sign out -> sign-in screen -> sign in again
  await p.evaluate(()=>{localStorage.removeItem('mpr_token');localStorage.removeItem('mpr_user');}); await p.reload({waitUntil:'load'}); await p.waitForTimeout(3000);
  ok(/Welcome|Sign in|Next/i.test(await p.locator('body').innerText()),`${label}: without a session the sign-in screen comes back`);
  console.log('   errors:',errs.slice(0,3)); ok(errs.length===0,`${label}: no page errors`);
  await ctx.close();
 }
 // public pages
 const ctx=await b.newContext(); const p=await ctx.newPage();
 await p.goto(B+'/privacy',{waitUntil:'load'}); await p.waitForTimeout(2500);
 ok(/Privacy Policy/i.test(await p.locator('body').innerText()),'/privacy still opens');
 await p.goto(B+'/verify',{waitUntil:'load'}); await p.waitForTimeout(2500);
 ok(/verif/i.test(await p.locator('body').innerText()),'/verify still opens');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
