// Departments: the table scrolls in its own box with the header staying on
// top; the Add form stays; search and filters narrow the list.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const b=await chromium.launch();
 for(const mode of ['light','lightglass','glass']){
  const ctx=await b.newContext({viewport:{width:1600,height:950}});
  await ctx.addInitScript(([t,u,m])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode',m);for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user,mode]);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(B+'/admin/departments',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
  const info=await p.evaluate(()=>{const t=[...document.querySelectorAll('table')].find(x=>x.textContent.includes('Teams · Supervisor'));const box=t?.parentElement;return box?{sh:box.scrollHeight,ch:box.clientHeight,ov:getComputedStyle(box).overflowY}:null;});
  ok(info&&info.sh>info.ch&&info.ov==='auto',`${mode}: the table scrolls in its own box (${info&&info.ch}px of ${info&&info.sh}px)`);
  const formTop0=await p.evaluate(()=>[...document.querySelectorAll('h3,h2')].find(x=>/Add Department/.test(x.textContent))?.getBoundingClientRect().top);
  await p.evaluate(()=>{const t=[...document.querySelectorAll('table')].find(x=>x.textContent.includes('Teams · Supervisor'));t.parentElement.scrollTop=600;});
  await p.waitForTimeout(400);
  const st=await p.evaluate(()=>{const t=[...document.querySelectorAll('table')].find(x=>x.textContent.includes('Teams · Supervisor'));const box=t.parentElement.getBoundingClientRect();const th=t.querySelector('thead').getBoundingClientRect();const el=document.elementFromPoint(th.left+40,th.top+th.height/2);return {thTop:Math.round(th.top),boxTop:Math.round(box.top),hit:el?.closest('thead')?true:false};});
  ok(Math.abs(st.thTop-st.boxTop)<=2&&st.hit,`${mode}: header stays at the top of the box while scrolling, drawn over the rows`);
  const formTop1=await p.evaluate(()=>[...document.querySelectorAll('h3,h2')].find(x=>/Add Department/.test(x.textContent))?.getBoundingClientRect().top);
  ok(formTop0===formTop1,`${mode}: the page itself didn't scroll (Add form stays)`);
  await p.screenshot({path:`${D}/dept-${mode}.png`});
  if(mode==='light'){
   const rows=()=>p.evaluate(()=>[...document.querySelectorAll('table')].find(x=>x.textContent.includes('Teams · Supervisor'))?.querySelectorAll('tbody tr').length||0);
   await p.getByLabel('Search departments').fill('QA Dept 1'); await p.waitForTimeout(400);
   ok(await rows()===10,`search narrows (QA Dept 1x → ${await rows()})`);
   await p.getByLabel('Search departments').fill(''); await p.locator('select[aria-label="Status"]').selectOption('inactive'); await p.waitForTimeout(300);
   ok(await rows()===4,`Inactive filter (${await rows()})`);
   await p.locator('select[aria-label="Status"]').selectOption('all'); await p.locator('select[aria-label="Setup"]').selectOption('no_head'); await p.waitForTimeout(300);
   ok(await rows()>=30,`"No Head" filter (${await rows()})`);
   ok(/of \d+ Department/.test(await p.locator('body').innerText()),'count shows "N of M"');
   await p.getByRole('button',{name:'Clear'}).click(); await p.waitForTimeout(300);
   ok(await rows()===33,'Clear brings all back');
  }
  console.log('   errors:',errs.slice(0,2)); ok(errs.length===0,`${mode}: no page errors`);
  await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
