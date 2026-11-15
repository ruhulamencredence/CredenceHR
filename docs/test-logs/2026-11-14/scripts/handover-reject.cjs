// Reject on the hand-over Layers: Asset Fulfiller and Vehicle Maintainer.
// Templates whose only Layer is that type (approver = the Superadmin), one
// request each, rejected from Approve Applications and from the Dashboard's
// Approve Application page (not the Dashboard card, by request); reason
// required; employee-facing status = rejected. Names carry a run tag.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const B='http://localhost:3200', D=process.argv[2];
const RUN=Date.now().toString(36).slice(-4);
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const a=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 const H={Authorization:'Bearer '+a.token,'content-type':'application/json'}; const me=a.user.id;
 const api=async(m,u,b)=>{const r=await fetch(B+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)console.log('  ',m,u,r.status,JSON.stringify(j).slice(0,200));return j;};
 for(const [rt,type] of [['asset','asset_fulfiller'],['vehicle','vehicle_maintainer']])
   await api('POST','/api/approval-templates',{name:`QA hr ${rt} handover`,request_type:rt,is_default:true,skip_auto_supervisor:true,steps:[{approver_user_ids:[me],approver_type:type}]});
 const d=new Date(Date.now()+2*86400000); const ds=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const mkAsset=(n)=>api('POST','/api/assets/requisitions',{items:[{item_name:n,purpose:'QA hr',unit:'pcs',quantity:1}],urgency:'medium',target_date:ds});
 const mkRide=(dst)=>api('POST','/api/vehicles/requisitions',{purpose:'QA hr',pickup_location:'Head Office',destination:dst,ride_date:ds,start_time:'10:00',estimated_duration_hours:1});
 await mkAsset(`QA hr Monitor A ${RUN}`); await mkRide(`QA hr Uttara A ${RUN}`); 
 const mine=await api('GET','/api/my-approvals');
 const list=Array.isArray(mine)?mine:(mine.items||[]);
 ok(list.filter(i=>i.asset_fulfiller_bypass).length>=1,'asset requests are on the Asset Fulfiller Layer');
 ok(list.filter(i=>i.vehicle_maintainer_bypass).length>=1,'ride requests are on the Vehicle Maintainer Layer');
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:1000}});
 await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));for(let i=0;i<600;i++)localStorage.setItem(`credence_webpush_snooze_${i}`,String(Date.now()+9e9));localStorage.setItem('chr_feedback_snooze',String(Date.now()+9e9));},[a.token,a.user]);
 const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 // The smallest box holding this text and exactly one Reject button.
 let qn=0;
 const cardOf=async(txt)=>{const id='qa'+(++qn);const found=await p.evaluate(([txt,id])=>{
   const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){if(!n.textContent.includes(txt))continue;
     for(let el=n.parentElement;el&&el!==document.body;el=el.parentElement){const r=[...el.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Reject');
       if(r.length===1&&el.querySelector('[aria-label="Reason for rejecting"]')){el.setAttribute('data-qa',id);return true;} if(r.length>1)break;}}
   return false;},[txt,id]); return found?p.locator(`[data-qa="${id}"]`):p.locator('[data-qa="none"]');};
 // ---- Approve Applications page
 await p.goto(B+'/self/approve-applications',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 await p.screenshot({path:D+'/hr-page.png',fullPage:true});
 for(const [txt,kind] of [[`QA hr Monitor A ${RUN}`,'asset'],[`QA hr Uttara A ${RUN}`,'ride']]){
   let c=await cardOf(txt); if(!(await c.count())){ await p.getByText(txt).first().click().catch(()=>{}); await p.waitForTimeout(600); c=await cardOf(txt); }
   ok(await c.count()>0,`Approve Applications: ${kind} card has a Reject button`);
   if(!(await c.count())) continue;
   await c.getByRole('button',{name:'Reject'}).click(); await p.waitForTimeout(600);
   ok(/Write why you are rejecting/.test(await p.locator('body').innerText()),`${kind}: Reject without a reason is refused with a message`);
   await c.getByLabel('Reason for rejecting').fill(kind==='asset'?'QA hr not in stock':'QA hr no vehicle free');
   await c.getByRole('button',{name:'Reject'}).click(); await p.waitForTimeout(700);
   await p.screenshot({path:D+`/hr-confirm-${kind}.png`});
   await p.locator('.liquid-glass').getByRole('button',{name:/Reject|OK|Yes|Confirm/}).last().click(); await p.waitForTimeout(2000);
   ok(/Rejected\./.test(await p.locator('body').innerText()),`${kind}: "Rejected." shown`);
 }
 // ---- the Dashboard card keeps only its own buttons (no Reject added there)
 await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
 await p.locator('aside.gsidebar').nth(1).getByText('Dashboard',{exact:true}).first().click(); await p.waitForTimeout(3000);
 ok(/Pending Approvals/.test(await p.locator('body').innerText()),'on the Dashboard (Pending Approvals card showing)');
 ok(await p.locator('[aria-label="Reason for rejecting"]').count()===0,'Dashboard: the Pending Approvals card shows no Reject box (left as it was)');
 await p.screenshot({path:D+'/hr-dash.png'});
 // ---- the employee's side
 const assets=await api('GET','/api/assets/requisitions/my');
 const rides=await api('GET','/api/vehicles/requisitions');
 const st=(arr,f)=>(arr.find(f)||{}).status;
 for(const n of [`QA hr Monitor A ${RUN}`]) ok(st(assets,r=>JSON.stringify(r).includes(n))==='rejected',`${n}: requisition status is rejected`);
 for(const n of [`QA hr Uttara A ${RUN}`]) ok(st(rides,r=>r.destination===n)==='rejected',`${n}: ride status is rejected`);
 const left=await api('GET','/api/my-approvals'); const l2=Array.isArray(left)?left:(left.items||[]);
 ok(!l2.some(i=>JSON.stringify(i).includes(RUN)),'nothing from this run left waiting');
 console.log('errors:',errs.slice(0,3)); console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})();
