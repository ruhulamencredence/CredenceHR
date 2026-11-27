// SIM & Mobile Bill: the "Not given to anyone" card shows the stock SIMs, and a
// Department filter (type to search) on the SIMs and Monthly Bills tabs.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const list=await (await fetch(B+'/api/mobile-bill/sims',{headers:{Authorization:'Bearer '+a.token}})).json();
 const dept=(x)=>x.employee?.department||(x.employee_id?'':x.duty_location||'');
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1600,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/mobile-bill',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4500);
 await p.getByRole('button',{name:/^SIMs$/}).first().click(); await p.waitForTimeout(1500);
 const rows=()=>p.locator('tbody tr').count(); const foot=async()=>(await p.locator('tfoot').first().innerText()).replace(/\s+/g,' ');
 const active=list.filter(x=>x.status==='active'), spare=active.filter(x=>!x.employee_id);
 // 1. the stock card
 await p.getByRole('button',{name:/Not given to anyone/}).first().click(); await p.waitForTimeout(500);
 let f=await foot(); console.log('   stock:',f);
 ok(new RegExp(`^${spare.length} SIMs? of ${list.length}`).test(f)&&f.includes('0 people'),`"Not given to anyone" card -> ${spare.length} stock SIMs, 0 people`);
 ok(await p.getByRole('button',{name:/Not given to anyone/}).first().getAttribute('aria-pressed')==='true','stock card shows as selected');
 ok(await p.locator('select').filter({hasText:/stock/}).first().inputValue()==='unassigned','status select follows the card');
 await p.screenshot({path:D+'/sims-stock.png'});
 // 2. department filter: type "MIS"
 await p.getByRole('button',{name:/Active SIMs/}).first().click(); await p.waitForTimeout(400);
 const combo=p.locator('input[role="combobox"]').first();
 await combo.click(); await combo.fill('MIS'); await p.waitForTimeout(400);
 await p.getByRole('option',{name:/Management Information Systems/}).first().click(); await p.waitForTimeout(500);
 const mis=active.filter(x=>dept(x)==='Management Information Systems (MIS)');
 f=await foot(); console.log('   MIS:',f);
 ok(await rows()===mis.length&&new RegExp(`^${mis.length} SIMs? of`).test(f),`Department "MIS" -> ${mis.length} SIMs (held + spare by duty location)`);
 await p.screenshot({path:D+'/sims-dept.png'});
 // department + stock together
 await p.getByRole('button',{name:/Not given to anyone/}).first().click(); await p.waitForTimeout(400);
 ok(await rows()===mis.filter(x=>!x.employee_id).length,'Department + stock together');
 // 3. Monthly Bills tab has the filter too
 await p.getByRole('button',{name:/Monthly Bills/}).first().click(); await p.waitForTimeout(1500);
 ok(await p.getByText('Department',{exact:true}).count()>0&&await p.locator('input[role="combobox"]').count()>0,'Monthly Bills tab: Department filter');
 console.log('errors:',errs.slice(0,2)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
