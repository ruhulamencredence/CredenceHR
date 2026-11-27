// Users -> Merge accounts popup: pairs found, ambiguous one not ticked, What moves,
// pick an employee by hand, "keep the employee login's" access + password, merge.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B='http://localhost:3200', D=process.argv[2];
const sql=(s)=>execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const ids=JSON.parse(execSync(`node ${__dirname}/merge-seed.cjs`).toString());
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123'})})).json();
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1500,height:950}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/users',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(7000);
 const btn=p.getByRole('button',{name:/Merge accounts/}).first();
 ok(await btn.isVisible(),'Users page: "Merge accounts" button');
 await btn.click(); await p.waitForTimeout(2500);
 const card=(name)=>p.locator('[data-merge-row]',{hasText:name}).first();
 ok(await card('Md. Karim Uddin').locator('input[type=checkbox]').isChecked(),'Karim (name match) found and ticked');
 ok(await card('rafiq · user').locator('input[type=checkbox]').isChecked(),'Rafiq (same email) found and ticked');
 ok(!(await card('sumon.old').locator('input[type=checkbox]').isChecked()) && await card('sumon.old').getByText(/more than one/).isVisible(),'Sumon (same name, two employees) not ticked, flagged');
 ok(await card('Stranger Person').getByText(/No match found/).isVisible(),'Stranger: no match, pick by hand');
 await card('Md. Karim Uddin').getByRole('button',{name:'What moves'}).click(); await p.waitForTimeout(1200);
 const pv=await card('Md. Karim Uddin').innerText();
 ok(/6 records move/.test(pv)&&/Attendance 3/.test(pv)&&/Leave applications 2/.test(pv),'What moves: attendance 3, leave 2 …');
 await p.screenshot({path:D+'/merge-popup.png'});
 // Sumon: choose MRG-904 by hand
 const sc=card('sumon.old').locator('input[role="combobox"]');
 await sc.click(); await sc.fill('MRG-904'); await p.waitForTimeout(400); await p.getByRole('option',{name:/MRG-904/}).first().click(); await p.waitForTimeout(300);
 ok(await card('sumon.old').locator('input[type=checkbox]').isChecked(),'picking the employee by hand ticks it');
 // keep the employee login's access and password
 await p.getByRole('button',{name:/Keep the employee login's/}).click();
 await p.getByRole('button',{name:/The employee login's password/}).click();
 await p.getByRole('button',{name:/Merge 3 selected/}).click(); await p.waitForTimeout(700);
 ok(await p.getByText(/can't be undone/i).last().isVisible(),'red confirm before merging');
 await p.getByRole('button',{name:/^Merge 3$/}).click(); await p.waitForTimeout(3500);
 ok(await p.getByText('3 merged.').isVisible(),'"3 merged." shown');
 await p.screenshot({path:D+'/merge-done.png'});
 ok(sql(`SELECT COUNT(*) FROM users WHERE id IN (${ids.karimOld},${ids.rafiqOld},${ids.sumonOld})`)==='0','old logins gone');
 ok(sql(`SELECT GROUP_CONCAT(module_key) FROM admin_module_permissions WHERE user_id=${ids.karimNew}`)==='tasks','access kept from the employee login (tasks)');
 ok(sql(`SELECT role FROM users WHERE id=${ids.karimNew}`)==='user','role kept from the employee login');
 const s1=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'MRG-901',password:'ImportPass123'})})).json();
 ok(!!s1.token,'signs in with the import password');
 ok(sql(`SELECT COUNT(*) FROM attendance WHERE user_id=${ids.karimNew}`)==='3','records still moved (attendance 3)');
 ok(sql(`SELECT u.username FROM all_employees e JOIN users u ON u.id=e.user_id WHERE e.employee_id='MRG-904'`)==='MRG-904' && sql(`SELECT email FROM users WHERE username='MRG-904'`)==='sumon.old@credence.test','Sumon merged into MRG-904 (email carried over)');
 await p.getByRole('button',{name:/History/}).click(); await p.waitForTimeout(1200);
 ok(await p.getByText(/Md. Karim Uddin/).first().isVisible(),'History lists the merges');
 console.log('errors:',errs.slice(0,2)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
