const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 // a feedback with a screenshot (red square)
 const png='iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACYElEQVR4nO3TQQkAMAzAwMqpfz0TMw/7jMDBCcgnc3aBqPleADwzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIewCHL8JLHFaAn0AAAAASUVORK5CYII=';
 await fetch(B+'/api/feedback',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+a.token},body:JSON.stringify({kind:'bug',message:'QA fb lightbox check',screenshot_base64:png,screenshot_mimetype:'image/png'})});
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 for (const mode of ['glass','dark','light']) {
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.addInitScript(([t,u,m])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode',m);for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user,mode]);
  const p=await ctx.newPage(); await p.goto(B+'/admin/user-feedback',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
  await p.getByRole('button',{name:'Open screenshot'}).first().click(); await p.waitForTimeout(800);
  const r=await p.evaluate(()=>{const imgs=[...document.querySelectorAll('img[alt="Screenshot"]')]; const big=imgs.find(i=>i.className.includes('max-h-[75vh]')); if(!big) return {found:false};
    const overlay=big.closest('.fixed'); const rc=big.getBoundingClientRect(); const top=document.elementFromPoint(rc.x+rc.width/2, rc.y+rc.height/2);
    return {found:true, onBody: overlay && overlay.parentElement===document.body, onTop: top===big, w:Math.round(rc.width)};});
  ok(r.found && r.onBody,`${mode}: the big screenshot opens on top of the page (attached to the page body)`);
  ok(r.onTop,`${mode}: nothing covers it (the picture is what you see in its middle)`);
  await p.screenshot({path:`${D}/lightbox-${mode}.png`});
  await p.mouse.click(20,450); await p.waitForTimeout(400);
  ok(await p.locator('img.max-h-\\[75vh\\]').count()===0,`${mode}: clicking outside closes it`);
  await ctx.close();
 }
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
