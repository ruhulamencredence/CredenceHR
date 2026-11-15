// Dashboard: My Asset "New requisition" and Book a Ride "Where are you going?"
// open popups on the Dashboard; the Vehicle page booking still works.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2], WHO=process.argv[3]||'tanvir.r@credence.test';
const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await login(WHO); const H={Authorization:'Bearer '+a.token};
 const count=async(u)=>{const r=await fetch(B+u,{headers:H});const j=await r.json();return Array.isArray(j)?j.length:(j.rows||j.items||[]).length;};
 const ctx=await b.newContext({viewport:{width:1440,height:900}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('credence_workspace',JSON.stringify({id:1,code:'credence',name:'Credence Group',short_name:'Credence'}));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 await p.screenshot({path:D+'/0-dashboard.png'});
 // ---- My Asset
 await p.getByRole('button',{name:/New requisition/i}).first().click(); await p.waitForTimeout(900);
 ok(new URL(p.url()).pathname==='/','New requisition stays on the Dashboard');
 ok(await p.locator('.liquid-glass-backdrop').count()>0,'asset requisition popup is open (liquid-glass)');
 await p.screenshot({path:D+'/1-asset-popup.png'});
 await p.locator('input[placeholder="e.g. Laptop, A4 Paper"]').fill('QA dp Keyboard');
 await p.locator('input[placeholder="Why this item is needed"]').fill('QA dp popup test');
 await p.getByRole('button',{name:'Submit Request'}).click(); await p.waitForTimeout(2500);
 ok(await p.locator('.liquid-glass-backdrop').count()===0,'popup closes after Submit');
 const mine=await (await fetch(B+'/api/assets/requisitions/my',{headers:H})).json();
 ok(Array.isArray(mine)&&mine.some(r=>JSON.stringify(r).includes('QA dp Keyboard')),'the requisition is saved');
 const openNow=mine.filter(x=>['pending','manager_approved','approved','dispatched'].includes(x.status)).length;
 const cardTxt=await p.locator('text=Open requests').first().locator('xpath=..').innerText();
 ok(cardTxt.includes(String(openNow)),`card's "Open requests" shows ${openNow} without a reload (${cardTxt.replace(/\n/g,' ')})`);
 ok(new URL(p.url()).pathname==='/','still on the Dashboard');
 // ---- Book a Ride
 const ridesBefore=(await (await fetch(B+'/api/vehicles/requisitions',{headers:H})).json()).length;
 await p.getByRole('button',{name:/Where are you going\?/}).first().click(); await p.waitForTimeout(1500);
 const dlg=p.getByRole('dialog',{name:'Book a Ride'});
 ok(await dlg.count()===1,'"Where are you going?" opens the Book a Ride popup');
 ok(new URL(p.url()).pathname==='/','Book a Ride stays on the Dashboard');
 ok(/Route/.test(await dlg.innerText())&&/Ride details/.test(await dlg.innerText()),'popup shows the 1 Route — 2 Ride details steps');
 await p.screenshot({path:D+'/2-ride-step1.png'});
 await dlg.locator('input[placeholder="Pickup location"], input[placeholder="Finding your location…"]').first().fill('Head Office, Gulshan');
 await dlg.locator('input[placeholder="Where are you going?"]').fill('QA dp Motijheel');
 await dlg.getByRole('button',{name:/^Continue/}).click(); await p.waitForTimeout(1200);
 ok(/Ride details/.test(await dlg.innerText())&&await dlg.locator('textarea').count()===1,'Continue goes to step 2 inside the popup');
 await dlg.locator('textarea').fill('QA dp client meeting');
 const d=new Date(Date.now()+86400000); const ds=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 await dlg.locator('input[type=date]').fill(ds); await dlg.locator('input[type=time]').fill('10:30');
 await p.screenshot({path:D+'/3-ride-step2.png'});
 await dlg.getByRole('button',{name:/Submit Request/}).click(); await p.waitForTimeout(2500);
 ok(await p.getByRole('dialog',{name:'Book a Ride'}).count()===0,'popup closes after the ride is submitted');
 const rides=await (await fetch(B+'/api/vehicles/requisitions',{headers:H})).json();
 ok(rides.length===ridesBefore+1&&rides.some(r=>r.destination==='QA dp Motijheel'),'the ride request is saved');
 ok(/QA dp Motijheel/.test(await p.locator('body').innerText()),'the card shows the new ride without a reload');
 await p.screenshot({path:D+'/4-after-ride.png'});
 // Esc and backdrop close it
 await p.getByRole('button',{name:/Where are you going\?/}).first().click(); await p.waitForTimeout(800);
 await p.keyboard.press('Escape'); await p.waitForTimeout(400);
 ok(await p.getByRole('dialog',{name:'Book a Ride'}).count()===0,'Esc closes the popup');
 // ---- the Vehicle page booking still works (same component)
 await p.getByRole('button',{name:'Ride Status'}).first().click(); await p.waitForTimeout(3000);
 ok(/QA dp Motijheel/.test(await p.locator('body').innerText()),'"Ride Status" still opens the Vehicle page with the ride');
 await p.getByRole('button',{name:/Book a Ride/}).last().click(); await p.waitForTimeout(1500);
 await p.screenshot({path:D+'/5a-vehicle-book.png'});
 await p.locator('input[placeholder="Pickup location"], input[placeholder="Finding your location…"]').first().fill('Head Office, Gulshan');
 await p.locator('input[placeholder="Where are you going?"]').last().fill('QA dp Uttara page');
 await p.getByRole('button',{name:/^Continue/}).click(); await p.waitForTimeout(1200);
 await p.locator('textarea').first().fill('QA dp page booking');
 await p.locator('form input[type=date]').fill(ds); await p.locator('form input[type=time]').fill('11:00');
 await p.getByRole('button',{name:/Submit Request/}).click(); await p.waitForTimeout(2500);
 const t=await p.locator('body').innerText();
 ok(/Ride request submitted successfully/.test(t),'Vehicle page: submit shows the success notice');
 ok(/QA dp Uttara page/.test(t),'Vehicle page: switches to Ride Status with the new ride');
 await p.screenshot({path:D+'/5-vehicle-page.png'});
 console.log('errors:',errs.slice(0,3)); console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
