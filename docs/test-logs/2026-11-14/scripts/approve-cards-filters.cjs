// Approve Application: separate cards (submitted date, waiting chip, Layer),
// filters (search, kind, waiting, submitted, from, sort), and "Before it
// reached you" (earlier Layers, remarks, changes) — computer and phone.
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const api=await (await fetch(B+'/api/my-approvals',{headers:{Authorization:'Bearer '+a.token}})).json(); const items=Array.isArray(api)?api:api.items;
 const nAsset=items.filter(i=>i.source_type==='asset_requisition').length, nRide=items.filter(i=>i.source_type==='vehicle_requisition').length;
 const b=await chromium.launch();
 for(const [label,opts,phone] of [['computer',{viewport:{width:1600,height:1000}},false],['phone',{...devices['Pixel 7']},true]]){
  const ctx=await b.newContext(opts);
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode','light');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(B+'/self/approve-applications',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const count=()=>p.locator('text=/^Submitted \\d/').count();
  const total=await count();
  ok(total===items.length,`${label}: every request has its "Submitted …" line (${total}/${items.length})`);
  ok(await p.locator('text=/^\\d+ days? ago$|^today$/').count()>=items.length,`${label}: each card shows how long it has waited`);
  // trail
  const tb=p.locator('text=Before it reached you').first();
  ok(await tb.count()===1||await p.locator('text=Before it reached you').count()>=1,`${label}: "Before it reached you" box on the 2-layer request`);
  const body=await p.locator('body').innerText();
  ok(/Layer 1 · System Admin/.test(body)&&/Needed for the new site office/.test(body),`${label}: earlier Layer's name and remark shown`);
  ok(/Changed · QA trail Monitor: Qty 3 → 2/.test(body),`${label}: what Layer 1 changed is shown`);
  ok(/Now waiting on you/.test(body),`${label}: ends with "Now waiting on you"`);
  if(!phone){
    const pos=await p.evaluate(()=>{const t=[...document.querySelectorAll('div')].find(d=>d.textContent.trim().startsWith('Before it reached you')&&d.children.length>1);const card=t?.closest('div.rounded-2xl');if(!t||!card)return null;const r=t.getBoundingClientRect(),c=card.getBoundingClientRect();return {right:r.right>c.left+c.width*0.5,left:r.left-c.left};});
    ok(pos&&pos.right&&pos.left>c(0),'computer: the box sits in the card\'s right-hand column');
  }
  await p.screenshot({path:`${D}/cards-${label}.png`,fullPage:false});
  // filters: kind chip
  await p.getByRole('button',{name:new RegExp('^Asset Requisition\\s*'+nAsset+'$')}).first().click(); await p.waitForTimeout(500);
  ok(await count()===nAsset,`${label}: "Asset Requisition" chip shows only those (${nAsset})`);
  await p.getByRole('button',{name:/^All\s*\d+$/}).first().click(); await p.waitForTimeout(300);
  // waiting chip
  const old=items.filter(i=>{const d=new Date(String(i.created_at).replace(' ','T'));const s=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();return Math.round((s(new Date())-s(d))/864e5)>=3;}).length;
  await p.getByRole('button',{name:/^3\+ days\s*\d+$/}).first().click(); await p.waitForTimeout(400);
  ok(await count()===old,`${label}: "3+ days" shows only the old ones (${old})`);
  await p.getByRole('button',{name:'Clear filters'}).first().click(); await p.waitForTimeout(300);
  ok(await count()===items.length,`${label}: Clear filters brings all back`);
  // search
  await p.getByLabel('Search requests').fill('QA trail'); await p.waitForTimeout(400);
  ok(await count()===1,`${label}: search narrows to the matching request`);
  await p.getByLabel('Search requests').fill('zzz-nothing'); await p.waitForTimeout(300);
  ok(/No request matches these filters/.test(await p.locator('body').innerText()),`${label}: no-match message`);
  await p.getByLabel('Search requests').fill(''); await p.waitForTimeout(300);
  // sort: oldest first by default
  const firstAge=await p.locator('text=/^\\d+ days? ago$|^today$/').first().innerText();
  ok(/days ago/.test(firstAge),`${label}: oldest first by default (first card: ${firstAge})`);
  if(phone){
    await p.getByRole('button',{name:/^Filters/}).click(); await p.waitForTimeout(600);
    ok(await p.getByRole('dialog',{name:'Filters'}).count()===1,'phone: Filters opens its popup');
    await p.getByRole('dialog',{name:'Filters'}).locator('select[aria-label="Sort"]').selectOption('newest'); await p.waitForTimeout(300);
    await p.screenshot({path:`${D}/cards-phone-filters.png`});
    await p.getByRole('button',{name:/^Show \d+/}).click(); await p.waitForTimeout(400);
    ok(/today/.test(await p.locator('text=/^\\d+ days? ago$|^today$/').first().innerText()),'phone: Sort newest first puts today\'s on top');
    ok(/Filters · 1/.test(await p.locator('body').innerText()),'phone: the Filters button counts the active one');
  } else {
    await p.locator('select[aria-label="Sort"]').selectOption('newest'); await p.waitForTimeout(300);
    ok(/today/.test(await p.locator('text=/^\\d+ days? ago$|^today$/').first().innerText()),'computer: Sort newest first puts today\'s on top');
  }
  const sw=await p.evaluate(()=>[document.documentElement.scrollWidth,window.innerWidth]); ok(sw[0]<=sw[1],`${label}: no sideways overflow`);
  console.log('   errors:',errs.slice(0,2)); ok(errs.length===0,`${label}: no page errors`);
  await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
 function c(n){return n;}
})();
