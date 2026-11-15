const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
const UA={ android:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' };
const login=async (e,ua)=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','user-agent':ua||'x'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const open=async(who,opts,shot,url='/')=>{const a=await login(who,opts.userAgent);const {touchPoints,...o}=opts;const ctx=await b.newContext({...o,timezoneId:'Asia/Dhaka'});
  if (touchPoints) await ctx.addInitScript((n)=>{Object.defineProperty(Navigator.prototype,'maxTouchPoints',{get:()=>n});},touchPoints);
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));localStorage.setItem('credence_a2hs_dismissed','1');},[a.token,a.user]);
  const p=await ctx.newPage(); await p.goto(B+url,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5500);
  for (const n of ['Later','Got it','Not now','Close']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
  await p.waitForTimeout(500); if (shot) await p.screenshot({path:`${D}/${shot}.png`}); return {p,ctx};};
 const tile=async(p)=>p.locator('div:has(> div:text-is("In Time"))').first().innerText().catch(()=> '');
 let {p,ctx}=await open('tanvir.r@credence.test',{viewport:{width:412,height:915},userAgent:UA.android,isMobile:true,hasTouch:true},'android');
 let body=await p.locator('body').innerText();
 ok(/attendance is given from the app only/i.test(body),'Android browser: card says use the app');
 ok(await p.getByRole('link',{name:/Get the app/}).count()>0,'Android browser: "Get the app (APK)" link');
 ok(!/Set Now/.test(await tile(p)),'Android browser: no "Set Now"');
 await ctx.close();
 ({p,ctx}=await open('tanvir.r@credence.test',{viewport:{width:1440,height:900}},'computer'));
 body=await p.locator('body').innerText();
 ok(/can't be given from a computer/i.test(body),'computer: card says not from a computer');
 ok(!/Set Now/.test(await tile(p)),'computer: no "Set Now"');
 await ctx.close();
 ({p,ctx}=await open('tanvir.r@credence.test',{...devices['iPhone 13']},'iphone'));
 body=await p.locator('body').innerText();
 ok(!/from the app only|from a computer/i.test(body),'iPhone: no block notice');
 ok(/Set Now/.test(await tile(p)),'iPhone: "Set Now" is there');
 await ctx.close();
 // iPad: Safari says Mac, touch screen
 ({p,ctx}=await open('tanvir.r@credence.test',{viewport:{width:1024,height:1366},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',hasTouch:true,touchPoints:5},'ipad'));
 ok(await p.evaluate(()=>navigator.maxTouchPoints)>1,'(iPad emulation has a touch screen)');
 body=await p.locator('body').innerText();
 ok(!/from the app only|from a computer/i.test(body),'iPad (Safari says Mac): no block notice');
 await ctx.close();
 // Session security
 ({p,ctx}=await open('admin@credence.test',{viewport:{width:1440,height:1000}},null,'/admin/active-users'));
 await p.waitForTimeout(1500);
 body=await p.locator('body').innerText();
 ok(/iPhone Home Screen sign-in lasts/.test(body) && /iPhone Home Screen signs out when not opened for/.test(body),'Session security shows the two Home Screen rows');
 const sec=p.getByText('iPhone Home Screen sign-in lasts').first(); await sec.scrollIntoViewIfNeeded().catch(()=>{}); await p.screenshot({path:`${D}/session-security.png`});
 await ctx.close();
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
