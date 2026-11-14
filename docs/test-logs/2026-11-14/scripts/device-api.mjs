import { execSync } from 'child_process';
const B='http://localhost:3200', PHASE=process.argv[2]||'a';
const sql=(q)=>execSync(`mysql -N -ucred -pcredpass admin_ui -e "${q.replace(/"/g,'\\"')}"`).toString().trim();
const UA={
  iphone:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadmac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  pc:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  apk:'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36'
};
const call=async(t,m,u,b,ua)=>{const r=await fetch(B+u,{method:m,headers:{...(t?{authorization:'Bearer '+t}:{}),'content-type':'application/json','user-agent':ua||UA.pc},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const login=async(email,ua,extra={})=>(await call(null,'POST','/api/auth/login',{email,password:'ProbePass123',workspace:'credence',...extra},ua)).j;
const jwt=(t)=>JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString());
let pass=0,fail=0;const ok=(m,c)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const T=execSync("TZ=Asia/Dhaka date +%F").toString().trim();
const reset=()=>{sql(`DELETE FROM attendance WHERE user_id=132 AND attendance_date='${T}'`); sql(`DELETE FROM zk_attendance_logs WHERE device_user_pin='102' AND DATE(punch_time)='${T}'`);};
const ci=(t,ua,extra={})=>call(t,'POST','/api/attendance/check-in',{project_id:1,latitude:23.7806,longitude:90.4074,...extra},ua);
if (PHASE==='a' || PHASE==='c') {
  // ---------- 1. Home Screen sign-in ----------
  let L=await login('tanvir.r@credence.test',UA.iphone,{platform:'pwa'}); let p=jwt(L.token);
  ok('iPhone Home Screen sign-in is a "pwa" sign-in', p.cl==='pwa');
  ok('...that lasts 30 days', Math.round((p.exp-p.iat)/86400)===30);
  let sp=(await call(L.token,'GET','/api/session-policy',null,UA.iphone)).j; ok('page is told: client pwa, no minutes-idle sign-out', sp.client==='pwa' && sp.idle_minutes===0);
  L=await login('tanvir.r@credence.test',UA.ipadmac,{platform:'pwa',touch_device:true}); ok('iPad (Safari says Mac, touch screen) Home Screen -> pwa', jwt(L.token).cl==='pwa');
  L=await login('tanvir.r@credence.test',UA.pc,{platform:'pwa'}); p=jwt(L.token); ok('a computer claiming Home Screen stays a website (12 h)', p.cl==='web' && Math.round((p.exp-p.iat)/3600)===12);
  L=await login('tanvir.r@credence.test',UA.ipadmac,{platform:'pwa'}); ok('a Mac (no touch) claiming Home Screen stays a website', jwt(L.token).cl==='web');
  L=await login('tanvir.r@credence.test',UA.iphone); p=jwt(L.token); ok('iPhone Safari in a normal tab is still a website (12 h, 60-min idle)', p.cl==='web' && Math.round((p.exp-p.iat)/3600)===12 && (await call(L.token,'GET','/api/session-policy',null,UA.iphone)).j.idle_minutes===60);
  // policy fields
  const sa=(await login('admin@credence.test',UA.pc)).token;
  let g=(await call(sa,'GET','/api/session-policy')).j; ok('Superadmin sees Home Screen 30 / 7 in Session security', g.policy.pwa_days===30 && g.policy.pwa_idle_days===7);
  ok('Superadmin changes Home Screen to 20 / 5', (await call(sa,'PUT','/api/session-policy',{...g.policy,pwa_days:20,pwa_idle_days:5})).s===200);
  g=(await call(sa,'GET','/api/session-policy')).j; ok('...saved', g.policy.pwa_days===20 && g.policy.pwa_idle_days===5);
  const {pwa_days,pwa_idle_days,...older}=g.policy;
  ok('an older page saving without the Home Screen fields keeps them', (await call(sa,'PUT','/api/session-policy',older)).s===200 && (await call(sa,'GET','/api/session-policy')).j.policy.pwa_days===20);
  ok('out of range refused', (await call(sa,'PUT','/api/session-policy',{...g.policy,pwa_days:31})).s===400);
  ok('back to 30 / 7', (await call(sa,'PUT','/api/session-policy',{...g.policy,pwa_days:30,pwa_idle_days:7})).s===200);
  // idle: set up two sign-ins for phase b
  const pwa=(await login('tanvir.r@credence.test',UA.iphone,{platform:'pwa'})).token, pwa2=(await login('tanvir.r@credence.test',UA.iphone,{platform:'pwa'})).token, web=(await login('tanvir.r@credence.test',UA.iphone)).token;
  for (const t of [pwa,pwa2,web]) await call(t,'GET','/api/attendance/day-status',null,UA.iphone);
  await new Promise(r=>setTimeout(r,1500));
  const fs=await import('fs'); fs.writeFileSync('/tmp/claude-0/-home-user-CredenceHR/4c3c70ac-a915-58a3-a2e8-a2cf21d5869c/scratchpad/dev/tok.json',JSON.stringify({pwa,pwa2,web}));
  // ---------- 2. Attendance by device ----------
  sql('UPDATE users SET can_use_attendance=1 WHERE id=132'); sql('INSERT IGNORE INTO user_attendance_projects (user_id, project_id) VALUES (132,1)');
  const tv=(ua,extra)=>login('tanvir.r@credence.test',ua,extra).then(x=>x.token);
  reset(); let r=await ci(await tv(UA.android),UA.android); ok('Android browser: Check In refused, told to use the app ('+r.s+')', r.s===403 && r.j.code==='ATTENDANCE_APP_ONLY' && /app/.test(r.j.error));
  r=await call(await tv(UA.android),'POST','/api/attendance/check-out',{project_id:1,latitude:23.7806,longitude:90.4074},UA.android); ok('Android browser: Check Out refused too', r.s===403);
  r=await ci(await tv(UA.android),UA.android,{offsite:true,remarks:'x'}); ok('Android browser: off-site punch refused too', r.s===403);
  r=await ci(await tv(UA.pc),UA.pc); ok('computer: refused ('+r.j.code+')', r.s===403 && r.j.code==='ATTENDANCE_NOT_ON_COMPUTER');
  r=await ci(await tv(UA.ipadmac),UA.ipadmac); ok('Mac (no touch): refused as a computer', r.s===403);
  reset(); r=await ci(await tv(UA.ipadmac),UA.ipadmac,{touch_device:true}); ok('iPad (Safari says Mac + touch): Check In works ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200);
  reset(); r=await ci(await tv(UA.iphone),UA.iphone); ok('iPhone Safari: Check In works ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200);
  reset(); r=await ci(await tv(UA.iphone,{platform:'pwa'}),UA.iphone); ok('iPhone Home Screen: Check In works', r.s===200);
  r=await call(await tv(UA.iphone),'POST','/api/attendance/check-out',{project_id:1,latitude:23.7806,longitude:90.4074},UA.iphone); ok('iPhone: Check Out works ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200);
  // the app (APK): device sign-in
  sql("DELETE FROM user_devices WHERE user_id=132");
  const app=await login('tanvir.r@credence.test',UA.apk,{platform:'app',latitude:23.7806,longitude:90.4074,device_id:'qa-dev-1',device_name:'Pixel 8'});
  if (app.token) { reset(); r=await ci(app.token,UA.apk); ok('Android app (APK): Check In works ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200); }
  else console.log('   (app sign-in not possible here: '+JSON.stringify(app).slice(0,120)+')');
  // a correction from the Timesheet is still allowed from a computer
  const yd=execSync("TZ=Asia/Dhaka date -d '3 days ago' +%F").toString().trim();
  sql(`DELETE FROM attendance_corrections WHERE user_id=132 AND attendance_date='${yd}'`);
  r=await call(await tv(UA.pc),'POST','/api/attendance/corrections',{project_id:1,attendance_date:yd,check_in_at:`${yd}T09:00`,check_out_at:`${yd}T18:00`,remarks:'QA forgot'},UA.pc);
  ok('computer: Correct Attendance (for approval) still works ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200||r.s===201);
  reset();
}
if (PHASE==='b') {
  // after a restart, with last-seen moved back
  const {pwa,pwa2,web}=JSON.parse((await import('fs')).readFileSync('/tmp/claude-0/-home-user-CredenceHR/4c3c70ac-a915-58a3-a2e8-a2cf21d5869c/scratchpad/dev/tok.json'));
  ok('Home Screen unused 6 days: still signed in', (await call(pwa2,'GET','/api/attendance/day-status',null,UA.iphone)).s===200);
  let r=await call(pwa,'GET','/api/attendance/day-status',null,UA.iphone); ok('Home Screen unused 8 days: signed out ('+r.s+')', r.s===401);
  r=await call(web,'GET','/api/attendance/day-status',null,UA.iphone); ok('website unused 2 hours: signed out, as before ('+r.s+')', r.s===401);
}
console.log(`${pass}/${pass+fail}`);
