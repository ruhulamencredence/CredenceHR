const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
const AND='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const open=async(opts,name)=>{const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','user-agent':opts.userAgent||'x'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
  const ctx=await b.newContext({...opts,timezoneId:'Asia/Dhaka',geolocation:{latitude:23.7806,longitude:90.4074},permissions:['geolocation']});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));localStorage.setItem('credence_a2hs_dismissed','1');},[a.token,a.user]);
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  for (const n of ['Later','Got it','Not now']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
  return {p,ctx};};
 for (const [label,opts] of [['Android browser',{viewport:{width:412,height:915},userAgent:AND,isMobile:true,hasTouch:true}],['computer',{viewport:{width:1440,height:900}}]]) {
  const {p,ctx}=await open(opts);
  const setNow=p.getByRole('button',{name:'Set Now'}).locator('visible=true').first();
  ok(await setNow.count()>0,`${label}: card looks as usual (Set Now is there)`);
  let t=await p.locator('body').innerText();
  ok(!/from the app only|can't be given from a computer/i.test(t),`${label}: no notice before tapping`);
  await setNow.click(); await p.waitForTimeout(900);
  t=await p.locator('body').innerText();
  ok(label==='computer'? /can't be given from a computer/i.test(t) : /from the app only/i.test(t),`${label}: tapping Set Now opens the notice`);
  ok(label==='computer'? await p.getByRole('link',{name:/Get the app/}).count()===0 : await p.getByRole('link',{name:/Get the app/}).count()===1,`${label}: APK button only on Android`);
  ok(await p.locator('text=Confirm Check In').count()===0,`${label}: no map / location asked`);
  await p.screenshot({path:`${D}/${label.replace(' ','-')}.png`});
  await p.getByRole('button',{name:'Close',exact:true}).click(); await p.waitForTimeout(400);
  ok(!/from the app only|can't be given from a computer/i.test(await p.locator('body').innerText()),`${label}: Close hides it`);
  await ctx.close();
 }
 const {p,ctx}=await open({...devices['iPhone 13']});
 await p.getByRole('button',{name:'Set Now'}).locator('visible=true').first().click(); await p.waitForTimeout(2500);
 const t=await p.locator('body').innerText();
 ok(!/from the app only|can't be given from a computer/i.test(t),'iPhone: no notice, goes on to the location / map as before');
 await p.screenshot({path:`${D}/iphone.png`}); await ctx.close();
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
