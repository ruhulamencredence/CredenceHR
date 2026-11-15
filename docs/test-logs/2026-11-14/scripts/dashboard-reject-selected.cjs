// Admin Dashboard: "Attendance corrections waiting for review" (and Pending
// Attendance Approval) popups — Reject selected next to Approve selected.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const H={Authorization:'Bearer '+a.token,'content-type':'application/json'};
 const api=async(m,u,b)=>{const r=await fetch(B+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)console.log('  ',m,u,r.status,JSON.stringify(j).slice(0,200));return j;};
 const projects=await api('GET','/api/projects'); const pid=(Array.isArray(projects)?projects:projects.projects||[])[0]?.id;
 const day=(n)=>{const d=new Date(Date.now()-n*86400000);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 const made=[];
 for(const n of [2,3,4]){ const r=await api('POST','/api/attendance/corrections',{project_id:pid,attendance_date:day(n),check_in_at:`${day(n)}T09:${10+n}`,remarks:'QA rs forgot'}); if(r.id||r.success) made.push(day(n)); }
 console.log('   corrections made:',made.length);
 const ex=await api('GET','/api/admin-dashboard/extras');
 const pend=(ex.attendance_corrections||[]).filter(c=>c.approve);
 ok(pend.length>=3,`dashboard has ${pend.length} correction(s) this account may decide`);
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/dashboard',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
 const tile=p.getByText(/Attendance Correction|Attendance Recon/i).first();
 await tile.click(); await p.waitForTimeout(1500);
 ok(/Attendance corrections waiting for review/.test(await p.locator('body').innerText()),'the corrections popup opens');
 ok(await p.getByRole('button',{name:/Reject selected/}).count()===1,'"Reject selected" is next to "Approve selected"');
 await p.screenshot({path:D+'/rs-popup.png'});
 // tick one, reject without a reason
 const boxes=p.locator('input[type=checkbox]'); 
 await boxes.nth(1).check(); await p.getByRole('button',{name:/Reject selected/}).click(); await p.waitForTimeout(500);
 ok(/Write the reason to reject/.test(await p.locator('body').innerText()),'Reject without a reason is refused');
 // tick two, reason, confirm
 await boxes.nth(2).check();
 await p.getByLabel('Reason for rejecting').fill('QA rs not a valid reason');
 await p.getByRole('button',{name:/Reject selected \(2\)/}).click(); await p.waitForTimeout(700);
 await p.screenshot({path:D+'/rs-confirm.png'});
 await p.locator('.liquid-glass').getByRole('button',{name:'Reject',exact:true}).last().click(); await p.waitForTimeout(3000);
 const t=await p.locator('body').innerText();
 ok(/2 rejected\./.test(t),'"2 rejected." shown');
 await p.screenshot({path:D+'/rs-after.png'});
 const ex2=await api('GET','/api/admin-dashboard/extras');
 ok((ex2.attendance_corrections||[]).length===(ex.attendance_corrections||[]).length-2,'the two rejected left the list');
 const mine=await api('GET','/api/attendance/corrections/mine').catch(()=>[]);
 const arr=Array.isArray(mine)?mine:(mine.rows||mine.items||[]);
 const rej=arr.filter(c=>c.status==='rejected'&&/QA rs not a valid reason/.test(JSON.stringify(c)));
 if(arr.length) ok(rej.length>=2,`employee side: ${rej.length} corrections rejected with the reason`); else console.log('   (no /mine list to check)');
 // approve still works
 await boxes.nth(1).check().catch(()=>{});
 if(await p.getByRole('button',{name:/Approve selected \(1\)/}).count()){ await p.getByRole('button',{name:/Approve selected \(1\)/}).click(); await p.waitForTimeout(600); await p.locator('.liquid-glass').getByRole('button',{name:'Approve',exact:true}).last().click(); await p.waitForTimeout(3000); ok(/1 approved\./.test(await p.locator('body').innerText()),'Approve selected still works'); }
 console.log('errors:',errs.slice(0,3)); console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
