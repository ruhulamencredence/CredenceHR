// Employee Tracking -> one person's path on a phone: the controls are laid
// out for a phone (no sideways overflow, labelled 2x2 fields, full-width Apply,
// reports side by side); Apply / View Report / Back to Live still work.
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const b=await chromium.launch();
 for(const [label,opts] of [['phone',{...devices['Pixel 7']}],['computer',{viewport:{width:1440,height:900}}]]){
  const ctx=await b.newContext(opts);
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));window.__credenceTrackingFocus={id:u.id,name:u.name,at:Date.now()+60000};},[a.token,a.user]);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(B+'/admin/tracking',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const t=await p.locator('body').innerText();
  ok(/movement path/.test(t),`${label}: path view of ${a.user.name} is open`);
  ok(await p.getByText('From date',{exact:true}).count()===1&&await p.getByText('To time',{exact:true}).count()===1,`${label}: date / time fields have labels`);
  const sw=await p.evaluate(()=>[document.documentElement.scrollWidth,window.innerWidth]);
  ok(sw[0]<=sw[1],`${label}: no sideways overflow (${sw[0]} <= ${sw[1]})`);
  if(label==='phone'){
    const r=await p.evaluate(()=>{const box=(t)=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t)?.getBoundingClientRect();return {apply:box('Apply'),view:box('View Report'),stay:box('Stay Report'),live:box('Live Follow'),back:box('Back to Live'),w:window.innerWidth};});
    ok(r.apply&&r.apply.width>r.w*0.7,'phone: Apply spans the card');
    ok(r.view&&r.stay&&Math.abs(r.view.top-r.stay.top)<2,'phone: View Report and Stay Report side by side');
    ok(r.live&&r.back&&Math.abs(r.live.top-r.back.top)<2&&Math.abs(r.live.width-r.back.width)<4,'phone: Live Follow and Back to Live side by side, same size');
    const dup=await p.locator('h3:visible',{hasText:'Employee Tracking'}).count();
    ok(dup===0,'phone: no second "Employee Tracking" title under the page header');
  }
  await p.getByRole('button',{name:'Apply'}).click(); await p.waitForTimeout(2000);
  ok(/\d+ points?/.test(await p.locator('body').innerText()),`${label}: Apply loads the points`);
  await p.screenshot({path:`${D}/track-${label}.png`,fullPage:label==='phone'});
  await p.getByRole('button',{name:/View Report/}).click(); await p.waitForTimeout(1200);
  ok(/Report|Time|Accuracy/i.test(await p.locator('body').innerText()),`${label}: View Report opens`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  console.log('   errors:',errs.slice(0,2)); ok(errs.length===0,`${label}: no page errors`);
  await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
