const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const fs=require('fs'); const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const ctx=await b.newContext({viewport:{width:1440,height:900}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('credence_workspace',JSON.stringify({id:1,code:'credence',name:'Credence Group',short_name:'Credence'}));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,200))}); p.on('pageerror',e=>console.log('PAGEERR',e.message.slice(0,300))); await p.goto(B+'/admin/hr-operations',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4000);
 for (const n of ['Later','Got it','Not now']) { const l=p.getByRole('button',{name:n,exact:true}); if (await l.first().isVisible().catch(()=>false)) await l.first().click().catch(()=>{}); }
 await p.getByText('Onboarding',{exact:true}).first().click(); await p.waitForTimeout(2000);
 await p.getByRole('button',{name:'New joiner'}).last().click();  await p.locator('input[type="date"]').first().waitFor({timeout:15000}); await p.waitForTimeout(500);
 await p.locator('label:has-text("Name") + input, label:has-text("Name") ~ input').first().fill('UI Mail Joiner');
 await p.screenshot({path:D+'/step.png'}); const d=p.locator('input[type="date"]').first(); await d.fill('2026-12-05');
 const em=p.locator('input[type="email"]:visible').first(); if (await em.count()) await em.fill('ui.joiner@example.com');
 await p.getByRole('button',{name:'Create login'}).click(); await p.waitForTimeout(2500);
 await p.screenshot({path:D+'/popup.png'});
 const txt=await p.locator('body').innerText();
 ok(/Login link/.test(txt)&&/\?workspace=credence&login=ONB-/.test(txt),'popup shows the login link');
 ok(/Email it to the joiner/.test(txt),'popup has the email section');
 const val=await p.locator('#joiner-login-email').inputValue().catch(()=> ''); ok(val==='ui.joiner@example.com','email box is pre-filled with the joiner\'s email ('+val+')');
 fs.existsSync(D+'/mails.txt')&&fs.unlinkSync(D+'/mails.txt');
 await p.getByRole('button',{name:'Send email'}).click(); await p.waitForTimeout(2000);
 const t2=await p.locator('body').innerText(); ok(/Sent to ui\.joiner@example\.com/.test(t2),'UI says it was sent');
 await p.screenshot({path:D+'/popup-sent.png'});
 const pw=(await p.locator('.select-all').nth(2).innerText().catch(()=>'')).trim(); const link=(await p.locator('.select-all').first().innerText()).trim();
 await ctx.close();
 // the joiner opens the link in a fresh browser
 const c2=await b.newContext({viewport:{width:1440,height:900}}); const q=await c2.newPage(); await q.goto(link,{waitUntil:'domcontentloaded'}); await q.waitForTimeout(3500);
 await q.screenshot({path:D+'/joiner-login.png'});
 const idv=await q.locator('input[type="text"],input[type="email"]').first().inputValue().catch(()=> '');
 ok(/^ONB-\d+/.test(idv),'link opens the login page with the Login ID filled in ('+idv+')');
 const t3=await q.locator('body').innerText(); ok(!/Which workspace|Enter your workspace/i.test(t3),'workspace page skipped');
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
