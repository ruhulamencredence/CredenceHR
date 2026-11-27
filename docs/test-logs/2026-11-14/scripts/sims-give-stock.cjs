// SIMs tab: every row has a visible action — "Give to employee" on a stock SIM,
// "Edit" on the rest; the stock view explains the 3 steps; the popup leads with the person.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123'})})).json();
 const H={Authorization:'Bearer '+a.token};
 const list=await (await fetch(B+'/api/mobile-bill/sims',{headers:H})).json();
 const spare=list.filter(x=>!x.employee_id&&x.status==='active'), held=list.filter(x=>x.employee_id);
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1600,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/mobile-bill',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
 await p.getByRole('button',{name:/^SIMs$/}).first().click(); await p.waitForTimeout(1500);
 ok(await p.getByRole('button',{name:/Give to employee/}).count()===spare.length,`all rows: ${spare.length} "Give to employee" buttons (stock)`);
 ok(await p.locator('tbody').getByRole('button',{name:/^Edit$/}).count()===list.filter(x=>x.status==='active').length-spare.length,`all rows: ${held.length} "Edit" buttons (held)`);
 await p.getByRole('button',{name:/Not given to anyone/}).first().click(); await p.waitForTimeout(500);
 ok(await p.getByText('These SIMs are in stock').isVisible(),'stock view: 3-step guide shown');
 await p.screenshot({path:D+'/sims-give-guide.png'});
 const target=spare[spare.length-1];
 await p.locator('tr',{hasText:target.phone_number}).getByRole('button',{name:/Give to employee/}).click(); await p.waitForTimeout(800);
 ok(await p.getByText(`Give SIM ${target.phone_number} to an employee`).isVisible(),'popup title: Give SIM … to an employee');
 const combo=p.locator('[role="dialog"] input[role="combobox"], input[role="combobox"]').last();
 await combo.click(); await combo.fill('QA'); await p.waitForTimeout(400);
 await p.getByRole('option').filter({hasText:/QA/}).first().click(); await p.waitForTimeout(400);
 await p.screenshot({path:D+'/sims-give-popup.png'});
 // test data has no type limit (the popup says so): use a custom amount
 await p.getByRole('button',{name:/Custom amount/}).click(); await p.locator('input[type="number"]').last().fill('300');
 const give=p.getByRole('button',{name:/^Give SIM$/}).last();
 ok(await give.isVisible(),'main button reads "Give SIM" once a person is picked');
 await give.click(); await p.waitForTimeout(1500);
 const after=await (await fetch(B+'/api/mobile-bill/sims',{headers:H})).json();
 const t2=after.find(x=>x.id===target.id);
 ok(!!t2.employee_id,`${target.phone_number} given (employee ${t2.employee_id})`);
 ok(await p.locator('tbody tr',{hasText:target.phone_number}).count()===0,'it left the stock list');
 // put it back in stock
 await fetch(B+'/api/mobile-bill/sims/'+target.id,{method:'PUT',headers:{...H,'content-type':'application/json'},body:JSON.stringify({phone_number:t2.phone_number,operator:t2.operator,employee_id:null,duty_location:target.duty_location,limit_source:target.limit_source,limit_amount:target.limit_amount,status:'active',issued_on:'',package_name:'',note:''})});
 console.log('errors:',errs.slice(0,2)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
