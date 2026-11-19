// Onboarding checklist first-day buttons: Turn on Mobile App, Give projects (Project Access popup) -> items tick themselves.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
(async()=>{const a=await (await fetch('http://localhost:3200/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123'})})).json();
const emp=execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "SELECT e.id FROM all_employees e JOIN onboarding_applications o ON o.employee_id=e.id WHERE o.name LIKE 'Letter Joiner %' ORDER BY o.id DESC LIMIT 1"`).toString().trim();
const user=execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "SELECT user_id FROM all_employees WHERE id=${emp}"`).toString().trim();
execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -e "DELETE FROM user_project_permissions WHERE user_id=${user}; UPDATE users SET can_use_app=0 WHERE id=${user}; UPDATE hr_onboarding_items SET status='pending',note=NULL,value_text=NULL WHERE employee_id=${emp} AND task_key IN ('pepm_projects','mobile_app')"`);
const name=execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "SELECT name FROM all_employees WHERE id=${emp}"`).toString().trim();
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:1100}});
await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('hr_ops_tab','onboarding');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));},[a.token,a.user]);
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto('http://localhost:3200/admin/hr-operations'); await p.waitForTimeout(6000);
await p.getByRole('button',{name:/^Onboarding$/}).first().click(); await p.waitForTimeout(1500);
const cl=p.getByRole('button',{name:/Checklist/}).first(); if(await cl.isVisible().catch(()=>false)){await cl.click(); await p.waitForTimeout(1500);}
await p.locator('div',{hasText:name}).filter({has:p.getByRole('button',{name:'Open Checklist'})}).last().getByRole('button',{name:'Open Checklist'}).click(); await p.waitForTimeout(2500);
const ok=(c,m)=>console.log((c?'PASS ':'FAIL ')+m);
ok(await p.getByRole('button',{name:'Give projects'}).isVisible(),'Give projects button');
ok(await p.getByRole('button',{name:'Turn on Mobile App'}).isVisible(),'Turn on Mobile App button');
await p.screenshot({path:'/tmp/claude-0/jl/checklist.png',fullPage:false});
await p.getByRole('button',{name:'Turn on Mobile App'}).click(); await p.waitForTimeout(2000);
ok(await p.getByText(/Mobile App turned on for/).isVisible(),'Mobile App turned on, message');
await p.getByRole('button',{name:'Give projects'}).click(); await p.waitForTimeout(1500);
const dlg=p.getByRole('dialog',{name:'Project Access'}); ok(await dlg.isVisible(),'Project Access popup from the checklist');
await dlg.getByText('QA Anamika').click(); await dlg.getByRole('button',{name:'Save Access'}).click(); await p.waitForTimeout(2500);
ok(await p.getByText(/Projects saved for/).isVisible(),'projects saved, message');
ok(!(await p.getByRole('button',{name:'Give projects'}).isVisible().catch(()=>false)),'item ticked (button gone)');
await p.screenshot({path:'/tmp/claude-0/jl/checklist-after.png'});
console.log('errors',errs); await b.close();})();
