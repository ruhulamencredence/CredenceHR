// Spare SIMs: entered with nobody (kept in stock, no limit needed yet), then
// given to an employee later from the same form; SIM Inventory follows.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const H={Authorization:'Bearer '+a.token,'content-type':'application/json'};
 const go=async(m,u,b)=>{const r=await fetch(B+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>null)};};
 const tag=String(Date.now()).slice(-6);
 const nums=[0,1,2].map(i=>`0171${tag}${i}`.slice(0,11));
 const pol=await go('GET','/api/mobile-bill/policies'); console.log('   limits set:',JSON.stringify(pol.j).slice(0,120));
 // 1. API: two spare SIMs with the "employee type's limit" choice — no default limit needed
 for(const n of nums.slice(0,2)){ const r=await go('POST','/api/mobile-bill/sims',{phone_number:n,limit_source:'type'}); ok(r.s===201&&r.j.employee_id===null,`spare SIM ${n} saved with nobody (${r.s}${r.j?.error?': '+r.j.error:''})`); }
 const inv=await go('GET','/api/mobile-bill/inventory'); const invList=Array.isArray(inv.j)?inv.j:(inv.j?.sims||[]);
 ok(nums.slice(0,2).every(n=>{const s=invList.find(x=>x.phone_number===n);return s&&!s.holder;}),'SIM Inventory lists them in stock (no holder)');
 // 2. UI: add a third spare from the form, then give the first one to an employee
 const meta=await go('GET','/api/mobile-bill/meta'); const emps=(meta.j?.employees||[]).filter(e=>e.is_active!==false);
 console.log('   employees to pick from:',emps.length);
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/mobile-bill',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 await p.getByRole('button',{name:/^SIMs$/}).first().click(); await p.waitForTimeout(1500);
 await p.getByRole('button',{name:/Give a SIM/}).click(); await p.waitForTimeout(800);
 ok(/Nobody: the SIM is kept in stock/.test(await p.locator('body').innerText()),'form explains a SIM given to nobody stays in stock');
 await p.locator('input[placeholder*="01"]').first().fill(nums[2]);
 await p.screenshot({path:D+'/spare-form.png'});
 await p.getByRole('button',{name:/^Save|^Add|^Give/}).last().click(); await p.waitForTimeout(2000);
 const all=await go('GET','/api/mobile-bill/sims'); const sims=Array.isArray(all.j)?all.j:(all.j?.sims||[]);
 const third=sims.find(s=>s.phone_number===nums[2]);
 ok(third&&third.employee_id===null,'form: a spare SIM is saved with nobody');
 if(emps.length){
   const e=emps[0]; const first=sims.find(s=>s.phone_number===nums[0]);
   const r=await go('PUT',`/api/mobile-bill/sims/${first.id}`,{...first,employee_id:e.id,limit_source:'custom',limit_amount:500});
   ok(r.s===200&&Number(r.j.employee_id)===Number(e.id),`later: the spare SIM is given to ${e.name} (${r.s}${r.j?.error?': '+r.j.error:''})`);
   const inv2=await go('GET','/api/mobile-bill/inventory'); const l2=Array.isArray(inv2.j)?inv2.j:(inv2.j?.sims||[]);
   const s2=l2.find(x=>x.phone_number===nums[0]);
   ok(s2&&s2.holder&&Number(s2.holder.id)===Number(e.id),'SIM Inventory now shows it with that employee');
   const det=await go('GET',`/api/mobile-bill/inventory/${first.id}`);
   ok(/holder|holders/.test(JSON.stringify(det.j))&&JSON.stringify(det.j).includes(e.name),'its story lists the new holder');
 } else console.log('   (no employees in this DB to give it to)');
 await p.getByRole('button',{name:/SIM Inventory/}).first().click(); await p.waitForTimeout(2000);
 await p.screenshot({path:D+'/spare-inventory.png'});
 console.log('errors:',errs.slice(0,3)); console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
