// Light Glass: the sidebar's search results (full column and minimized) are readable.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const b=await chromium.launch();
 const lum=(c)=>{const m=c.match(/[\d.]+/g).map(Number);const f=(v)=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;};return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]);};
 const contrast=(x,y)=>{const [l1,l2]=[lum(x),lum(y)].sort((p,q)=>q-p);return (l1+0.05)/(l2+0.05);};
 for(const mode of ['lightglass','light','glass']){
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.addInitScript(([t,u,m])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('mpr_color_mode',m);localStorage.removeItem('gsidebar_collapsed');for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user,mode]);
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4500);
  const box=p.locator('aside.gsidebar').nth(1).locator('input[type=text]').first();
  await box.fill('sim'); await p.waitForTimeout(600);
  const r=await p.evaluate(()=>{const pop=[...document.querySelectorAll('aside.gsidebar .gsidebar-pop')].find(e=>e.offsetParent);if(!pop)return null;const btn=pop.querySelector('button');const lab=btn.querySelector('span span');
    // Any CSS colour (oklab, rgba…) -> rgb via a canvas pixel, alpha blended over the background.
    const px=(c,under)=>{const cv=document.createElement('canvas');cv.width=cv.height=1;const x=cv.getContext('2d');x.fillStyle=under||'#fff';x.fillRect(0,0,1,1);x.fillStyle=c;x.fillRect(0,0,1,1);const d=x.getImageData(0,0,1,1).data;return `rgb(${d[0]},${d[1]},${d[2]})`;};
    const bgRaw=getComputedStyle(pop).backgroundColor; const bg=px(bgRaw,'#fff');
    return {bgRaw,bg,fg:px(getComputedStyle(lab).color,bg),n:pop.querySelectorAll('button').length};});
  if(!r){ ok(false,`${mode}: results dropdown shows`); await ctx.close(); continue; }
  // background is semi-transparent white in lightglass: treat as over white
  const c=contrast(r.fg,r.bg);
  ok(r.n>0&&c>=4.5,`${mode}: results readable — text ${r.fg} on ${r.bg} (${r.bgRaw}), contrast ${c.toFixed(1)}:1`);
  await p.screenshot({path:`${D}/lg-search-${mode}.png`,clip:{x:0,y:60,width:420,height:360}});
  await ctx.close();
 }
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
