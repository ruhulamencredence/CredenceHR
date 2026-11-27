// SIMs tab: a summary row under the table for the rows shown (after search /
// filters): SIMs (of total), people, not given, operators, total limit, last bills.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const sims=await (await fetch(B+'/api/mobile-bill/sims',{headers:{Authorization:'Bearer '+a.token}})).json();
 const list=Array.isArray(sims)?sims:sims.sims;
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1600,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/mobile-bill',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4500);
 await p.getByRole('button',{name:/^SIMs$/}).first().click(); await p.waitForTimeout(1500);
 const foot=()=>p.locator('tfoot').first().innerText();
 const tk=(n)=>n.toLocaleString('en-BD');
 const all=list.length, limAll=list.reduce((s,x)=>s+Number(x.limit_amount||0),0), notGiven=list.filter(x=>!x.employee_id).length;
 let f=await foot(); console.log('   all:',f.replace(/\s+/g,' '));
 ok(new RegExp(`^${all} SIMs?`).test(f.trim())&&f.includes(`${notGiven} not given`)&&f.includes(tk(limAll)),`all rows: ${all} SIMs, ${notGiven} not given, limit ${tk(limAll)}`);
 // filter: not given to anyone
 await p.locator('select').filter({hasText:/Not given to anyone/}).first().selectOption('unassigned'); await p.waitForTimeout(500);
 const spare=list.filter(x=>!x.employee_id&&x.status==='active');
 f=await foot(); console.log('   spare:',f.replace(/\s+/g,' '));
 ok(new RegExp(`^${spare.length} SIMs? of ${all}`).test(f.trim())&&f.includes('0 people'),`filter "Not given": ${spare.length} of ${all}, 0 people`);
 ok(f.includes(tk(spare.reduce((s,x)=>s+Number(x.limit_amount||0),0))),'filter: total limit of those rows only');
 await p.screenshot({path:D+'/sims-summary.png'});
 console.log('errors:',errs.slice(0,2)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
