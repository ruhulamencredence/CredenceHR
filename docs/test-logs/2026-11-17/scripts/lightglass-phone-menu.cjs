const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', out=process.argv[2];
(async()=>{
  const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123'})})).json();
  const b=await chromium.launch(); const ctx=await b.newContext({...devices['Pixel 7']});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode','lightglass');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
  const p=await ctx.newPage(); await p.goto(B+'/'); await p.waitForTimeout(9000);
  const btn=p.locator('button[aria-label*="enu" i]').first(); await btn.click().catch(e=>console.log('no menu btn')); await p.waitForTimeout(1200);
  await p.screenshot({path:out}); await b.close();
})();
