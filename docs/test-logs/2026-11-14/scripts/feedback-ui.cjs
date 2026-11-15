const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const mk=async(who,vp)=>{const a=await login(who);const ctx=await b.newContext({viewport:vp});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('credence_workspace',JSON.stringify({id:1,code:'credence',name:'Credence Group',short_name:'Credence'}));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);return ctx;};
 // ---- 1. employee: paste an image into the feedback popup
 let ctx=await mk('tanvir.r@credence.test',{width:1440,height:900}); let p=await ctx.newPage();
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4500);
 await p.evaluate(()=>window.dispatchEvent(new Event('credence:open-feedback'))); await p.waitForTimeout(800);
 await p.locator('textarea').first().click();   // focus in the text box, like a real user
 const pasteImg=(big)=>p.evaluate(async(big)=>{
   const c=document.createElement('canvas'); const n=big?2600:200; c.width=n;c.height=n; const x=c.getContext('2d');
   if(big){const im=x.createImageData(n,n); for(let i=0;i<im.data.length;i++) im.data[i]=(i%4===3)?255:Math.floor(Math.random()*256); x.putImageData(im,0,0);} else {x.fillStyle='#2563eb';x.fillRect(0,0,n,n);}
   const blob=await new Promise(r=>c.toBlob(r,'image/png')); const f=new File([blob],'image.png',{type:'image/png'});
   const dt=new DataTransfer(); dt.items.add(f);
   const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});
   (document.activeElement||document.body).dispatchEvent(ev); return {size:blob.size,prevented:ev.defaultPrevented};
 },big);
 let r=await pasteImg(false); await p.waitForTimeout(600);
 ok(r.prevented,'image paste is taken (not typed as text)');
 ok(await p.locator('img[alt="Screenshot"]').count()===1,'pasted image shows as the screenshot');
 await p.screenshot({path:D+'/paste-small.png'});
 await p.getByRole('button',{name:'Remove screenshot'}).click(); await p.waitForTimeout(300);
 // text paste still works
 await p.locator('textarea').first().fill(''); 
 const textPrevented=await p.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','hello');const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.querySelector('textarea').dispatchEvent(ev);return ev.defaultPrevented;});
 ok(!textPrevented,'pasting plain text is left alone');
 // focus NOT in a field
 await p.evaluate(()=>document.activeElement&&document.activeElement.blur()); r=await pasteImg(false); await p.waitForTimeout(600);
 ok(await p.locator('img[alt="Screenshot"]').count()===1,'paste works with focus outside the text box too');
 await p.getByRole('button',{name:'Remove screenshot'}).click(); await p.waitForTimeout(300);
 r=await pasteImg(true); await p.waitForTimeout(2500);
 console.log('   big image bytes:',r.size);
 ok(r.size>3*1024*1024,'test image really is over 3 MB');
 ok(await p.locator('img[alt="Screenshot"]').count()===1,'a pasted image over 3 MB is shrunk and accepted (no "under 3 MB" error)');
 await p.locator('textarea').first().fill('QA fb pasted screenshot'); 
 await p.getByRole('button',{name:'General'}).click();
 await p.getByRole('button',{name:'Send',exact:true}).click(); await p.waitForTimeout(2500);
 ok(/Your feedback reached the team/.test(await p.locator('body').innerText()),'feedback with the pasted screenshot is sent');
 await ctx.close();
 // ---- 2. admin page
 ctx=await mk('admin@credence.test',{width:1440,height:1000}); p=await ctx.newPage();
 await p.goto(B+'/admin/user-feedback',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 let t=await p.locator('body').innerText();
 ok(/Pending\s*\n?\s*\d+/.test(t)||/PENDING/i.test(t),'status chips are there');
 ok(/Longest waiting/i.test(t),'"Longest waiting" shown');
 ok(/Pending · /.test(t),'each pending row shows how long it has been pending');
 ok(await p.getByRole('button',{name:'Mark done'}).count()>0,'Mark done button is there');
 await p.screenshot({path:D+'/admin-list.png',fullPage:false});
 await p.getByRole('button',{name:'Mark done'}).first().click(); await p.waitForTimeout(700);
 await p.locator('#fb-done-note').fill('QA fb handled in the next update');
 await p.screenshot({path:D+'/admin-popup.png'});
 await p.getByRole('button',{name:'Mark done'}).last().click(); await p.waitForTimeout(2000);
 t=await p.locator('body').innerText(); ok(/Done · took/.test(t),'row shows "Done · took …" after marking');
 ok(/QA fb handled in the next update/.test(t),'the note shows on the row');
 await p.getByRole('button',{name:/^Done\s*\d*$/}).first().click(); await p.waitForTimeout(1500);
 ok(await p.getByRole('button',{name:'Reopen'}).count()>0,'Done filter shows Reopen');
 await p.screenshot({path:D+'/admin-done.png'});
 await p.getByRole('button',{name:'Reopen'}).first().click(); await p.waitForTimeout(700);
 await p.getByRole('button',{name:'Reopen',exact:true}).last().click(); await p.waitForTimeout(1800);
 await ctx.close();
 // phone
 ctx=await mk('admin@credence.test',{width:390,height:844}); p=await ctx.newPage();
 await p.goto(B+'/admin/user-feedback',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 const ov=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1); ok(!ov,'phone: page does not scroll sideways');
 await p.screenshot({path:D+'/admin-phone.png'});
 console.log(`${pass}/${pass+fail}`); await b.close();
})();
