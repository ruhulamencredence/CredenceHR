// Bill claim attachment opens in the app's own popup (AttachmentViewer), not a
// new tab — on the approver's card and in the claimant's claim details,
// computer and phone. window.open is watched: it must not be used.
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const fs=require('fs');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const H={Authorization:'Bearer '+a.token,'content-type':'application/json'};
 const today=new Date(Date.now()+6*3600e3).toISOString().slice(0,10);
 const png=fs.readFileSync('public/icons/app-192.png').toString('base64');
 // Filed by an employee (the Superadmin approves; a person never sees their own claim in Approve Application).
 const emp=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'qa.claimant@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const EH={Authorization:'Bearer '+emp.token,'content-type':'application/json'};
 let r=await fetch(B+'/api/bill-claims',{method:'POST',headers:EH,body:JSON.stringify({from_date:today,to_date:today,items:[{category:'Transport',bill_date:today,amount:70,description:'QA viewer rickshaw'}],description:'QA viewer',file_base64:png,file_name:'IMG-QA-receipt.png',file_mimetype:'image/png'})});
 const created=await r.json().catch(()=>null); console.log('   claim:',r.status,created?.id||created?.error);
 const b=await chromium.launch();
 for(const [label,opts] of [['computer',{viewport:{width:1440,height:950}}],['phone',{...devices['Pixel 7']}]]){
  const ctx=await b.newContext(opts);
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode','light');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));window.__opened=0;window.open=()=>{window.__opened++;return null;};},[a.token,a.user]);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(B+'/self/approve-applications',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  await p.getByLabel('Search requests').fill('QA viewer'); await p.waitForTimeout(800);
  const chip=p.getByRole('button',{name:/IMG-QA-receipt\.png/}).first();
  ok(await chip.count()===1,`${label}: the bill claim card shows the attachment`);
  await chip.click(); await p.waitForTimeout(2500);
  const dlg=p.getByRole('dialog',{name:'IMG-QA-receipt.png'});
  ok(await dlg.count()===1,`${label}: tapping it opens the in-app viewer popup`);
  const img=dlg.locator('img[alt="IMG-QA-receipt.png"]');
  ok(await img.count()===1&&await img.evaluate(i=>i.complete&&i.naturalWidth>0),`${label}: the picture is shown in the popup`);
  ok(await p.evaluate(()=>window.__opened)===0,`${label}: no new tab / window.open`);
  ok(await dlg.getByRole('button',{name:/Download/}).count()===1,`${label}: Download is offered`);
  await p.screenshot({path:`${D}/viewer-${label}.png`});
  await dlg.getByRole('button',{name:'Close'}).click(); await p.waitForTimeout(400);
  ok(await p.getByRole('dialog',{name:'IMG-QA-receipt.png'}).count()===0,`${label}: Close shuts it`);
  await chip.click(); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  ok(await p.getByRole('dialog',{name:'IMG-QA-receipt.png'}).count()===0,`${label}: Esc shuts it`);
  console.log('   errors:',errs.slice(0,2)); ok(errs.length===0,`${label}: no page errors`);
  await ctx.close();
 }
 // The claimant's own Bill Claim details (computer: sidebar -> Bill Claim -> the claim)
 {
  const ctx=await b.newContext({viewport:{width:1440,height:950}});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));window.__opened=0;window.open=()=>{window.__opened++;return null;};},[emp.token,emp.user]);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
  const side=p.locator('aside.gsidebar').nth(1);
  await side.locator('input[type=text]').first().fill('Bill Claim'); await p.waitForTimeout(600);
  await side.locator('.gsidebar-pop button').first().click(); await p.waitForTimeout(3500);
  await p.screenshot({path:`${D}/claimant-page.png`});
  const row=p.locator('tr',{hasText:'Transport'}).first();
  ok(await row.count()>0,'claimant: the claim is listed on their Bill Claim page');
  if(await row.count()){ await row.click(); await p.waitForTimeout(1500);
    const v=p.getByRole('button',{name:/View IMG-QA-receipt\.png/}).first();
    ok(await v.count()===1,'claimant: claim details show the attachment');
    if(await v.count()){ await v.click(); await p.waitForTimeout(2000);
      ok(await p.getByRole('dialog',{name:'IMG-QA-receipt.png'}).count()===1,'claimant: tapping the picture opens the in-app viewer');
      ok(await p.evaluate(()=>window.__opened)===0,'claimant: no new tab');
      await p.screenshot({path:`${D}/viewer-claimant.png`}); }
  }
  console.log('   errors:',errs.slice(0,2)); ok(errs.length===0,'claimant: no page errors');
  await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
