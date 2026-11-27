// Edit Department -> team -> "Add people by project": pick work station(s) and
// department, Select all, add; another department's person; new-joiner rule; save.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B='http://localhost:3200', D=process.argv[2];
const sql=(s)=>execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const ids=JSON.parse(execSync(`node ${__dirname}/teams-seed.cjs`).toString());
 sql(`INSERT INTO department_teams (department_id, name, supervisor_user_id) VALUES (${ids.inv}, 'Store team', 1)`);
 const team=sql(`SELECT id FROM department_teams WHERE department_id=${ids.inv}`);
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123'})})).json();
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1500,height:1000}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(B+'/admin/departments',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(7000);
 await p.locator('tr',{hasText:'Inventory QA'}).getByTitle('Edit').first().click(); await p.waitForTimeout(2500);
 await p.getByRole('button',{name:/Add people by project/}).first().click(); await p.waitForTimeout(400);
 const panel=p.locator('[aria-label^="Add people to"]').first();
 ok(await panel.getByRole('button',{name:/Gulshan Tower\s*3/}).isVisible(),'work stations with counts (Gulshan Tower 3)');
 await panel.getByRole('button',{name:/Gulshan Tower/}).click();
 await panel.getByRole('button',{name:/Banani Site/}).click(); await p.waitForTimeout(300);
 ok(await panel.getByText('5 not in this team yet').isVisible(),'Gulshan + Banani (Inventory) -> 5 people');
 await panel.getByRole('button',{name:'Select all'}).click();
 await panel.getByRole('button',{name:'Add 5 to team'}).click(); await p.waitForTimeout(400);
 ok(await p.getByText(/Gulshan Tower\s*·\s*3/).first().isVisible() && await p.getByText(/Banani Site\s*·\s*2/).first().isVisible(),'members grouped by work station (3 + 2)');
 ok(await p.getByText(/New joiners · Gulshan Tower · Inventory QA/).isVisible(),'new-joiner rule chip shown');
 // another department's person
 await panel.getByLabel('Department').selectOption('*'); await p.waitForTimeout(300);
 const faruk=panel.locator('label',{hasText:'Faruk Hossain'});
 ok(await faruk.getByText(/now in Accounts QA team/).isVisible(),'Faruk (Accounts) shows "now in Accounts QA team"');
 await faruk.locator('input').check(); await p.waitForTimeout(200);
 ok(await panel.getByText(/from another department/).isVisible() && await panel.getByText(/in another team now/).isVisible(),'warnings: other department, moves from another team');
 await panel.getByText(/Also add/).click(); // no rule this time
 await panel.getByRole('button',{name:'Add 1 to team'}).click(); await p.waitForTimeout(300);
 ok(await p.getByText(/· Accounts QA/).first().isVisible(),"Faruk's chip names his department");
 await p.screenshot({path:D+'/teams-add-people.png'});
 // take one out by hand, then save
 await p.getByRole('button',{name:/Take Nasir Uddin out of/}).click();
 await p.getByRole('button',{name:/Save Changes|Update/}).last().click(); await p.waitForTimeout(2500);
 const mem=sql(`SELECT GROUP_CONCAT(e.employee_id ORDER BY e.employee_id) FROM department_team_members m JOIN all_employees e ON e.id=m.employee_id WHERE m.team_id=${team}`);
 ok(mem==='INV-01,INV-02,INV-04,INV-05,INV-07',`saved members: ${mem}`);
 ok(sql(`SELECT GROUP_CONCAT(CONCAT(branch,'/',department_id) ORDER BY branch) FROM department_team_auto WHERE team_id=${team}`)===`Banani Site/${ids.inv},Gulshan Tower/${ids.inv}`,'rules saved: Banani Site + Gulshan Tower, Inventory QA');
 ok(sql(`SELECT COUNT(*) FROM department_team_members WHERE team_id=${ids.accTeam}`)==='0','Faruk left the Accounts team');
 console.log('errors:',errs.slice(0,2)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
