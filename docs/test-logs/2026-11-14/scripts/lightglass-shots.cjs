const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2], WHICH=process.argv[3];
(async()=>{
 const b=await chromium.launch();
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const shot=async(opts,url,name,act)=>{
  const ctx=await b.newContext({...opts,timezoneId:'Asia/Dhaka'});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode','lightglass');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));localStorage.setItem('credence_a2hs_dismissed','1');},[a.token,a.user]);
  const p=await ctx.newPage(); await p.goto(B+url,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  for (const n of ['Later','Got it','Not now']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
  if (act) { try { await act(p); } catch(e) { console.log(name,'action:',e.message.slice(0,90)); } }
  await p.waitForTimeout(900); await p.screenshot({path:`${D}/v-${name}.png`}); await ctx.close(); console.log('shot',name);
 };
 const desk={viewport:{width:1440,height:900},deviceScaleFactor:1}; const phone={...devices['iPhone 13']};
 if (WHICH==='4') {
  await shot(desk,'/','appearance', async p=>{ await p.locator('button[aria-label*="rofile" i], a[href*="profile"]').first().click().catch(()=>{}); await p.waitForTimeout(2500); await p.getByText('Appearance',{exact:true}).first().click(); await p.waitForTimeout(1500); });
  await shot({...devices['iPhone 13']},'/','phone-appearance', async p=>{ await p.locator('button[aria-label*="rofile" i], a[href*="profile"]').first().click().catch(()=>{}); await p.waitForTimeout(2500); const r=p.getByRole('radio',{name:'Light Glass'}).first(); await r.scrollIntoViewIfNeeded(); });
 } else if (WHICH==='3') {
  await shot(desk,'/','chat2', async p=>{ await p.mouse.click(1388,846); await p.waitForTimeout(2500); });
  await shot(desk,'/','profile2', async p=>{ await p.locator('button[aria-label*="rofile" i], a[href*="profile"]').first().click().catch(()=>{}); await p.waitForTimeout(2500); const r=p.getByRole('radio',{name:'Light Glass'}).first(); await r.scrollIntoViewIfNeeded(); });
 } else if (WHICH==='1') {
  await shot(desk,'/','dashboard');
  await shot(desk,'/self/profile','profile', async p=>{ await p.getByRole('radio',{name:'Light Glass'}).first().scrollIntoViewIfNeeded(); });
  await shot(desk,'/admin/employees','employees');
  await shot(desk,'/admin/attendance-reports','attreport');
 } else {
  await shot(desk,'/','chat', async p=>{ await p.locator('button[aria-label="Open chat"]').first().click(); });
  await shot(desk,'/admin/tracking','tracking');
  await shot(phone,'/','phone-home');
  await shot(phone,'/','phone-more', async p=>{ await p.getByRole('button',{name:/^More$/}).first().click(); });
  await shot(phone,'/admin/employees','phone-employees');
 }
 await b.close();
})();
