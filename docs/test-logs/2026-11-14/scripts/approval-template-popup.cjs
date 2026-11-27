// Approval Chain -> Templates -> New Template: the editor opens over the whole
// screen (not clipped inside the card), and Manage Chain likewise.
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
  await p.goto(B+'/admin/approvals',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4500);
  await p.getByRole('button',{name:/^Templates$/}).first().click(); await p.waitForTimeout(1500);
  await p.getByRole('button',{name:/New Template/}).first().click(); await p.waitForTimeout(1000);
  const r=await p.evaluate(()=>{const h=[...document.querySelectorAll('h3')].find(x=>/New Template/.test(x.textContent));const card=h?.closest('.liquid-glass');const bd=card?.closest('.liquid-glass-backdrop');if(!card||!bd)return null;const c=card.getBoundingClientRect(),k=bd.getBoundingClientRect();return {parentIsBody:bd.parentElement===document.body,bd:[k.width,k.height],card:[c.top,c.height]};});
  ok(r&&r.parentIsBody,`${mode}: editor is rendered at page level (not inside the card)`);
  ok(r&&r.bd[0]>=1590&&r.bd[1]>=940,`${mode}: backdrop covers the whole window (${r&&r.bd.join('×')})`);
  ok(r&&r.card[0]>=0&&r.card[1]>400,`${mode}: the editor is fully visible (top ${r&&Math.round(r.card[0])}, height ${r&&Math.round(r.card[1])})`);
  await p.screenshot({path:`${D}/tpl-${mode}.png`});
  // Queue tab -> Manage Chain
  await p.keyboard.press('Escape'); await p.getByRole('button',{name:/Cancel/}).first().click().catch(()=>{}); await p.waitForTimeout(400);
  await p.getByRole('button',{name:/Queue \(Global Chain\)/}).first().click(); await p.waitForTimeout(1500);
  await p.getByRole('button',{name:/Manage Chain/}).first().click(); await p.waitForTimeout(1000);
  const m=await p.evaluate(()=>{const h=[...document.querySelectorAll('h3')].find(x=>/Manage Approval Chain/.test(x.textContent));const card=h?.closest('.liquid-glass');const bd=card?.closest('.liquid-glass-backdrop');if(!card||!bd)return null;const c=card.getBoundingClientRect(),k=bd.getBoundingClientRect();return {parentIsBody:bd.parentElement===document.body,bd:[k.width,k.height],card:[c.top,c.bottom,c.height],bg:getComputedStyle(card).backgroundColor};});
  ok(m&&m.parentIsBody&&m.bd[0]>=1590&&m.bd[1]>=940,`${mode}: Manage Chain at page level, covering the window`);
  ok(m&&m.card[0]>=0&&m.card[1]<=950,`${mode}: Manage Chain fully on screen (top ${m&&Math.round(m.card[0])}, bottom ${m&&Math.round(m.card[1])})`);
  await p.screenshot({path:`${D}/chain-${mode}.png`});
  console.log('   errors:',errs.slice(0,2)); await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
