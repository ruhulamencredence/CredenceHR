const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 for (const [who,url,shot,vp] of [['tanvir.r@credence.test','/self/employee-directory','dir-desktop',{width:1440,height:900}],['tanvir.r@credence.test','/self/employee-directory','dir-phone',{width:390,height:844}],['admin@credence.test','/admin/employees','emp-table',{width:1440,height:900}]]) {
  const a=await login(who); const ctx=await b.newContext({viewport:vp});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
  const p=await ctx.newPage(); await p.goto(B+url,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4000);
  for (const n of ['Later','Got it','Not now']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
  const s=p.locator('input[placeholder*="Search"]:visible').first(); if (await s.count()) { await s.fill('Farhana'); await p.waitForTimeout(1500); }
  let txt=await p.locator('body').innerText();
  ok(!txt.includes('01999') && !txt.includes('01999 000002'), shot+': personal number not on page');
  ok(/01711[\s-]?000001|017110 ?00001|01711 ?000001/.test(txt.replace(/\s+/g,' ')) || txt.includes('01711'), shot+': office number on page');
  await p.screenshot({path:`${D}/${shot}.png`});
  if (shot!=='emp-table') { await p.getByText('Farhana Akter').first().click().catch(()=>{}); await p.waitForTimeout(1200); txt=await p.locator('body').innerText(); ok(!txt.includes('01999'), shot+' detail card: no personal number'); await p.screenshot({path:`${D}/${shot}-card.png`}); }
  await ctx.close();
 }
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
