// Tracking Schedule covers the Superadmin too: listed, settable (by a
// Superadmin only), and their phone's pings outside it are not stored.
const B='http://localhost:3200';
(async()=>{
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const login=async(e)=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
 const a=await login('admin@credence.test'); const H={Authorization:'Bearer '+a.token,'content-type':'application/json'};
 const go=async(m,u,b,h=H)=>{const r=await fetch(B+u,{method:m,headers:h,body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>null)};};
 let l=await go('GET','/api/tracking/schedules'); const rows=(l.j?.people||[]);
 const list=Array.isArray(rows)?rows:Object.values(rows);
 const me=list.find(r=>Number(r.user_id)===Number(a.user.id));
 ok(!!me,`the Superadmin (${a.user.name}) is in the Tracking Schedule list (${l.s})`);
 ok(me&&me.tracking_enabled===true,'shown with tracking on (a Superadmin always has it)');
 // a window that is closed right now: a fixed schedule on a day that isn't today
 const dow=new Date().getDay(); const other=[0,1,2,3,4,5,6].filter(d=>d!==dow).slice(0,1);
 const r=await go('PUT','/api/tracking/schedules',{user_ids:[a.user.id],mode:'fixed',days:other,start_time:'09:00',end_time:'10:00'});
 ok(r.s===200&&r.j.changed===1&&!r.j.skipped,`a schedule can be saved for the Superadmin (${JSON.stringify(r.j)})`);
 const p=await go('POST','/api/tracking/ping',{lat:23.78,lng:90.41,accuracy_m:10});
 ok(p.s===200&&p.j.off_schedule===true,`outside the schedule the Superadmin's ping is not stored (${JSON.stringify(p.j)})`);
 const back=await go('PUT','/api/tracking/schedules',{user_ids:[a.user.id],mode:'always'});
 ok(back.s===200&&back.j.changed===1,'set back to Always');
 const p2=await go('POST','/api/tracking/ping',{lat:23.78,lng:90.41,accuracy_m:10});
 ok(p2.s===200&&!p2.j.off_schedule,'with Always the ping is stored again');
 console.log(`\n${pass} passed, ${fail} failed`);
})();
// A non-Superadmin Tracking manager (qa.claimant made admin + Tracking module
// for this check): the Superadmin is neither listed nor changed.
(async()=>{
 await new Promise(r=>setTimeout(r,1500));
 let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
 const m=await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'qa.claimant@credence.test',password:'ProbePass123',workspace:'credence'})})).json();
 if(!m.token){console.log('   (no tracking manager login)');return;}
 const H={Authorization:'Bearer '+m.token,'content-type':'application/json'};
 const l=await (await fetch(B+'/api/tracking/schedules',{headers:H})).json();
 ok(Array.isArray(l.people)&&!l.people.some(p=>p.user_id===1),'manager: the Superadmin is not in their list');
 const r=await (await fetch(B+'/api/tracking/schedules',{method:'PUT',headers:H,body:JSON.stringify({user_ids:[1],mode:'fixed',days:[1],start_time:'09:00',end_time:'10:00'})})).json();
 ok(r.changed===0&&r.skipped===1,`manager: can't change the Superadmin's schedule (${JSON.stringify(r)})`);
 console.log(`\n${pass} passed, ${fail} failed`);
})();
