const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2], TAG=process.argv[3];
(async()=>{
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'tanvir.r@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const b=await chromium.launch(); const out={};
 for (const [name,vp] of [['desktop',{width:1440,height:900}]]) {
  const ctx=await b.newContext({viewport:vp});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
  const p=await ctx.newPage(); let photos=0; p.on('request',r=>{ if(r.url().includes('/api/profile/photo/')) photos++; });
  await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
  for (const n of ['Later','Got it','Not now']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
  if (name==='desktop') { await p.mouse.click(1388,846); } else { await p.mouse.click(350,790); }
  await p.waitForTimeout(3000);
  photos=0;
  if (name==='desktop') { await p.mouse.move(662,125); await p.waitForTimeout(300); await p.getByRole('button',{name:/^New Chat/}).first().click(); }
  else { const fab=p.locator('button[aria-label="New chat"]:visible'); await fab.first().click(); await p.getByRole('button',{name:/^New Chat/}).first().click(); }
  const t0=Date.now(); await p.getByText('Bulk Person').first().waitFor({timeout:30000}); const openMs=Date.now()-t0;
  await p.waitForTimeout(1500);
  const card=p.locator('.liquid-glass.rounded-\\[32px\\]').last();
  const h0=(await card.boundingBox()).height; const photosOpen=photos;
  const s=p.locator('input[placeholder^="Search name"]'); const hs=[];
  for (const q of ['Bulk Person 12','Bulk Person 1234','zzzz','Tahmid','']) { await s.fill(q); await p.waitForTimeout(500); hs.push(Math.round((await card.boundingBox()).height)); }
  out[name]={openMs,photosOpen,heightStart:Math.round(h0),heightsAfterSearch:hs,rows:await p.locator('.liquid-glass-inset button').count()};
  await p.screenshot({path:`${D}/${TAG}-${name}.png`}); await ctx.close();
 }
 console.log(TAG, JSON.stringify(out)); await b.close();
})();
