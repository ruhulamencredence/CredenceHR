const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B='http://localhost:3200', D=process.argv[2], T=process.argv[3];
const sql=(q)=>execSync(`mysql -N -ucred -pcredpass admin_ui -e "${q.replace(/"/g,'\\"')}"`).toString().trim();
const punches=(...hms)=>{sql(`DELETE FROM zk_attendance_logs WHERE device_user_pin='102' AND DATE(punch_time)='${T}'`); for (const h of hms) sql(`INSERT INTO zk_attendance_logs (device_id, device_user_pin, raw_pin, punch_time) VALUES (7,'102','102','${T} ${h}')`);};
const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const mk=async(who,vp)=>{const a=await login(who);const ctx=await b.newContext({viewport:vp,timezoneId:'Asia/Dhaka'});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);return ctx;};
 const outTile=async(p)=>p.locator('div:has(> div:text-is("Out Time"))').first().innerText();
 sql(`DELETE FROM attendance WHERE user_id=132 AND attendance_date='${T}'`);
 // 1. double punch -> Out Time offers "Set Now"
 punches('09:00:00','09:01:30');
 let ctx=await mk('tanvir.r@credence.test',{width:390,height:844}); let p=await ctx.newPage();
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 let t=await outTile(p); ok(/Set Now/.test(t),'phone card: after a double punch, Out Time offers "Set Now" ('+t.replace(/\n/g,' ')+')');
 await p.screenshot({path:D+'/card-double.png'}); await ctx.close();
 // 2. real machine Out + permission -> "Set again" with the machine wording
 punches('09:00:00','13:00:00'); sql('UPDATE users SET can_update_check_out=1 WHERE id=132');
 ctx=await mk('tanvir.r@credence.test',{width:390,height:844}); p=await ctx.newPage();
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 t=await outTile(p); ok(/1:00/.test(t) && /Set again/.test(t),'machine Out 1:00 PM shows "Set again" ('+t.replace(/\n/g,' ')+')');
 await p.getByRole('button',{name:/Set again/}).click(); await p.waitForTimeout(800);
 const body=await p.locator('body').innerText(); ok(/office machine took/i.test(body) && /stays on record/i.test(body),'confirm says the machine punch stays on record');
 await p.screenshot({path:D+'/card-set-again.png'}); await ctx.close();
 sql('UPDATE users SET can_update_check_out=0 WHERE id=132');
 // 3. Office Attendance: button + popup
 ctx=await mk('admin@credence.test',{width:1440,height:900}); p=await ctx.newPage();
 await p.goto(B+'/admin/office-attendance',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 const btn=p.getByRole('button',{name:/Double punch: 5 min/}); ok(await btn.count()===1,'Office Attendance shows "Double punch: 5 min"');
 await btn.click(); await p.waitForTimeout(800);
 ok(await p.locator('#punch-rule-minutes').count()===1,'Superadmin sees the minutes box');
 await p.screenshot({path:D+'/office-modal.png'});
 await ctx.close();
 // phone overflow on office attendance
 ctx=await mk('admin@credence.test',{width:390,height:844}); p=await ctx.newPage();
 await p.goto(B+'/admin/office-attendance',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 ok(!(await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)),'phone: Office Attendance page does not scroll sideways');
 await ctx.close();
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
