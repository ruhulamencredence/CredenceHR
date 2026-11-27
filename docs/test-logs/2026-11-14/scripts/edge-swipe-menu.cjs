// Phone: drag from the left edge opens the side menu; drag back closes it;
// a short drag springs back; a vertical move still scrolls; not from mid-screen.
const { chromium, devices } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2], WHO=process.argv[3]||'admin@credence.test';
const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
(async()=>{
 const b=await chromium.launch(); let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await login(WHO);
 const ctx=await b.newContext({...devices['Pixel 7']});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem('credence_workspace',JSON.stringify({id:1,code:'credence',name:'Credence Group',short_name:'Credence'}));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 const cdp=await ctx.newCDPSession(p);
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
 const drag=async(x0,y0,x1,y1,steps=12,ms=16,hold)=>{await touch('touchStart',x0,y0);for(let i=1;i<=steps;i++){await touch('touchMove',x0+(x1-x0)*i/steps,y0+(y1-y0)*i/steps);await p.waitForTimeout(ms);} if(hold) await hold(); await touch('touchEnd');await p.waitForTimeout(500);};
 const drawerX=()=>p.evaluate(()=>{const el=[...document.querySelectorAll('aside.gsidebar')].find(e=>getComputedStyle(e).position==='fixed');return el?el.getBoundingClientRect().left:null;});
 const isOpen=async()=>(await drawerX())>-5;
 ok(!(await isOpen()),'menu starts closed');
 // follows the finger mid-drag
 let mid=null; await drag(8,400,140,405,12,16,async()=>{mid=await drawerX();});
 ok(mid!==null&&mid<-20&&mid>-200,`menu follows the finger while dragging (left edge at ${Math.round(mid)}px)`);
 ok(await isOpen(),'drag from the left edge to the right opens the menu');
 await p.screenshot({path:D+'/edge-open.png'});
 await drag(240,400,30,405);
 ok(!(await isOpen()),'dragging the menu back to the left closes it');
 await drag(10,400,50,402,6,40);
 ok(!(await isOpen()),'a short, slow drag springs back (stays closed)');
 // A real flick: touch events made in the page ~8 ms apart (CDP is too slow for this).
 await p.evaluate(async()=>{const t=document.elementFromPoint(10,400);const mk=(type,x)=>{const tc=x==null?[]:[new Touch({identifier:1,target:t,clientX:x,clientY:400})];t.dispatchEvent(new TouchEvent(type,{touches:tc,changedTouches:tc.length?tc:[new Touch({identifier:1,target:t,clientX:60,clientY:400})],bubbles:true,cancelable:true}));};
   mk('touchstart',10);for(const x of [27,44,60]){await new Promise(r=>setTimeout(r,8));mk('touchmove',x);}await new Promise(r=>setTimeout(r,8));mk('touchend',null);});
 await p.waitForTimeout(500);
 ok(await isOpen(),'a quick flick from the edge opens it (only 50 px)');
 await p.mouse.click(380,400); await p.waitForTimeout(500);
 ok(!(await isOpen()),'tapping the dim area still closes it');
 // Home screen (Dashboard): from anywhere
 await drag(150,400,400,405);
 ok(await isOpen(),'Dashboard: a swipe right from the middle of the screen opens it');
 await drag(240,400,30,405);
 ok(!(await isOpen()),'…and swiping it left closes it');
 const cal=await p.evaluate(()=>{const el=document.querySelector('[data-no-edge-swipe]');if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
 if(cal){ await p.waitForTimeout(400); const c=await p.evaluate(()=>{const r=document.querySelector('[data-no-edge-swipe]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}); await drag(c.x-80,c.y,c.x+120,c.y+3); ok(!(await isOpen()),'Dashboard: a swipe on the holiday calendar (its own month swipe) does not open it'); }
 else console.log('   (holiday calendar not on this Dashboard)');
 await p.evaluate(()=>window.scrollTo(0,0)); await p.waitForTimeout(300);
 const y0=await p.evaluate(()=>window.scrollY||document.scrollingElement.scrollTop);
 await drag(10,600,30,200,10,16);
 const y1=await p.evaluate(()=>window.scrollY||document.scrollingElement.scrollTop);
 ok(!(await isOpen()),'an up/down move from the edge does not open it');
 console.log('   scroll',y0,'->',y1);
 // a popup open: no swipe
 await p.evaluate(()=>window.dispatchEvent(new Event('credence:open-feedback'))); await p.waitForTimeout(800);
 const hasPopup=await p.evaluate(()=>!!document.querySelector('.liquid-glass-backdrop,[role="dialog"][aria-modal="true"]'));
 if(hasPopup){ await drag(8,400,240,405); ok(!(await isOpen()),'with a popup open the swipe does nothing'); }
 else console.log('   (no popup to try)');
 // Another page: only from the edge
 await p.keyboard.press('Escape'); await p.waitForTimeout(500);
 await p.goto(B+'/self/employee-directory',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4000);
 const notHome=await p.evaluate(()=>location.pathname); console.log('   other page:',notHome);
 await drag(150,400,400,405);
 ok(!(await isOpen()),'another page: a swipe from mid-screen does not open it');
 await drag(8,400,240,405);
 ok(await isOpen(),'another page: from the left edge still opens it');
 // computer width: nothing
 await p.setViewportSize({width:1280,height:800}); await p.waitForTimeout(800);
 await p.keyboard.press('Escape');
 console.log('errors:',errs.slice(0,3)); ok(errs.length===0,'no page errors');
 console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
